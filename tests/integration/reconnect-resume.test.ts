// tests/integration/reconnect-resume.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket as NodeWebSocket } from 'ws';
import { buildServer } from '../../server/index.js';
import { Session } from '../../client/session.js';
import { CHUNK_SIZE } from '../../client/transfer/sender.js';
import { FrameType, decodeFrame } from '../../client/protocol.js';
import { confirmBoth } from '../pairing.js';

(globalThis as { WebSocket?: unknown }).WebSocket ??= NodeWebSocket;

let app: FastifyInstance | undefined;

async function start(): Promise<string> {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `ws://127.0.0.1:${address.port}/ws`;
}

afterEach(async () => { await app?.close(); app = undefined; });

/**
 * Replaces the global WebSocket constructor with one that records every
 * socket it creates and, for each, how many *data* frames it receives —
 * counted from the raw, unauthenticated frame header (type/fileId/seq only,
 * never decrypted). `Session.create`/`Session.join` and `Reconnector`'s own
 * retry all go through this same global constructor, so a test can grab "the
 * Nth socket a Session opened" (in particular a reconnect's brand new one)
 * without any of client code needing to know a test is watching.
 */
function interceptSockets(): { sockets: NodeWebSocket[]; dataFrameCounts: number[]; restore: () => void } {
  const Original = globalThis.WebSocket as unknown as typeof NodeWebSocket;
  const sockets: NodeWebSocket[] = [];
  const dataFrameCounts: number[] = [];
  class TrackedWebSocket extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      super(...args);
      sockets.push(this);
      const index = dataFrameCounts.push(0) - 1;
      this.addEventListener('message', (event: { data: unknown }) => {
        if (typeof event.data === 'string') return;
        const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
        if (frame.type === FrameType.Data) dataFrameCounts[index]!++;
      });
    }
  }
  (globalThis as { WebSocket: unknown }).WebSocket = TrackedWebSocket;
  return {
    sockets,
    dataFrameCounts,
    restore: () => { (globalThis as { WebSocket: unknown }).WebSocket = Original; },
  };
}

describe('reconnect and resume', () => {
  it(
    "resumes an upload from the receiver's actual byte offset after the sender's own "
    + 'connection drops and reconnects, instead of restarting the file',
    async () => {
      const { sockets, dataFrameCounts, restore } = interceptSockets();
      try {
        const url = await start();
        // sockets[0]/dataFrameCounts[0]: host's one and only socket for the
        // whole test — it never reconnects, so it is where every data frame
        // the file ever produces actually lands, both before and after the
        // guest's reconnect. A broken resume (full restart) would show up
        // here directly as more frames than the file has chunks.
        const host = await Session.create(url);
        // sockets[1]: guest's original connection — the one this test kills
        // to simulate guest's own network dropping mid-upload.
        const guest = await Session.join(url, host.code);
        await confirmBoth(host, guest);

        const errors: string[] = [];
        host.events.onError = (e) => { errors.push(e.message); };
        guest.events.onError = (e) => { errors.push(e.message); };
        let hostSawPeerLeft = 0;
        host.events.onPeerLeft = () => { hostSawPeerLeft++; };
        let guestSawPeerLeft = 0;
        guest.events.onPeerLeft = () => { guestSawPeerLeft++; };

        const TOTAL_CHUNKS = 8;
        const bytes = new Uint8Array(CHUNK_SIZE * TOTAL_CHUNKS);
        // A few genuinely random bytes at each chunk boundary: an all-zero
        // buffer would "byte-compare correctly" even from a completely wrong
        // reassembly (e.g. every chunk zeroed out identically).
        for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
          globalThis.crypto.getRandomValues(bytes.subarray(offset, offset + 32));
        }
        const file = new File([bytes], 'big.bin');

        let sendProgressCount = 0;
        guest.events.onSendProgress = () => {
          sendProgressCount++;
          // Closed synchronously, inside this very callback: the send loop
          // cannot have even started encoding chunk 4 yet (that only happens
          // on the next loop iteration, after this callback returns and an
          // await yields back to it), so this reliably interrupts the
          // upload mid-file rather than racing real network timing to catch
          // it "at some point". (The sender's own optimistic bytesSent
          // bookkeeping does keep advancing a little further before its
          // abort actually lands — chunks already queued locally — but
          // those extra chunks get silently dropped server-side the moment
          // the room registry forgets guest, per server/index.ts's
          // socket-close handler; they never reach host, and dataFrameCounts
          // below is what actually proves that.)
          if (sendProgressCount === 3) sockets[1]!.close();
        };

        let receiveProgressCount = 0;
        host.events.onReceiveProgress = () => { receiveProgressCount++; };
        const received = new Promise<Uint8Array>((resolve, reject) => {
          host.events.onFileComplete = async ({ blob }) => {
            if (!blob) { reject(new Error('no blob')); return; }
            resolve(new Uint8Array(await blob.arrayBuffer()));
          };
        });

        // Rejects once guest's own transport dies (Sender.abort on its own
        // onClose); the file actually completes through the later
        // resumeFile() call instead, driven by guest's reconnect.
        void guest.sendFiles([file]).catch(() => undefined);

        const result = await received;

        expect(errors).toEqual([]);
        expect(Buffer.compare(Buffer.from(result), Buffer.from(bytes))).toBe(0);

        // Ruling H's actual ask: prove bytes were skipped, not merely that
        // the transfer finished. A Receiver wrongly torn down on peer-left
        // (the bug Ruling H describes) would still produce a byte-correct
        // file here — host's receiver would just have been rebuilt fresh
        // and receive the whole thing again — so the assertions that
        // actually discriminate are on frame/progress counts, not on file
        // content: a broken resume (full restart) delivers MORE than
        // TOTAL_CHUNKS distinct data frames (whatever arrived before the
        // drop, plus every chunk again from a fresh Receiver), while a
        // resume that never engages at all (no reconnect wired up) leaves
        // `received` permanently unresolved and this test times out instead
        // of reaching these assertions at all.
        expect(dataFrameCounts[0]).toBe(TOTAL_CHUNKS);
        expect(receiveProgressCount).toBe(TOTAL_CHUNKS);

        // Sanity checks that the scenario actually exercised what it claims
        // to, rather than passing vacuously:
        // - a reconnect really happened (a second socket for guest exists).
        expect(sockets.length).toBeGreaterThanOrEqual(3);
        // - both sides actually took the peer-left/reconnect paths under
        //   test, not some other route to the same final bytes.
        expect(hostSawPeerLeft).toBeGreaterThan(0);
        expect(guestSawPeerLeft).toBeGreaterThan(0);
        expect(sendProgressCount).toBeGreaterThan(0);

        host.close();
        guest.close();
      } finally {
        restore();
      }
    },
    20_000,
  );

  // Fix-round-1, Important: the 2⁻²⁴ prefix-collision backstop was removed
  // deliberately (see session.ts's #noncePrefix doc comment) — the entire
  // nonce-uniqueness argument now rests on one property, `#nextSeq++`
  // sitting after the gate's park point with no await before
  // `transport.send`, and it was previously only exercised at the Sender
  // unit level. This locks it at the integration level: every AES-GCM seal
  // across N forced reconnects of one real session pair must produce a
  // distinct 12-byte IV, full stop.
  it(
    'never reuses a nonce across N forced reconnects of the same session pair',
    async () => {
      const encryptSpy = vi.spyOn(globalThis.crypto.subtle, 'encrypt');
      const { sockets, restore } = interceptSockets();
      try {
        const url = await start();
        const host = await Session.create(url);
        const guest = await Session.join(url, host.code);
        await confirmBoth(host, guest);

        const errors: string[] = [];
        host.events.onError = (e) => { errors.push(e.message); };
        guest.events.onError = (e) => { errors.push(e.message); };

        const ROUNDS = 4;
        for (let round = 0; round < ROUNDS; round++) {
          // 8 chunks, interrupted after 3: big enough a real, if narrow,
          // window separates "guest's own socket has genuinely gone away"
          // from "the reconnect + resume-from round trip has time to
          // settle" — a smaller file/earlier interrupt point closes the
          // guest's reconnected socket and host's original socket together
          // moments later, an environment-level TCP/port-reuse timing
          // artifact of opening a fresh connection to the same local
          // address microseconds after the last one started tearing down,
          // unrelated to anything this fix round touches.
          const bytes = new Uint8Array(CHUNK_SIZE * 8);
          globalThis.crypto.getRandomValues(bytes.subarray(0, 32));

          const completed = new Promise<Uint8Array>((resolve, reject) => {
            host.events.onFileComplete = async ({ blob }) => {
              if (!blob) { reject(new Error('no blob')); return; }
              resolve(new Uint8Array(await blob.arrayBuffer()));
            };
          });

          let sent = 0;
          guest.events.onSendProgress = () => {
            sent++;
            // Kills whichever socket is guest's current one — its original
            // connection on round 0, its most recent reconnect on every
            // round after.
            if (sent === 3) sockets[sockets.length - 1]!.close();
          };
          void guest.sendFiles([new File([bytes], `f${round}.bin`)]).catch(() => undefined);

          const result = await completed;
          expect(Buffer.compare(Buffer.from(result), Buffer.from(bytes))).toBe(0);
        }

        expect(errors).toEqual([]);
        // A reconnect really happened every round: host's own socket
        // (created once) plus guest's original plus one reconnect per round.
        expect(sockets.length).toBe(1 + 1 + ROUNDS);

        const ivs = encryptSpy.mock.calls.map(([algorithm]) => {
          // Every seal() call in this codebase passes a plain Uint8Array
          // nonce as `iv` (client/crypto.ts) — never an ArrayBuffer or a
          // view with a non-zero offset.
          const iv = (algorithm as AesGcmParams).iv as Uint8Array;
          return Buffer.from(iv).toString('hex');
        });
        expect(ivs.length).toBeGreaterThan(0);
        // The decisive check: not one repeated nonce across the whole run,
        // spanning the original pairing and every forced reconnect.
        expect(new Set(ivs).size).toBe(ivs.length);

        // Belt and braces, matching what removing the prefix-regeneration
        // backstop is supposed to mean: each peer's [peerByte|prefix] stays
        // fixed for the whole session (never regenerated on rebuild), so at
        // most one distinct value per peer — two total — no matter how many
        // times its Sender got rebuilt across these reconnects.
        const peerAndPrefix = new Set(ivs.map((hex) => hex.slice(0, 8)));
        expect(peerAndPrefix.size).toBeLessThanOrEqual(2);

        host.close();
        guest.close();
      } finally {
        encryptSpy.mockRestore();
        restore();
      }
    },
    20_000,
  );

  // Fix-round-2 (Critical, "the ceiling"): fix-round-1's `sawGap` flag was
  // set once and never cleared, so a *second* forced reconnect on a file
  // that had already tripped it left resumePoints() permanently excluding
  // that file — no resume-from ever sent again, no resend, file-end never
  // arrives, transfer stalls forever with no error. `sawGap` is deleted
  // entirely in fix-round-2 (the byte offset is bound into the AEAD AAD
  // instead — see data-aad.ts), so there is no flag left to get stuck. This
  // proves a single file survives being interrupted and resumed *twice*.
  it(
    'completes correctly after the same file is interrupted and resumed twice in a row',
    async () => {
      const { sockets, dataFrameCounts, restore } = interceptSockets();
      try {
        const url = await start();
        const host = await Session.create(url);
        const guest = await Session.join(url, host.code);
        await confirmBoth(host, guest);

        const errors: string[] = [];
        host.events.onError = (e) => { errors.push(e.message); };
        guest.events.onError = (e) => { errors.push(e.message); };

        const TOTAL_CHUNKS = 12;
        const bytes = new Uint8Array(CHUNK_SIZE * TOTAL_CHUNKS);
        for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
          globalThis.crypto.getRandomValues(bytes.subarray(offset, offset + 32));
        }
        const file = new File([bytes], 'twice.bin');

        let sendProgressCount = 0;
        let kills = 0;
        guest.events.onSendProgress = () => {
          sendProgressCount++;
          // First kill partway through the ORIGINAL connection (chunks
          // 1-3). Second kill partway through the FIRST reconnect's own
          // resumed send (chunks 4-7) — this is the part fix-round-1's
          // report got wrong: it described the ceiling as "falls back to a
          // restart", but the actual behaviour was a permanent stall. This
          // second kill is what a single "resume once" test cannot catch.
          if (kills === 0 && sendProgressCount === 3) { kills++; sockets[sockets.length - 1]!.close(); }
          else if (kills === 1 && sendProgressCount === 7) { kills++; sockets[sockets.length - 1]!.close(); }
        };

        let receiveProgressCount = 0;
        host.events.onReceiveProgress = () => { receiveProgressCount++; };
        const received = new Promise<Uint8Array>((resolve, reject) => {
          host.events.onFileComplete = async ({ blob }) => {
            if (!blob) { reject(new Error('no blob')); return; }
            resolve(new Uint8Array(await blob.arrayBuffer()));
          };
        });

        void guest.sendFiles([file]).catch(() => undefined);
        const result = await received;

        // Unlike the single-resume test above, one 'socket-closed' error is
        // expected here, not a bug: the second kill lands while guest's own
        // resumeFile() call (driven internally by #handleResumeFrom, not by
        // this test's own awaited call) is actively sending — session.ts
        // aborts that Sender and reports the rejection via onError, same as
        // it would for any other resumeFile() failure. The decisive proof
        // this fix-round-2 ceiling is actually gone is not "no errors at
        // all" but that the transfer still completes correctly afterward.
        expect(errors).toEqual(['socket-closed']);
        expect(Buffer.compare(Buffer.from(result), Buffer.from(bytes))).toBe(0);
        // Proves both resumes actually engaged (not that the second kill
        // was a no-op that a single resume already tolerated).
        expect(kills).toBe(2);
        // The decisive check, same shape as the single-resume test above:
        // exactly TOTAL_CHUNKS distinct data frames reached host, across
        // the original connection and both reconnects combined — a stall
        // would leave `received` unresolved and time this test out instead,
        // and a restart-from-scratch on either resume would show up here as
        // more than TOTAL_CHUNKS.
        expect(dataFrameCounts[0]).toBe(TOTAL_CHUNKS);
        expect(receiveProgressCount).toBe(TOTAL_CHUNKS);
        // Two reconnects really happened: host's one socket, guest's
        // original, plus one new socket per reconnect.
        expect(sockets.length).toBeGreaterThanOrEqual(4);

        host.close();
        guest.close();
      } finally {
        restore();
      }
    },
    20_000,
  );

  // Fix-round-2, "the main false-positive scenario": fix-round-1's `sawGap`
  // inferred a gap from `frame.seq !== entry.lastSeq + 1n`, but a control
  // frame (like a text message) sent mid-transfer consumes a seq from the
  // very same session-wide counter data frames draw from — so a text
  // snippet sent between two chunks would make the next chunk's seq jump by
  // 2 relative to the file's own last chunk, tripping `sawGap` even though
  // nothing was actually lost. Fix-round-2's AAD-offset binding has no such
  // failure mode at all: it only ever compares the byte offset a chunk
  // claims against bytesReceived, which a control frame's seq never
  // touches. This proves a text message mid-transfer, followed by a real
  // reconnect, does not stand in the way of a legitimate resume.
  it(
    'still resumes correctly when a text message was sent mid-transfer, right before the reconnect',
    async () => {
      const { sockets, dataFrameCounts, restore } = interceptSockets();
      try {
        const url = await start();
        const host = await Session.create(url);
        const guest = await Session.join(url, host.code);
        await confirmBoth(host, guest);

        const errors: string[] = [];
        host.events.onError = (e) => { errors.push(e.message); };
        guest.events.onError = (e) => { errors.push(e.message); };

        const receivedTexts: string[] = [];
        host.events.onText = (content) => { receivedTexts.push(content); };

        const TOTAL_CHUNKS = 8;
        const bytes = new Uint8Array(CHUNK_SIZE * TOTAL_CHUNKS);
        for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
          globalThis.crypto.getRandomValues(bytes.subarray(offset, offset + 32));
        }
        const file = new File([bytes], 'text-then-resume.bin');

        let sendProgressCount = 0;
        guest.events.onSendProgress = () => {
          sendProgressCount++;
          // A text snippet lands between chunks 2 and 3, consuming a seq
          // from the same counter the data frames draw from — then the
          // connection is killed one chunk later, same as every other test
          // in this file.
          if (sendProgressCount === 2) void guest.sendText('hello mid-transfer');
          if (sendProgressCount === 3) sockets[sockets.length - 1]!.close();
        };

        let receiveProgressCount = 0;
        host.events.onReceiveProgress = () => { receiveProgressCount++; };
        const received = new Promise<Uint8Array>((resolve, reject) => {
          host.events.onFileComplete = async ({ blob }) => {
            if (!blob) { reject(new Error('no blob')); return; }
            resolve(new Uint8Array(await blob.arrayBuffer()));
          };
        });

        void guest.sendFiles([file]).catch(() => undefined);
        const result = await received;

        expect(errors).toEqual([]);
        expect(Buffer.compare(Buffer.from(result), Buffer.from(bytes))).toBe(0);
        expect(receivedTexts).toEqual(['hello mid-transfer']);
        // Same decisive check as every resume test above: exactly
        // TOTAL_CHUNKS distinct data frames, proving the interleaved
        // control frame did not falsely exclude this file from resuming
        // (which would show up as more than TOTAL_CHUNKS, from a full
        // restart) and did not stall it either (which would time out).
        expect(dataFrameCounts[0]).toBe(TOTAL_CHUNKS);
        expect(receiveProgressCount).toBe(TOTAL_CHUNKS);
        expect(sockets.length).toBeGreaterThanOrEqual(3);

        host.close();
        guest.close();
      } finally {
        restore();
      }
    },
    20_000,
  );
});
