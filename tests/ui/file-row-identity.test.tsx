// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateScreen } from '../../client/screens/CreateScreen.js';
import { FakeWorker, installFakeWorker, passVerification } from './fake-worker.js';
import type { FileMeta } from '../../shared/messages.js';

vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(async () => undefined) },
  toCanvas: vi.fn(async () => undefined),
}));

const READY = {
  t: 'ready',
  code: 'K7M3QP',
  peerId: 'a',
  shareUrl: 'https://quik.share/s/K7M3QP#thekey',
} as const;

/*
 * The same id on both rows is not a contrived case — it is the norm. A
 * fileId is minted by whichever `Sender` produced the file, and every Sender
 * starts its own counter at 1 (client/transfer/sender.ts's `#mintFileId`).
 * So this device's first outgoing file and the peer's first incoming one are
 * both id 1, on every session where both sides send something.
 */
const INBOUND: FileMeta = { id: 1, name: 'inbound.bin', size: 65_536, type: 'application/octet-stream' };
const OUTBOUND: FileMeta = { id: 1, name: 'outbound.bin', size: 2_097_152, type: 'application/octet-stream' };

beforeEach(() => {
  installFakeWorker();
  history.pushState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function pairedSession(): Promise<FakeWorker> {
  render(<CreateScreen />);
  const worker = FakeWorker.latest();
  if (!worker) throw new Error('the screen constructed no worker');
  await waitFor(() => expect(worker.last('init')).toBeDefined());
  act(() => worker.emit(READY));
  act(() => worker.emit({ t: 'peer-joined' }));
  await screen.findByText(/connected/i);
  // The transfer record exists only past the gate now — see passVerification.
  await passVerification(worker);
  return worker;
}

/** One row's visible text, with the formatter's non-breaking spaces normalised. */
function rowText(name: string): string {
  const row = screen.getByText(name).closest('[data-file-row]');
  if (!row) throw new Error(`no row rendered for ${name}`);
  return (row.textContent ?? '').replace(/ /g, ' ');
}

/** A finished incoming file, before this device sends anything of its own. */
async function receiveInbound(worker: FakeWorker): Promise<void> {
  act(() => worker.emit({ t: 'offer', files: [INBOUND] }));
  act(() => worker.emit({
    t: 'receive-progress', fileId: 1, bytesMoved: 65_536, totalBytes: 65_536, bytesPerSecond: 32_768,
  }));
  act(() => worker.emit({ t: 'file-complete', meta: INBOUND }));
  await screen.findByText('inbound.bin');
}

describe('a transfer row is identified by direction and id, never id alone', () => {
  it('leaves a finished incoming file alone while an outgoing file of the same id moves', async () => {
    const worker = await pairedSession();
    await receiveInbound(worker);
    // A finished row reads its size once, not "64 KB of 64 KB" — see FileRow.
    // What matters to this test is the number, whatever sentence carries it.
    expect(rowText('inbound.bin')).toContain('64 KB');

    act(() => worker.emit({ t: 'outgoing', files: [OUTBOUND] }));
    act(() => worker.emit({
      t: 'send-progress', fileId: 1, bytesMoved: 1_048_576, totalBytes: 2_097_152, bytesPerSecond: 524_288,
    }));

    // The received file is finished and 64 KB long. Its row must not start
    // counting the outgoing file's bytes just because both files are id 1 —
    // so it still reads 64 KB, and it has taken on none of the megabytes
    // crossing on the row below it.
    expect(rowText('inbound.bin')).toContain('64 KB');
    expect(rowText('inbound.bin')).not.toContain('MB');
    expect(rowText('outbound.bin')).toContain('1 MB of 2 MB');
  });

  it('leaves an in-flight incoming file alone when an outgoing file of the same id finishes', async () => {
    const worker = await pairedSession();
    act(() => worker.emit({ t: 'offer', files: [INBOUND] }));
    act(() => worker.emit({
      t: 'receive-progress', fileId: 1, bytesMoved: 16_384, totalBytes: 65_536, bytesPerSecond: 8_192,
    }));
    act(() => worker.emit({ t: 'outgoing', files: [OUTBOUND] }));
    await screen.findByText('outbound.bin');

    act(() => worker.emit({ t: 'send-file-done', fileId: 1 }));

    // Only the sent file is done. Marking the incoming one complete would
    // both jump its byte count to the full size and badge it "Received"
    // while its bytes are still arriving.
    expect(rowText('inbound.bin')).toContain('16 KB of 64 KB');
    expect(rowText('inbound.bin')).not.toContain('Received');
    expect(rowText('outbound.bin')).toContain('Sent');
  });

  it('completes only the incoming file when it lands, not the outgoing one sharing its id', async () => {
    const worker = await pairedSession();
    act(() => worker.emit({ t: 'outgoing', files: [OUTBOUND] }));
    act(() => worker.emit({
      t: 'send-progress', fileId: 1, bytesMoved: 1_048_576, totalBytes: 2_097_152, bytesPerSecond: 524_288,
    }));
    act(() => worker.emit({ t: 'offer', files: [INBOUND] }));
    await screen.findByText('inbound.bin');

    act(() => worker.emit({ t: 'file-complete', meta: INBOUND }));

    expect(rowText('inbound.bin')).toContain('Received');
    expect(rowText('outbound.bin')).toContain('1 MB of 2 MB');
    expect(rowText('outbound.bin')).not.toContain('Sent');
  });
});
