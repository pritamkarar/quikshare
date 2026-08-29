import type { Transport } from '../transport/types.js';
import type { ControlMessage, FileMeta, MediaControl } from '../../shared/messages.js';
import type { DeviceInfo } from '../../shared/device.js';
import { HIGH_WATER_BYTES, MAX_FRAME_BYTES } from '../transport/types.js';
import { FrameType, HEADER_BYTES, encodeControl, encodeFrame, encodeHeader } from '../protocol.js';
import { makeNonce, seal } from '../crypto.js';
import type { TransportSwapGate } from '../transport/upgrade.js';
import { dataAad } from './data-aad.js';

export const GCM_TAG_BYTES = 16;
// Sized so header + ciphertext + GCM tag lands on exactly MAX_FRAME_BYTES.
export const CHUNK_SIZE = MAX_FRAME_BYTES - HEADER_BYTES - GCM_TAG_BYTES; // 65507

/**
 * Human copy, not a protocol token: useSession's `userFacing` passes
 * anything that isn't a bare lowercase token straight through, so this is
 * what the user actually reads.
 */
export const TEXT_TOO_LONG = 'That note is too long to send in one message. Send it as a file, or split it into shorter notes.';

// Re-exported so callers of Sender don't also need to reach into
// client/transport/types.js for the constants that govern its own
// backpressure and frame sizing.
export { HIGH_WATER_BYTES, MAX_FRAME_BYTES };

export interface SenderEvents {
  onProgress(p: { fileId: number; bytesSent: number; totalBytes: number }): void;
  /**
   * The peer has this file, whole — it said so with a `file-ack`
   * (shared/messages.ts), which is the only thing on either device that
   * knows. Deliberately NOT "the last frame was written": `transport.send()`
   * returns the same way whether the frame reached anything or was dropped
   * on a channel that is no longer open, so a Sender reporting its own
   * writes reports success for bytes nobody received. See the `file-ack`
   * doc for the session that proved it.
   *
   * A file that is fully written but not yet acknowledged is in neither
   * state: it fires nothing, and its row stays at 100% until the ack lands
   * (one round trip, normally) or a resync re-establishes what the peer
   * actually has.
   */
  onFileDone(fileId: number): void;
  /**
   * This file stopped early because someone cancelled it — either this
   * device's user or, through Session, the peer's.
   *
   * Distinct from `onFileDone`, which means the whole file reached the peer:
   * a cancelled file never gets a `file-end`, so treating the two as one
   * event would report a partial transfer as a complete one. Optional, like
   * `onFilesQueued`, so a caller with no cancel UI is unaffected.
   */
  onFileCancelled?(fileId: number): void;
  /**
   * Fired synchronously, before a single byte of the batch goes out — the
   * only chance the local UI gets to learn these ids before the whole batch
   * finishes sending. Every onProgress/onFileDone call for this batch is
   * keyed by one of them, so a queue that waited for `sendFiles` to resolve
   * before showing anything would show every row as freshly started at the
   * exact moment the transfer actually completes. Optional so existing
   * callers that don't need it are unaffected.
   */
  onFilesQueued?(metas: FileMeta[]): void;
}

export interface SenderOptions {
  transport: Transport;
  key: CryptoKey;
  peerId: 'a' | 'b';
  noncePrefix: Uint8Array;
  events: SenderEvents;
  /**
   * Continues the session-wide counter across a Sender rebuild. Required, not
   * defaulted: the never-restarting counter is the whole safety argument
   * against nonce reuse, and an optional parameter would let a future
   * construction site reintroduce the catastrophic bug by writing *less* code.
   */
  initialSeq: bigint;
  /**
   * fix-round-4 (Critical, corrected from round 3): continues the
   * batch-scoped fileId counter across a Sender rebuild — the same shape as
   * `initialSeq` above, and required for the same reason. Round 3's own
   * doc here justified making this optional by claiming a collision "fails
   * loudly" via the AAD-offset binding — false. `receiver.ts`'s
   * `offer-batch` handler does a bare `this.#incoming.set(meta.id, {...})`:
   * a rebuilt Sender restarting at 1 while fileId 1 is still genuinely in
   * flight replaces that file's `Incoming` entry outright, with no error,
   * no abort, and no close — the OLD file's sink (a real File System
   * Access handle, mid-write) is silently orphaned, the old file vanishes
   * from `resumePoints()` forever, and its progress row just freezes. A
   * *late* chunk of the old file does then fail loudly — but against the
   * new, healthy file's `Incoming` entry, not the one it belongs to. This
   * is exactly the silent-stall failure mode the AAD binding exists to
   * eliminate, reached a different way. `Session.#buildSender` is the one
   * production call site, and it already passes `previous?.nextFileId`
   * (see that method's own doc comment) — required, not defaulted, so a
   * future construction site cannot reintroduce this by writing *less*
   * code, exactly as `initialSeq`'s own doc argues for itself.
   */
  initialFileId: number;
  /**
   * Files written in full but not yet acknowledged, carried across a Sender
   * rebuild the same way `initialSeq` and `initialFileId` are — an ack that
   * arrives after a reconnect still names a file this device sent, and
   * without this it would land on a Sender that has never heard of it and
   * the row would stay at 100% for the rest of the session.
   *
   * Optional where those two are required, and the difference is the cost of
   * getting it wrong: a restarted seq counter reuses a nonce and a restarted
   * fileId counter silently replaces a live file, while a forgotten
   * acknowledgement costs a badge. A resync re-sends the acks anyway (see
   * Session's `#resyncReceiveState`), so this is the fast path, not the
   * guarantee.
   */
  initialAwaitingAck?: Iterable<number>;
  /**
   * Coordinates every frame this Sender emits with a pending transport swap,
   * so a swap can only land at a frame boundary — never mid-chunk. Required,
   * not defaulted, for the same reason `initialSeq` is: this is the only
   * thing standing between a live upgrade and a straddled cutover, and an
   * optional field would let a future construction site silently drop the
   * coordination by doing less. Must be the *same instance* passed to
   * `negotiateUpgrade`'s `gate` option — see TransportSwapGate's doc comment
   * in client/transport/upgrade.ts for what it guarantees and why
   * `#awaitDrain` must never be wrapped inside it.
   */
  gate: TransportSwapGate;
}

export class Sender {
  readonly #opts: SenderOptions;
  #nextFileId: number;
  /**
   * Never resets within a session. A rebuilt Sender continues from where the
   * previous one stopped, which is what keeps nonces unique even if a
   * regenerated 3-byte prefix happens to repeat one already used.
   */
  #nextSeq: bigint;
  #batchCounter = 0;
  #aborted: string | undefined;
  /**
   * Files the user pulled out of the batch, by fileId.
   *
   * Separate from `#aborted` and deliberately not shaped like it: an abort
   * is the transport dying and takes the whole batch down by throwing, while
   * a cancel takes out one file and leaves the rest of the batch sending.
   * The loop checks this and moves on, rather than throwing.
   *
   * Never emptied. A cancelled id must stay cancelled for the life of this
   * Sender — a late `resumeFile` for it (after a reconnect that re-offers
   * everything still in `#queuedFiles`) would otherwise restart a file the
   * user already stopped.
   */
  readonly #cancelled = new Set<number>();
  /**
   * Written in full, waiting on the peer's `file-ack`. A file leaves this
   * set exactly once, when `confirmDelivered` reports it done — a duplicate
   * or forged ack finds nothing to report a second time.
   */
  readonly #awaitingAck: Set<number>;
  /**
   * A list, not a single slot. `sendFiles` is public and unserialized, so two
   * batches can be backed up at once; a single slot would let the second
   * overwrite the first's settler and strand it forever — a progress row frozen
   * with no error. `Transport.onDrain` is itself a single slot, so one callback
   * has to settle everyone waiting.
   */
  #drainWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  /**
   * fix-round-3 (Critical): `TransportSwapGate.wrap` is a *counting* gate
   * (`#inFlight++`/`#inFlight--`), not a mutex — it serializes nothing
   * between two concurrent callers, only against a swap. `#sendControl`
   * assigns `seq` synchronously but only puts the frame on the wire once
   * `seal` (a real `crypto.subtle.encrypt` call) resolves, and a larger
   * payload always takes longer to seal — so two concurrently-issued
   * control frames (e.g. two `sendText` calls back to back, or a `text`
   * racing an `offer-batch`) could reach `transport.send` in the opposite
   * order from the one `seq` was assigned in. The receiver's control
   * monotonicity check (`#lastControlSeq`) is correct to reject whichever
   * lands second in that case — reordering the wire, not relaxing that
   * check, is the fix. `#controlChain` makes every `#sendControl` call wait
   * for the previous one's seq-assign-through-send to fully finish before
   * its own seq is even assigned, so wire order is always assignment order.
   * Data frames need no equivalent: `#sendOneFile`'s own loop is already
   * sequential per call, and two different files' chunks racing each other
   * is harmless — the receiver's checks are per-file, not session-wide.
   */
  #controlChain: Promise<void> = Promise.resolve();

  constructor(opts: SenderOptions) {
    // Copy the prefix: a caller mutating the array it passed in must not be
    // able to change nonces out from under an in-flight session.
    this.#opts = { ...opts, noncePrefix: opts.noncePrefix.slice() };
    this.#nextSeq = opts.initialSeq;
    this.#nextFileId = opts.initialFileId;
    this.#awaitingAck = new Set(opts.initialAwaitingAck ?? []);
  }

  /** The next sequence number this sender will use. Carried across rebuilds. */
  get nextSeq(): bigint {
    return this.#nextSeq;
  }

  /**
   * The next fileId this sender will mint. Carried across rebuilds — see
   * `SenderOptions.initialFileId`'s doc comment.
   */
  get nextFileId(): number {
    return this.#nextFileId;
  }

  /** What this Sender is still waiting to hear about. Carried across rebuilds. */
  get awaitingAck(): ReadonlySet<number> {
    return this.#awaitingAck;
  }

  #mintFileId(): number { return this.#nextFileId++; }

  /**
   * The whole file is on the wire. Nothing is reported yet: whether it
   * arrived is the peer's to say, and `confirmDelivered` below is where it
   * says it.
   */
  #awaitAck(fileId: number): void {
    this.#awaitingAck.add(fileId);
  }

  /**
   * The peer acknowledged `fileId`. Silent for an id that is not waiting on
   * one — a duplicate ack, an ack for a file that was cancelled, or a number
   * a hostile relay made up. The id comes off the wire, so this is a lookup
   * and never an index or an assumption; Session validates it is an integer
   * before calling (see `#handleFileAck`).
   */
  confirmDelivered(fileId: number): void {
    if (this.#awaitingAck.delete(fileId)) this.#opts.events.onFileDone(fileId);
  }

  /** Tells the peer's Sender that `fileId` arrived here whole. */
  async sendFileAck(fileId: number): Promise<void> {
    await this.#sendControl({ t: 'file-ack', fileId });
  }

  /**
   * Called by the session when the transport dies. Rejects any in-flight
   * send rather than leaving it pending forever, and stops the loop from
   * reporting progress for bytes the transport is silently dropping.
   *
   * `Transport` has a single close-callback slot, and Task 12's `Session`
   * owns it (peer-left handling depends on that registration surviving), so
   * `Sender` never calls `transport.onClose(...)` itself — the session must
   * drive this method explicitly instead.
   */
  /**
   * Stops these files at the next chunk boundary, leaving the rest of the
   * batch alone. Idempotent, and safe for a file that has already finished
   * or was never in this batch: an unknown id simply never matches.
   *
   * Sending the peer its half of the news is Session's job, not this one —
   * `sendCancel` is a separate call so a cancel arriving FROM the peer can
   * reuse this method without echoing the frame straight back.
   */
  cancel(fileIds: Iterable<number>): void {
    for (const id of fileIds) this.#cancelled.add(id);
  }

  /** Whether this file was cancelled — read by Session before it resumes anything. */
  isCancelled(fileId: number): boolean {
    return this.#cancelled.has(fileId);
  }

  abort(reason: string): void {
    this.#aborted = reason;
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const waiter of waiters) waiter.reject(new Error(reason));
  }

  /**
   * The one length check on this class, and deliberately not a chunked send:
   * a text snippet is a single unchunked control frame, so its real ceiling
   * is one frame's worth of plaintext — exactly what CHUNK_SIZE already
   * names (MAX_FRAME_BYTES minus header minus GCM tag).
   *
   * Without it the ceiling *moved with the transport*: on the relay an
   * oversized note went out fine, up to the server's 4 MB maxPayload; after
   * a WebRTC upgrade the same note made `WebRTCTransport.send` throw
   * "frame of N bytes exceeds MAX_FRAME_BYTES", which useSession's
   * `userFacing` passes through verbatim because it isn't a protocol token.
   * The same action silently succeeding or loudly failing depending on a
   * swap the user was never asked about is the worst of both. Checked here
   * rather than only in the UI because the worker's 'send-text' message is
   * a public path of its own; `MAX_TEXT_CHARS` is what stops the textarea
   * long before this can fire.
   */
  async sendText(content: string): Promise<void> {
    if (encodeControl({ t: 'text', content }).length > CHUNK_SIZE) {
      throw new Error(TEXT_TOO_LONG);
    }
    await this.#sendControl({ t: 'text', content });
  }

  /** Returns the metas it minted, so callers can key progress by the same ids. */
  async sendFiles(files: File[]): Promise<FileMeta[]> {
    const metas: FileMeta[] = files.map((file) => ({
      id: this.#mintFileId(),
      name: file.name,
      size: file.size,
      type: file.type,
    }));

    // Announced before anything is awaited, and before the peer has even
    // been told: the *local* UI has no other way to learn these ids, and it
    // needs them now, not once the whole batch is done.
    this.#opts.events.onFilesQueued?.(metas);

    await this.#sendControl({ t: 'offer-batch', batchId: `b${++this.#batchCounter}`, files: metas });

    for (const [index, file] of files.entries()) {
      const meta = metas[index]!;
      // Checked before the file starts AND again after it, because a cancel
      // can land at either point: before, this file never begins; after, it
      // stopped part-way through and must not reach the file-end below,
      // which is the frame that tells the receiver a file is whole.
      if (this.#cancelled.has(meta.id)) {
        this.#opts.events.onFileCancelled?.(meta.id);
        continue;
      }
      await this.#sendOneFile(file, meta);
      if (this.#cancelled.has(meta.id)) {
        this.#opts.events.onFileCancelled?.(meta.id);
        continue;
      }
      await this.#sendControl({ t: 'file-end', fileId: meta.id });
      this.#awaitAck(meta.id);
    }

    return metas;
  }

  /**
   * Continues a file from a byte offset after a reconnect — the receiver
   * still has `fromByte` bytes of it, so re-sending from the top would waste
   * the reconnect on bytes that already arrived. No replay buffer is needed:
   * the File is still in hand and can be sliced at any point. The resumed
   * chunks get fresh sequence numbers from the same never-restarting
   * counter, which is what makes re-sending safe — a new nonce for the same
   * plaintext is fine; reusing the original chunk's nonce would not be.
   *
   * `fromByte` is untrusted: it travels from the peer's `resume-from`
   * control message through `protocol.ts`'s un-validated `JSON.parse` cast
   * (`decodeControl`), so nothing upstream guarantees it is even a number.
   * A negative value would make `file.slice(negative, …)` count from the
   * *end* of the file — sending the wrong bytes while `bytesSent` in
   * `#sendOneFile` starts negative and reports nonsense progress — so it is
   * rejected outright rather than clamped into something that looks
   * plausible. The session-level caller additionally checks this is a
   * fileId it actually queued, which this method has no way to know.
   */
  async resumeFile(file: File, meta: FileMeta, fromByte: number): Promise<void> {
    // A file the user cancelled must not come back through the resume path.
    // Session re-offers everything still queued after a reconnect, and a
    // cancel that landed before the drop would otherwise be undone by it.
    if (this.#cancelled.has(meta.id)) {
      this.#opts.events.onFileCancelled?.(meta.id);
      return;
    }
    if (!Number.isInteger(fromByte) || fromByte < 0 || fromByte > file.size) {
      throw new Error(`resumeFile: fromByte ${fromByte} is out of range for a ${file.size}-byte file`);
    }
    // Exactly equal, not >=: the guard above already rejected anything
    // larger, so this branch is only ever "the receiver already has the
    // whole file" — a resume with nothing left to send, which still owes the
    // peer its file-end.
    if (fromByte === file.size) {
      await this.#sendControl({ t: 'file-end', fileId: meta.id });
      this.#awaitAck(meta.id);
      return;
    }
    await this.#sendOneFile(file, meta, fromByte);
    if (this.#cancelled.has(meta.id)) {
      this.#opts.events.onFileCancelled?.(meta.id);
      return;
    }
    await this.#sendControl({ t: 'file-end', fileId: meta.id });
    this.#awaitAck(meta.id);
  }

  /** Tells the peer's Sender how many bytes of `fileId` this side already has. */
  async sendResumeFrom(fileId: number, bytesReceived: number): Promise<void> {
    await this.#sendControl({ t: 'resume-from', fileId, bytesReceived });
  }

  /**
   * Tells the peer which files stopped, and whose ids these are — see the
   * `cancel` frame's own doc comment in shared/messages.ts for why `side`
   * cannot be left for the recipient to infer.
   */
  async sendCancel(side: 'mine' | 'yours', fileIds: readonly number[]): Promise<void> {
    await this.#sendControl({ t: 'cancel', side, fileIds });
  }

  /**
   * Describes this machine to the peer's device panel.
   *
   * No length check of its own, unlike `sendText`: every field is minted by
   * `describeThisDevice` from a fixed set of short labels and clamped to
   * MAX_FIELD_CHARS by `cleanText`, so the whole message is a couple of
   * hundred bytes at the outside — orders of magnitude below one frame. The
   * peer sanitises it again on arrival regardless (`parseDeviceInfo`), which
   * is the check that actually matters, since this is the *other* side's
   * copy of this method that a hostile peer would be running.
   */
  async sendDevice(info: DeviceInfo): Promise<void> {
    await this.#sendControl({ t: 'device', info });
  }

  /**
   * Tells the peer that this device's user has confirmed the verification
   * number. Sealed like every other control message, which is the point:
   * a relay that swapped the ECDH public keys cannot produce this frame
   * under the key either device actually derived.
   */
  async sendVerified(): Promise<void> {
    await this.#sendControl({ t: 'verified' });
  }

  /**
   * Says this device is leaving on purpose. Not gated on verification: the
   * "End session" control is on screen from the moment a session connects,
   * beside the verification panel rather than after it.
   */
  async sendEndSession(): Promise<void> {
    await this.#sendControl({ t: 'end-session' });
  }

  /**
   * Hands one of the four `media-*` control frames to the peer, sealed like
   * every other control message. No length check of its own, unlike
   * `sendText`: an SDP is already bounded by `shared/media-signal.ts`'s
   * MAX_SDP_CHARS (64 KiB) on the *receiving* side, and this class sends
   * whatever its caller (Task 5's `LiveSession`, via `MediaPeer`) built
   * locally from a real `RTCPeerConnection` — never peer-authored text a
   * user typed, so there is nothing here for a UI-facing ceiling to guard.
   */
  async sendMediaSignal(msg: MediaControl): Promise<void> {
    await this.#sendControl(msg);
  }

  async #sendOneFile(file: File, meta: FileMeta, startByte = 0): Promise<void> {
    const { transport, key, peerId, noncePrefix, events, gate } = this.#opts;
    let bytesSent = startByte;

    for (let offset = startByte; offset < file.size; offset += CHUNK_SIZE) {
      // Checked every iteration, not just once before the loop: the transport
      // can die mid-file, and once it has, this file must not reach file-end
      // or onFileDone below — that would report bytes that never arrived.
      if (this.#aborted) throw new Error(this.#aborted);
      // Returns rather than throws, which is the whole difference between a
      // cancel and an abort: the caller's loop keeps going with the rest of
      // the batch, and only this file stops.
      if (this.#cancelled.has(meta.id)) return;

      const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
      const plaintext = new Uint8Array(await slice.arrayBuffer());

      // Building the header, sealing, and sending are one wrapped unit, so a
      // transport swap can only land between chunks, never inside one — see
      // TransportSwapGate's doc comment in client/transport/upgrade.ts.
      // #awaitDrain below is deliberately OUTSIDE this wrap: a send parked on
      // backpressure must not hold the gate open, or it would block the very
      // swap that could relieve that backpressure.
      await gate.wrap(async () => {
        const seq = this.#nextSeq++;
        // Built once and used twice: the bytes that go on the wire are
        // exactly the bytes bound into the tag, so the relay cannot rewrite
        // the type, the fileId or the seq without invalidating the chunk.
        const header = encodeHeader(FrameType.Data, meta.id, seq);
        // fix-round-2: `offset` (this chunk's own byte position in the
        // file) is authenticated alongside the header, not just sent — see
        // data-aad.ts. This is what lets the receiver tell "the byte count
        // it has accepted so far" apart from "a verified contiguous prefix
        // of the file": a chunk sealed for one offset cannot be opened
        // against any other, so a dropped chunk, a replayed control frame
        // that reset the receiver's bookkeeping, or a second/third resume
        // of the same file all fail loudly instead of silently misplacing
        // bytes.
        const sealed = await seal(key, makeNonce(peerId, noncePrefix, seq), plaintext, dataAad(header, offset));

        // The abort can land during either await above. Re-check before the
        // send that would otherwise report progress for bytes the transport
        // silently drops on a dead connection.
        if (this.#aborted) throw new Error(this.#aborted);
        // Same re-check as the abort above, for the same window: a cancel
        // landing during the slice read or the seal must not put one more
        // chunk of a stopped file on the wire.
        if (this.#cancelled.has(meta.id)) return;

        transport.send(encodeFrame(FrameType.Data, meta.id, seq, sealed));
      });

      // The guard inside the wrap above returns from that callback, not from
      // this loop, so without this the chunk it declined to send would still
      // be counted here — a cancelled file's last reported progress would
      // include bytes that never left this device.
      if (this.#cancelled.has(meta.id)) return;

      bytesSent += plaintext.length;
      events.onProgress({ fileId: meta.id, bytesSent, totalBytes: file.size });

      await this.#awaitDrain();
    }
  }

  /**
   * Blocks the send loop while the transport is backed up. Rejects instead
   * of waiting forever if the transport has died: `RelayTransport.close()`
   * stops drain polling without ever invoking a callback already registered
   * via `onDrain`, so an unconditional wait here would leave `sendFiles`
   * pending permanently once the peer disconnects mid-transfer.
   */
  #awaitDrain(): Promise<void> {
    const { transport } = this.#opts;
    if (this.#aborted) return Promise.reject(new Error(this.#aborted));
    if (transport.bufferedAmount < HIGH_WATER_BYTES) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#drainWaiters.push({ resolve, reject });
      transport.onDrain(() => {
        const waiters = this.#drainWaiters;
        this.#drainWaiters = [];
        for (const waiter of waiters) waiter.resolve();
      });
    });
  }

  /**
   * Control payloads are sealed like data chunks. `offer-batch` carries
   * filenames and `text` carries user content, so plaintext control frames
   * would hand the relay everything except the file bytes themselves.
   * The seq comes from the same session-wide counter, which is what keeps
   * nonces unique across control and data alike.
   *
   * `hello` is excluded on purpose: it carries the nonce prefix itself, so
   * sealing it under a nonce derived from that same undelivered prefix would
   * produce a frame the receiver can never open. Task 12's session sends it
   * in the clear, outside this method — the type exclusion below makes any
   * attempt to route it through here a compile error rather than a runtime
   * OperationError on the peer.
   */
  async #sendControl(msg: Exclude<ControlMessage, { t: 'hello' }>): Promise<void> {
    const { transport, key, peerId, noncePrefix, gate } = this.#opts;
    // Wrapped for the same reason #sendOneFile's chunks are: this is also
    // what sendText goes through, and quiescing the send loop for a swap
    // must cover text as well as file data.
    //
    // Chained behind #controlChain (fix-round-3, Critical — see that
    // field's doc comment): a second, concurrently-issued #sendControl call
    // must not even assign its seq until this one has fully sealed and sent,
    // or the two can land on the wire in the opposite order from the one
    // their seqs were assigned in.
    const run = this.#controlChain.then(() => gate.wrap(async () => {
      const seq = this.#nextSeq++;
      const header = encodeHeader(FrameType.Control, 0, seq);
      const sealed = await seal(key, makeNonce(peerId, noncePrefix, seq), encodeControl(msg), header);

      // wrap() can park this call at "while (this.#barrier) await" before
      // #nextSeq++ above ever runs. If a peer-left lands in that window,
      // Session's #unpair() aborts this Sender and snapshots this *same*
      // seq (not yet consumed) as the replacement Sender's initialSeq. Once
      // the barrier releases, this call would otherwise still emit its
      // frame — putting the same seq on the wire twice, from two different
      // Senders sharing one key. Consuming and discarding the seq here is
      // safe (skipping one is harmless); emitting it is not. Mirrors the
      // equivalent check in #sendOneFile just above.
      if (this.#aborted) throw new Error(this.#aborted);

      transport.send(encodeFrame(FrameType.Control, 0, seq, sealed));
    }));
    // Both branches swallowed on the *chain* (not on `run`, which still
    // carries the real outcome to this call's own caller below): one
    // control frame failing (a dead transport, an abort mid-seal) must not
    // wedge every #sendControl call queued behind it.
    this.#controlChain = run.then(() => undefined, () => undefined);
    return run;
  }
}
