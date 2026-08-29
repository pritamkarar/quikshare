import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket as NodeWebSocket } from 'ws';
import { buildServer } from '../../server/index.js';
import { Session } from '../../client/session.js';
import { confirmBoth, waitFor } from '../pairing.js';
import { CHUNK_SIZE } from '../../client/transfer/sender.js';

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
 * Big enough that the transfer is unambiguously still running when the
 * cancel lands — a file that fits in one or two chunks can finish inside the
 * window between deciding to cancel and the frame arriving, which would make
 * these tests pass for the wrong reason.
 */
const BIG = new Uint8Array(CHUNK_SIZE * 40);

/** Two paired, mutually verified sessions over a real relay. */
async function pairedSessions(): Promise<{ host: Session; guest: Session }> {
  const url = await start();
  const host = await Session.create(url);
  const guest = await Session.join(url, host.code);
  await confirmBoth(host, guest);
  return { host, guest };
}

describe('cancelling a transfer', () => {
  it('lets the receiving side stop a file the sender is still pushing', async () => {
    const { host, guest } = await pairedSessions();
    const hostCancelled = vi.fn();
    const guestCancelled = vi.fn();
    host.events.onFileCancelled = hostCancelled;
    guest.events.onFileCancelled = guestCancelled;
    const completed = vi.fn();
    guest.events.onFileComplete = completed;

    let offered: number | undefined;
    guest.events.onOffer = (files) => { offered = files[0]?.id; };

    const sending = host.sendFiles([new File([BIG], 'big.bin')]).catch(() => undefined);
    await waitFor(() => offered !== undefined);

    // The receiver's own decision, about a file it never asked for. The id
    // is the SENDER's, which is what the guest was offered.
    await guest.cancelFiles('receive', [offered!]);
    await sending;

    // Both halves stop: the guest discarded what it had, and the frame
    // reached the host's Sender, which dropped the file from its loop.
    await waitFor(() => guestCancelled.mock.calls.length === 1);
    await waitFor(() => hostCancelled.mock.calls.length === 1);
    expect(guestCancelled).toHaveBeenCalledWith({ fileId: offered, direction: 'receive' });
    expect(hostCancelled).toHaveBeenCalledWith({ fileId: offered, direction: 'send' });
    // Never completed on either side, which is the difference between a
    // cancel and a transfer that merely ended.
    expect(completed).not.toHaveBeenCalled();
  }, 20_000);

  it('lets the sending side stop a file the receiver is still taking', async () => {
    const { host, guest } = await pairedSessions();
    const hostCancelled = vi.fn();
    const guestCancelled = vi.fn();
    host.events.onFileCancelled = hostCancelled;
    guest.events.onFileCancelled = guestCancelled;
    const completed = vi.fn();
    guest.events.onFileComplete = completed;
    const guestErrors = vi.fn();
    guest.events.onError = guestErrors;

    let sent: number | undefined;
    host.events.onOutgoing = (files) => { sent = files[0]?.id; };

    const sending = host.sendFiles([new File([BIG], 'big.bin')]).catch(() => undefined);
    await waitFor(() => sent !== undefined);

    await host.cancelFiles('send', [sent!]);
    await sending;

    await waitFor(() => hostCancelled.mock.calls.length === 1);
    await waitFor(() => guestCancelled.mock.calls.length === 1);
    expect(completed).not.toHaveBeenCalled();
    // Chunks already on the wire when the cancel went out must be dropped
    // quietly, not reported once each as data for an unknown file.
    expect(guestErrors).not.toHaveBeenCalled();
  }, 20_000);

  it('stops only the file named, leaving the rest of the batch to finish', async () => {
    const { host, guest } = await pairedSessions();
    const done: string[] = [];
    guest.events.onFileComplete = ({ meta }) => { done.push(meta.name); };
    const cancelled = vi.fn();
    guest.events.onFileCancelled = cancelled;

    let ids: number[] = [];
    host.events.onOutgoing = (files) => { ids = files.map((f) => f.id); };

    const sending = host.sendFiles([
      new File([BIG], 'big.bin'),
      new File([new Uint8Array([1, 2, 3])], 'small.bin'),
    ]).catch(() => undefined);
    await waitFor(() => ids.length === 2);

    await host.cancelFiles('send', [ids[0]!]);
    await sending;

    await waitFor(() => done.length === 1, 10_000);
    expect(done).toEqual(['small.bin']);
    await waitFor(() => cancelled.mock.calls.length === 1);
  }, 20_000);

  /*
   * Ruling F. `side` and `fileIds` arrive through decodeControl, which is a
   * bare `JSON.parse(...) as ControlMessage`: the peer holds the same key, so
   * AEAD proves only that the RELAY did not write this, never that the
   * contents are well formed or that the ids belong to anything.
   */
  it('ignores a cancel naming files this device never queued for sending', async () => {
    const { host, guest } = await pairedSessions();
    const cancelled = vi.fn();
    host.events.onFileCancelled = cancelled;
    const completed = vi.fn();
    guest.events.onFileComplete = completed;

    let sent: number | undefined;
    host.events.onOutgoing = (files) => { sent = files[0]?.id; };
    const sending = host.sendFiles([new File([BIG], 'big.bin')]).catch(() => undefined);
    await waitFor(() => sent !== undefined);

    // A well-formed frame naming an id the host is not sending. Nothing to
    // act on — and, critically, it must not take out the real transfer that
    // happens to be running beside it.
    await guest.cancelFiles('receive', [sent! + 5000]);
    await sending;

    await waitFor(() => completed.mock.calls.length === 1, 15_000);
    expect(cancelled).not.toHaveBeenCalled();
  }, 25_000);

  /*
   * The bite in that validation, and the reason it is not merely tidy.
   *
   * fileIds are minted from a counter that starts at 1, so the ids this
   * device will use for its NEXT sends are entirely predictable. A cancel
   * that was applied without checking would let a peer pre-cancel a run of
   * them before they exist — and every file the user sent afterwards would
   * be dropped from the send loop, silently, for the rest of the session.
   * Checking each id against the files this side has actually queued is what
   * makes that unreachable: at the moment the frame lands, none of them are
   * in the map.
   */
  it('cannot be used to pre-cancel files this device has not sent yet', async () => {
    const { host, guest } = await pairedSessions();
    const cancelled = vi.fn();
    host.events.onFileCancelled = cancelled;
    const completed = vi.fn();
    guest.events.onFileComplete = completed;

    // Every id the host's counter is about to hand out, named before it has
    // handed out any of them.
    await guest.cancelFiles('receive', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Landed and been dealt with before the send starts, so this is testing
    // the validation rather than a race the send happens to win.
    await new Promise((r) => setTimeout(r, 100));

    await host.sendFiles([new File([new Uint8Array([1, 2, 3])], 'after.bin')]);

    await waitFor(() => completed.mock.calls.length === 1, 10_000);
    expect(completed.mock.calls[0]?.[0]?.meta?.name).toBe('after.bin');
    expect(cancelled).not.toHaveBeenCalled();
  }, 20_000);
});
