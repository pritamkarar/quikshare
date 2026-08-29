import type { FileMeta, MediaControl, SaveCapability } from '../../shared/messages.js';
import type { Transport } from '../transport/types.js';
import { parseDeviceInfo, type DeviceInfo } from '../../shared/device.js';
import { parseMediaAnswer, parseMediaIce, parseMediaOffer } from '../../shared/media-signal.js';
import type { SaveSink } from '../save/types.js';
import { createBlobSink } from '../save/blob.js';
import { capacityRejection, type SinkFactory } from '../save/select.js';
import { FrameType, decodeControl, decodeFrame } from '../protocol.js';
import { makeNonce, open } from '../crypto.js';
import { dataAad } from './data-aad.js';

export interface ReceiverEvents {
  onOffer(files: FileMeta[]): void;
  onProgress(p: { fileId: number; bytesReceived: number; totalBytes: number }): void;
  onFileComplete(r: { meta: FileMeta; blob?: Blob }): void;
  /**
   * This incoming file stopped early because it was cancelled — by this
   * device's user, or by the peer that was sending it.
   *
   * Not routed through `onError`: a cancellation is the user getting what
   * they asked for, and rendering it as a red alert would treat a deliberate
   * act as a failure. Optional, like the callbacks below it, so a caller
   * with no cancel UI is unaffected.
   */
  onFileCancelled?(fileId: number): void;
  onText(content: string): void;
  onError(e: { fileId?: number; message: string }): void;
  /**
   * The peer just told us how many bytes of `fileId` it already has (sent
   * after its own reconnect) — a request aimed at *our* Sender, not this
   * Receiver. Optional so existing callers that never send this side of a
   * transfer are unaffected. Session is the only wiring point: it owns both
   * the Sender and the queued-File map resumeFile needs.
   */
  onResumeFrom?(fileId: number, bytesReceived: number): void;
  /**
   * The peer confirmed it has a file this device SENT, whole — a request
   * aimed at our Sender, like `onResumeFrom` above, not at this Receiver.
   * Wholly unvalidated: the id comes straight off the wire. Session is the
   * only wiring point, since only it holds the Sender the ack is about.
   */
  onFileAck?(fileId: unknown): void;
  /**
   * The peer cancelled something. Both halves are aimed at Session: `side`
   * says whether these are the peer's own files (stop expecting them) or
   * this device's (stop sending them) — see the `cancel` frame in
   * shared/messages.ts. Wholly unvalidated at this point.
   */
  onCancel?(side: unknown, fileIds: unknown): void;
  /**
   * The peer described itself. Already sanitised (`parseDeviceInfo`) by the
   * time it reaches here, so a listener may render every field as text
   * without further checking. Optional, like `onResumeFrom`, so a caller
   * that has no device panel is unaffected.
   */
  onPeerDevice?(info: DeviceInfo): void;
  /**
   * The peer's user confirmed the verification number matches theirs. Only
   * ever fires for a frame that passed AEAD under the derived key, so the
   * relay cannot manufacture it. Optional, like the callbacks around it.
   */
  onPeerVerified?(): void;
  /**
   * The peer said it is leaving on purpose (shared/messages.ts's
   * `end-session`). Distinct from the socket simply dropping, which this
   * layer never sees at all.
   */
  onPeerEnded?(): void;
  /**
   * One of the four `media-*` control frames (shared/messages.ts), already
   * whitelisted by `parseMediaOffer`/`parseMediaAnswer`/`parseMediaIce` — see
   * the `media-offer`/`media-answer`/`media-ice` cases in `#handleControl`
   * below. `media-stop` carries no payload, so it needs no parser and
   * reaches here unchanged.
   *
   * This is the **only** place a peer-supplied media signal is validated.
   * Session, the worker bridge, and the `MediaPeer` a later task builds all
   * receive already-checked `MediaControl` values through this callback and
   * must not re-parse: a second whitelist is how one drifts out of step
   * with the other. Optional, like `onResumeFrom`/`onPeerDevice`, so a
   * caller with no live-media feature is unaffected.
   */
  onMediaSignal?(signal: MediaControl): void;
}

export interface ReceiverOptions {
  transport: Transport;
  key: CryptoKey;
  peerId: 'a' | 'b';
  remoteNoncePrefix: Uint8Array;
  /**
   * May be async: the File System Access sink opens a Save-As dialog and the
   * Service Worker sink waits for the download to start before it accepts a
   * byte. Called once per file, on that file's first chunk.
   */
  createSink?: SinkFactory;
  /**
   * The tier `createSink` builds for. Only its size ceiling is read here, at
   * offer time, where no sink exists yet. Defaults to 'blob', which is what
   * the default factory builds.
   */
  saveCapability?: SaveCapability;
  events: ReceiverEvents;
}

interface Incoming {
  meta: FileMeta;
  /**
   * Built on this file's first chunk and undefined until then. Not at offer
   * time: a batch of N files would open N Save-As dialogs or N browser
   * downloads before a single byte arrived, and it would do so inside the
   * chain that serializes every frame — one unresponsive download helper
   * would block all control and text frames for its full start timeout, times
   * N. A zero-byte file has no chunk to build on, so `file-end` builds it.
   */
  sink: SaveSink | undefined;
  bytesReceived: number;
  /**
   * The seq of the last chunk accepted for this file. Chunks must arrive
   * strictly increasing: authenticating the header stops a chunk being
   * rewritten, but a *genuine* frame replayed or reordered still verifies
   * wherever it lands, so only this catches duplication and reordering.
   * Starts below every valid u64 seq so the first chunk is always accepted.
   */
  lastSeq: bigint;
  failed: boolean;
}

/** Below any seq that can appear on the wire, which is an unsigned 64-bit value. */
const NO_SEQ_YET = -1n;

export class Receiver {
  readonly #opts: ReceiverOptions;
  readonly #incoming = new Map<number, Incoming>();
  /**
   * Files cancelled on this side, by fileId. Kept after the `#incoming`
   * entry is gone, and never emptied for the life of this Receiver.
   *
   * A cancel takes effect here immediately rather than waiting for the peer
   * to acknowledge it — the user asked for it to stop, and the partial file
   * is discarded either way — so chunks already in flight keep arriving for
   * a moment afterwards. Without this set they would find no `#incoming`
   * entry and raise "Received data for a file that was never offered" once
   * per chunk, turning a deliberate cancel into a burst of red alerts.
   */
  readonly #cancelled = new Set<number>();
  /** The remote peer is whichever side this one is not. */
  readonly #remotePeerId: 'a' | 'b';
  /** Serializes decryption so chunks land in the sink in arrival order. */
  #chain: Promise<void> = Promise.resolve();
  /**
   * Set once by `abortAll`, never cleared: the Session drops this Receiver at
   * the same moment. Every continuation that resumes after an await re-checks
   * it, because `abortAll` is synchronous and can land in any of those gaps —
   * and a sink built or written after it belongs to nothing.
   */
  #aborted = false;
  /**
   * fix-round-2: control frames got an AEAD check but no replay/reorder
   * protection at all — a relay replaying a verbatim `offer-batch` mid-
   * transfer could reset a file's bookkeeping (bytesReceived back to 0,
   * orphaning its live sink), and nothing stopped a replayed `text` from
   * duplicating a snippet either. Mirrors `Incoming.lastSeq`'s same check
   * for data frames, but tracked once per Receiver rather than per file:
   * control frames aren't tied to one file's `Incoming` entry the way data
   * frames are.
   */
  #lastControlSeq = NO_SEQ_YET;
  /**
   * Files that arrived here whole, by the sender's own fileId.
   *
   * Kept after `#incoming` drops them, for one job: a resync re-acknowledges
   * every one of these (Session's `#resyncReceiveState`). An ack is a
   * control frame like any other, so it can be lost with the transport that
   * carried it — and once this Receiver has completed a file there is
   * nothing left in `#incoming` to produce a resume point for it either, so
   * without this the peer's row would sit at 100% for the rest of the
   * session with nothing able to finish it. One number per completed file,
   * which is the same per-session growth the rest of this class already has.
   */
  readonly #completed = new Set<number>();
  /**
   * Whether the rejection above has already been reported to the user. The
   * check itself is per frame and stays that way — every replayed control
   * frame must still be discarded — but the *message* is once per Receiver:
   * a relay replaying a captured frame in a loop would otherwise drive
   * onError at whatever rate the socket allows and pin an error banner on
   * screen for the rest of the session. One report is all the information
   * there is; the thousandth adds nothing. Mirrors the same
   * report-once-per-episode shape Session already uses for its deferred-frame
   * overflow (see #deferredOverflowReported in client/session.ts).
   */
  #replayedControlReported = false;

  constructor(opts: ReceiverOptions) {
    this.#opts = opts;
    this.#remotePeerId = opts.peerId === 'a' ? 'b' : 'a';
  }

  /**
   * The prefix this Receiver validates incoming frames against. Session
   * compares it to a later hello's prefix as a *heuristic* for whether that
   * hello is the same peer reconnecting or a different one taking the
   * room's free slot — not a trust decision. The prefix travels in the
   * clear in every hello (protocol.ts), so it proves nothing about who sent
   * it: a peer (malicious or buggy) can claim any prefix it likes. Both
   * outcomes of the heuristic being wrong only cost availability, never
   * security — a wrongly-"same-peer" match still has to pass this file's
   * AEAD check before a single byte is accepted, and a wrongly-"different
   * peer" mismatch just discards resumable progress that was actually
   * fine. See the hello handling in session.ts.
   */
  get remoteNoncePrefix(): Uint8Array {
    return this.#opts.remoteNoncePrefix;
  }

  /**
   * What each in-flight file still needs, for a resume-from after reconnect.
   * bytesReceived is trustworthy as a resume point even though it is "only"
   * a count: fix-round-2 binds the byte offset into each data frame's AEAD
   * additional data (see data-aad.ts), so a chunk sealed for one offset
   * cannot be opened against another. A resume from a stale or wrong
   * bytesReceived simply fails to open at the very next chunk rather than
   * silently splicing bytes into the wrong position — so, unlike the
   * fix-round-1 attempt at this (a `sawGap` flag inferred from seq
   * contiguity, since deleted), there is no reason to withhold a file from
   * this list, ever: it can be resumed any number of times.
   *
   * fix-round-3 (Important): queued behind `#chain` rather than reading
   * `entry.bytesReceived` synchronously. `#chain` serializes every
   * arriving frame's decryption-through-write, so a burst of frames still
   * queued at the moment of a disconnect would otherwise let this read run
   * *before* they finish landing — publishing a resume point behind where
   * the receiver is about to end up. The peer would then resend starting
   * from that stale offset, and the resumed chunk's AAD (sealed for the
   * receiver's true, further-along offset) would fail to open — failing an
   * otherwise-healthy file on a legitimate reconnect. `#chain` never
   * rejects (`start()` catches everything onto the same promise it assigns
   * to `#chain`), so chaining onto it here can't turn a healthy Receiver
   * into a permanently-rejecting one.
   *
   * Do not call this from inside a `ReceiverEvents` callback: those run
   * *from within* `#chain` itself (each is invoked by `#handle`, which is
   * what `#chain` is a chain of), so awaiting this method there would wait
   * on `#chain` to finish a step it cannot finish until that very await
   * returns — a permanent deadlock, not merely a delay. `Session`'s two
   * current call sites (both via `#sendResumePoints`) are safe: one runs
   * from `#route`, the transport's own hello dispatcher, which *feeds*
   * frames into `#chain` rather than running inside one of its links; the
   * other runs from `#resumeAfterReconnect`, a reconnect lifecycle
   * callback, not a `ReceiverEvents` callback either. Neither is invoked
   * *by* `#handle`.
   */
  /**
   * Stops these incoming files: the partial bytes are discarded and the
   * entry is forgotten, so nothing further is written and no completion can
   * be reported for them.
   *
   * `sink.abort` rather than `sink.close`, deliberately — the same path a
   * failed integrity check takes. A closed sink leaves a truncated file on
   * disk with a real name and no indication it is a fragment, which is the
   * one outcome a cancel must not produce.
   *
   * Telling the peer is Session's job. This method is also what runs when
   * the news arrives FROM the peer, so echoing a frame from here would send
   * a cancel straight back at whoever just cancelled.
   */
  async cancelIncoming(fileIds: Iterable<number>): Promise<void> {
    for (const fileId of fileIds) {
      this.#cancelled.add(fileId);
      const entry = this.#incoming.get(fileId);
      // Not an error when there is no entry: cancelling a file that already
      // finished, was never offered, or was cancelled a moment ago is a
      // no-op, and the id is remembered above either way.
      if (!entry) continue;
      this.#incoming.delete(fileId);
      // Marked before the await so a chunk arriving mid-abort takes the
      // `entry.failed` early return in #handleData rather than writing into
      // a sink that is being torn down.
      entry.failed = true;
      try {
        await entry.sink?.abort('the transfer was cancelled');
      } catch {
        // A sink that cannot abort cleanly must not stop the rest of the
        // cancel, and there is nothing the user could do about it.
      }
      this.#opts.events.onFileCancelled?.(fileId);
    }
  }

  /**
   * Every file that arrived here whole, so a resync can re-acknowledge them.
   * Read through the frame chain for the same reason `resumePoints` is: a
   * synchronous read could miss a file-end still queued to land.
   */
  completedFiles(): Promise<number[]> {
    return this.#chain.then(() => [...this.#completed]);
  }

  resumePoints(): Promise<{ fileId: number; bytesReceived: number }[]> {
    return this.#chain.then(() => [...this.#incoming.values()]
      .filter((entry) => !entry.failed)
      .map((entry) => ({ fileId: entry.meta.id, bytesReceived: entry.bytesReceived })));
  }

  /**
   * The chain below is unbounded, and deliberately so for now: there is no
   * receiver→sender flow control in this stack (the relay forwards without
   * checking `bufferedAmount`, and a browser `WebSocket` cannot pause
   * delivery), so every arriving frame is appended unconditionally. While the
   * network is no faster than the disk this stays flat; when it is faster,
   * the deficit accumulates here as pending closures, each pinning a ≤64 KB
   * frame. `Sender.#awaitDrain` does not help — it bounds the sender's own
   * socket buffer, which stays drained precisely because the relay keeps
   * reading. Bounding this properly needs a credit control frame, i.e. a
   * protocol change, which belongs with Plan 3.
   */
  start(): void {
    this.#opts.transport.onMessage((raw) => {
      this.#chain = this.#chain.then(() => this.#handle(raw)).catch((error: unknown) => {
        this.#opts.events.onError({ message: error instanceof Error ? error.message : String(error) });
      });
    });
  }

  /**
   * Aborts every file still in flight and forgets them. Called when the session
   * tears the Receiver down — close, or a peer leaving — so a streaming sink
   * does not leak its file handle and leave a partial file on disk.
   */
  abortAll(reason: string): void {
    this.#aborted = true;
    for (const entry of this.#incoming.values()) {
      entry.failed = true;
      // `?.`: a file that has been offered but has not yet had a chunk has no
      // sink to release. Fire-and-forget otherwise: teardown is synchronous,
      // and a sink that cannot even abort has nothing further to report.
      void entry.sink?.abort(reason).catch(() => undefined);
    }
    this.#incoming.clear();
  }

  async #handle(raw: Uint8Array): Promise<void> {
    const frame = decodeFrame(raw);

    if (frame.type === FrameType.Control) {
      // fix-round-2: the AEAD check below only proves a control frame is
      // genuine, not that it is fresh — a relay replaying a verbatim
      // `offer-batch` mid-transfer would otherwise pass it and reset a
      // file's bookkeeping (bytesReceived back to 0, orphaning its live
      // sink), and a replayed `text` would duplicate a snippet. Mirrors the
      // data-frame check below: reject first, and only advance state once
      // `open` below has actually succeeded.
      if (frame.seq <= this.#lastControlSeq) {
        if (!this.#replayedControlReported) {
          this.#replayedControlReported = true;
          this.#opts.events.onError({ message: 'A control message arrived out of order or duplicated and was discarded.' });
        }
        return;
      }
      const nonce = makeNonce(this.#remotePeerId, this.#opts.remoteNoncePrefix, frame.seq);
      let plaintext: Uint8Array;
      try {
        // frame.header is the AAD: a control frame relabelled as data, or one
        // whose seq was altered, fails here rather than being acted on.
        plaintext = await open(this.#opts.key, nonce, frame.payload, frame.header);
      } catch {
        // A control frame failing its tag means the stream was altered.
        // Surface it rather than proceeding on unauthenticated instructions.
        this.#opts.events.onError({ message: 'A control message failed its integrity check and was discarded.' });
        return;
      }
      this.#lastControlSeq = frame.seq;
      await this.#handleControl(decodeControl(plaintext));
      return;
    }

    const entry = this.#incoming.get(frame.fileId);
    if (!entry) {
      // Chunks of a cancelled file keep arriving until the peer's own loop
      // notices — expected, and silent. See `#cancelled`.
      if (this.#cancelled.has(frame.fileId)) return;
      this.#opts.events.onError({ fileId: frame.fileId, message: 'Received data for a file that was never offered.' });
      return;
    }
    if (entry.failed) return;

    if (frame.seq <= entry.lastSeq) {
      await this.#failFile(entry, `"${entry.meta.name}" arrived out of order or duplicated and was discarded.`);
      return;
    }

    let plaintext: Uint8Array;
    try {
      const nonce = makeNonce(this.#remotePeerId, this.#opts.remoteNoncePrefix, frame.seq);
      // fix-round-2: the byte offset this chunk claims to start at is bound
      // into the AAD alongside the header (see data-aad.ts). A chunk sealed
      // for one offset simply cannot open against another, so a dropped
      // chunk, a replayed control frame that reset bytesReceived, or a
      // resume repeated any number of times all fail loudly here instead of
      // silently splicing bytes into the wrong position. This replaces the
      // fix-round-1 `sawGap` seq-inference approach (deleted): that approach
      // exempted a file's very first accepted chunk (lastSeq started at
      // NO_SEQ_YET) and had no check at all for a replayed control frame
      // resetting bytesReceived to 0 — both false negatives, not just false
      // positives as fix-round-1's report incorrectly claimed.
      plaintext = await open(this.#opts.key, nonce, frame.payload, dataAad(frame.header, entry.bytesReceived));
    } catch {
      await this.#failFile(entry, `"${entry.meta.name}" failed its integrity check and was discarded.`);
      return;
    }

    if (entry.bytesReceived + plaintext.length > entry.meta.size) {
      await this.#failFile(entry, `"${entry.meta.name}" sent more data than it offered and was discarded.`);
      return;
    }

    // Read before the write, never after: a sink may take ownership of the
    // chunk (the worker's proxy transfers its buffer to the page rather than
    // copying it), and a detached buffer reports a length of 0 — which would
    // silently stall this file's byte count and then fail it as incomplete.
    const chunkLength = plaintext.length;

    // Built here, on the first chunk that needs it, so an offer costs nothing.
    const sink = entry.sink ?? await this.#openSink(entry);
    // Undefined means this file must not proceed: it was reported, or the
    // Receiver was torn down while the sink was being built.
    if (!sink) return;

    try {
      await sink.write(plaintext);
    } catch (error: unknown) {
      // Not left to the chain's catch: that reports no fileId, leaves the entry
      // live, and lets every later chunk keep writing into a file that will
      // then "complete" with a hole. The blob sink cannot reject, but the File
      // System Access and Service Worker sinks do — disk full, revoked
      // permission, a cancelled download.
      // A rejection that is merely this file being torn down mid-write is not
      // a save failure, and reporting it would surface an error for a file the
      // session has already abandoned.
      if (entry.failed) return;
      const reason = error instanceof Error ? error.message : String(error);
      await this.#failFile(entry, `"${entry.meta.name}" could not be saved: ${reason}`);
      return;
    }

    // `abortAll` can mark this file failed and abort its sink while the write
    // above is in flight. The in-memory sink resolves instantly so the window
    // was empty, but a streaming sink resolves only as the disk drains — and
    // the resumed continuation would then advance the counters and report
    // progress for a file that has been torn down, or emit after close().
    if (entry.failed) return;

    entry.lastSeq = frame.seq;
    entry.bytesReceived += chunkLength;
    this.#opts.events.onProgress({
      fileId: entry.meta.id, bytesReceived: entry.bytesReceived, totalBytes: entry.meta.size,
    });
  }

  /**
   * Builds this file's sink, at the first moment it is actually needed. The
   * factory can take arbitrarily long — a Save-As dialog waits on the user,
   * the Service Worker sink waits for the browser to start the download — so
   * every resumption re-checks that this Receiver is still alive.
   *
   * Returns undefined when the file must not proceed. Any sink built for a
   * dead Receiver is released here rather than leaked: it holds a real file
   * handle, or a real browser download stuck at zero.
   */
  async #openSink(entry: Incoming): Promise<SaveSink | undefined> {
    // Torn down while this chunk was decrypting: build nothing at all.
    if (this.#aborted || entry.failed) return undefined;

    let sink: SaveSink;
    try {
      sink = await (this.#opts.createSink ?? createBlobSink)(entry.meta);
    } catch (error: unknown) {
      // A cancelled Save-As dialog, or a download helper that never answered.
      if (this.#aborted || entry.failed) return undefined;
      const reason = error instanceof Error ? error.message : String(error);
      await this.#failFile(entry, `"${entry.meta.name}" could not be saved: ${reason}`);
      return undefined;
    }

    if (this.#aborted || entry.failed) {
      void sink.abort('the transfer was cancelled').catch(() => undefined);
      return undefined;
    }

    // Assigned before the cap check so #failFile can release it.
    entry.sink = sink;
    try {
      // The second line of defence: the tier's ceiling was checked at offer
      // time, and the sink checks its own here.
      sink.assertWithinCap(entry.meta.size);
    } catch (error: unknown) {
      await this.#failFile(entry, error instanceof Error ? error.message : String(error));
      return undefined;
    }
    return sink;
  }

  /** Marks a file failed, abandons its sink, and reports it once. */
  async #failFile(entry: Incoming, message: string): Promise<void> {
    entry.failed = true;
    try {
      // `?.`: a file can fail before it ever had a chunk to build a sink on.
      await entry.sink?.abort(message);
    } catch {
      // A failing abort must not replace the specific message below.
    }
    this.#opts.events.onError({ fileId: entry.meta.id, message });
  }

  async #handleControl(msg: ReturnType<typeof decodeControl>): Promise<void> {
    switch (msg.t) {
      case 'offer-batch': {
        for (const meta of msg.files) {
          // The tier's ceiling, answered without building anything. This is
          // the whole reason nothing here awaits: an offer must cost no
          // dialogs, no downloads, and no time on the frame chain.
          const rejection = capacityRejection(this.#opts.saveCapability ?? 'blob', meta.size);
          if (rejection !== undefined) {
            this.#opts.events.onError({ fileId: meta.id, message: rejection });
            continue;
          }
          this.#incoming.set(meta.id, {
            meta, sink: undefined, bytesReceived: 0, lastSeq: NO_SEQ_YET, failed: false,
          });
        }
        // Spread: msg.files is `readonly FileMeta[]` on the wire type, but
        // ReceiverEvents.onOffer takes a mutable FileMeta[]. Every file is
        // still reported, matching the offer as sent, even ones that failed
        // the ceiling check above and so were never added to #incoming.
        this.#opts.events.onOffer([...msg.files]);
        return;
      }
      case 'file-end': {
        const entry = this.#incoming.get(msg.fileId);
        if (!entry) return;
        this.#incoming.delete(msg.fileId);
        if (entry.failed) return;
        // A file is complete only at its offered length. Without this, a relay
        // that swallows the last chunk yields a truncated file in which every
        // tag verified — exactly the silent corruption this design must not
        // produce.
        if (entry.bytesReceived !== entry.meta.size) {
          await this.#failFile(
            entry,
            `"${entry.meta.name}" arrived incomplete (${entry.bytesReceived} of ${entry.meta.size} bytes) `
            + 'and was discarded.',
          );
          return;
        }
        // A zero-byte file emits no data frames, so nothing has built its sink
        // and this is the last moment anything can. Without it an empty file
        // would be reported complete and never written anywhere.
        const sink = entry.sink ?? await this.#openSink(entry);
        if (!sink) return;
        try {
          const blob = await sink.close();
          // Recorded before the event, so a caller that acks from inside
          // onFileComplete (Session does) can never be acking something this
          // Receiver would not re-ack on the next resync.
          this.#completed.add(entry.meta.id);
          this.#opts.events.onFileComplete({ meta: entry.meta, blob });
        } catch (error: unknown) {
          this.#opts.events.onError({
            fileId: entry.meta.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case 'file-ack':
        // Not this Receiver's business beyond forwarding it: the file it
        // names is one this device sent, and the Sender is Session's.
        this.#opts.events.onFileAck?.(msg.fileId);
        return;
      case 'text':
        this.#opts.events.onText(msg.content);
        return;
      case 'verified':
        // No payload to check: arriving sealed under the derived key is the
        // whole content of the claim. Session gates its own sends on it.
        this.#opts.events.onPeerVerified?.();
        return;
      case 'end-session':
        // Also no payload: that it arrived sealed is the whole claim, and
        // the claim is only ever "I am going, and I meant to".
        this.#opts.events.onPeerEnded?.();
        return;
      case 'device': {
        // Sanitised here, at the boundary, rather than in the component that
        // renders it: this is the single place peer-authored device text
        // enters the app, and a second entry point that forgot to call this
        // would be a rendering bug nobody notices until someone sends a
        // bidi override. A payload that does not survive the parse is
        // dropped in silence — a peer on an older or odd build simply has
        // no card, which is not a failure worth alarming anyone about.
        const info = parseDeviceInfo(msg.info);
        if (info) this.#opts.events.onPeerDevice?.(info);
        return;
      }
      case 'cancel':
        // Aimed at Session, not at this Receiver, for the same reason
        // 'resume-from' is: only Session can tell whether a `side: 'yours'`
        // cancel names files this device actually queued for sending, and
        // only Session owns the Sender that would have to stop them. It
        // calls back into `cancelIncoming` for the half that IS this
        // Receiver's. Everything in the payload is untrusted — validated in
        // Session's `#handleCancel`.
        this.#opts.events.onCancel?.(msg.side, msg.fileIds);
        return;
      case 'resume-from':
        // Aimed at the peer's Sender, not at this Receiver — Session reads
        // this event and drives resumeFile on its own Sender. Validating
        // fileId/bytesReceived is Session's job: it is the only side that
        // knows which fileIds it actually queued for sending.
        this.#opts.events.onResumeFrom?.(msg.fileId, msg.bytesReceived);
        return;
      // The whitelist boundary for live media negotiation, exactly the
      // shape of the `device` case above: parse the peer-supplied payload
      // into a fresh, known-good object and drop it in silence if it
      // doesn't fit. Everything downstream — Session, the worker bridge,
      // and Task 4's MediaPeer — trusts a `MediaControl` it receives
      // without re-checking it, so this is the one and only place that
      // trust is established. A peer sending garbage here is indistinguishable
      // from one that simply never tried to share; there is no separate
      // error to raise, and raising one would treat a hostile peer's own
      // malformed frame as this device's transfer failing.
      case 'media-offer': {
        const offer = parseMediaOffer(msg.offer);
        if (offer) this.#opts.events.onMediaSignal?.({ t: 'media-offer', offer });
        return;
      }
      case 'media-answer': {
        const answer = parseMediaAnswer(msg.answer);
        if (answer) this.#opts.events.onMediaSignal?.({ t: 'media-answer', answer });
        return;
      }
      case 'media-ice': {
        const ice = parseMediaIce(msg.ice);
        if (ice) this.#opts.events.onMediaSignal?.({ t: 'media-ice', ice });
        return;
      }
      case 'media-stop':
        // No payload to whitelist — the tag alone is the whole message.
        this.#opts.events.onMediaSignal?.({ t: 'media-stop' });
        return;
      default:
        return;
    }
  }
}
