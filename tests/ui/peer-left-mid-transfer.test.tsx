// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateScreen } from '../../client/screens/CreateScreen.js';
import { SessionScreen } from '../../client/screens/SessionScreen.js';
import { FakeWorker, installFakeWorker } from './fake-worker.js';
import type { FileMeta } from '../../shared/messages.js';

/**
 * The exact sequence a real relay produces when a peer closes its tab while a
 * send is in flight, verified against the running server:
 *
 *   peer-left(peer-left)            → the session has ended
 *   error(message='peer-left')      → Sender.abort made sendFiles reject, and
 *                                     the worker's catch reposted the reason
 *
 * Two things must hold afterwards, on both sides. The raw protocol token must
 * never reach the user, and the second message must not drag the screen back
 * out of the terminal 'ended' state it just reached.
 */

// CreateScreen draws through the real `qrcode` package's canvas API, which
// jsdom's <canvas> does not implement — same stub the other screen suites use.
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(async () => undefined) },
  toCanvas: vi.fn(async () => undefined),
}));

const KEY = 'a'.repeat(43);
const FILES: FileMeta[] = [{ id: 1, name: 'holiday.mp4', size: 4096, type: 'video/mp4' }];

const READY = {
  t: 'ready',
  code: 'K7M3QP',
  peerId: 'a',
  shareUrl: 'https://quik.share/s/K7M3QP#thekey',
} as const;

beforeEach(() => {
  installFakeWorker();
  history.pushState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startedWorker(): Promise<FakeWorker> {
  const worker = FakeWorker.latest();
  if (!worker) throw new Error('the screen constructed no worker');
  await waitFor(() => expect(worker.last('init')).toBeDefined());
  return worker;
}

/** What the relay and the worker actually emit, in the order they emit it. */
function peerLeavesMidSend(worker: FakeWorker): void {
  act(() => worker.emit({ t: 'outgoing', files: FILES }));
  act(() => worker.emit({ t: 'send-progress', fileId: 1, bytesMoved: 1024, totalBytes: 4096, bytesPerSecond: 512 }));
  act(() => worker.emit({ t: 'peer-left', reason: 'peer-left' }));
  act(() => worker.emit({ t: 'error', message: 'peer-left' }));
}

describe('a peer leaving mid-transfer — joiner', () => {
  it('reaches the disconnect screen instead of a live-looking transfer panel', async () => {
    render(<SessionScreen code="K7M3QP" />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));

    peerLeavesMidSend(worker);

    expect(screen.getByRole('heading', { name: /other device disconnected/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^connected$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /choose files/i })).not.toBeInTheDocument();
  });

  it('never shows the user a raw protocol token', async () => {
    render(<SessionScreen code="K7M3QP" />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));

    peerLeavesMidSend(worker);

    expect(document.body.textContent).not.toContain('peer-left');
  });
});

describe('a peer leaving mid-transfer — host', () => {
  it('keeps the recovery line that says the code still works', async () => {
    render(<CreateScreen />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));
    act(() => worker.emit({ t: 'peer-joined' }));

    peerLeavesMidSend(worker);

    expect(await screen.findByText(/this code still works/i)).toBeInTheDocument();
  });

  it('never shows the user a raw protocol token', async () => {
    render(<CreateScreen />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));
    act(() => worker.emit({ t: 'peer-joined' }));

    peerLeavesMidSend(worker);

    expect(document.body.textContent).not.toContain('peer-left');
  });

  it('explains the interruption in a sentence, not a token', async () => {
    render(<CreateScreen />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));
    act(() => worker.emit({ t: 'peer-joined' }));

    peerLeavesMidSend(worker);

    expect(await screen.findByRole('alert')).toHaveTextContent(/other device disconnected/i);
  });
});

describe('a replacement peer arriving', () => {
  it('drops the stale disconnect alert instead of carrying it into the next transfer', async () => {
    render(<CreateScreen />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));
    act(() => worker.emit({ t: 'peer-joined' }));
    peerLeavesMidSend(worker);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    // The host's code still works, so someone can scan it again — and the
    // alert describing the *previous* peer's departure is stale the moment
    // they do.
    act(() => worker.emit({ t: 'peer-joined' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^connected$/i })).toBeInTheDocument();
  });
});

describe('translating transport reasons', () => {
  // The four refusals shared/signals.ts defines, which RelayTransport.connect
  // rejects with verbatim. 'not-found' is the likeliest joiner failure there
  // is — a mistyped or expired code — and it used to degrade to "the transfer
  // stopped unexpectedly", which is wrong twice over: no transfer had begun.
  it('names the refusal when the relay turns a join away', async () => {
    render(<SessionScreen code="K7M3QP" />);
    const worker = await startedWorker();

    act(() => worker.emit({ t: 'error', message: 'not-found' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/no session with that code/i);
    expect(alert.textContent).not.toContain('not-found');
    expect(alert.textContent).not.toMatch(/transfer stopped/i);
  });

  it('degrades an unrecognised raw token to a sentence rather than leaking it', async () => {
    render(<CreateScreen />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));

    act(() => worker.emit({ t: 'error', message: 'socket-closed' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('socket-closed');
    expect(alert.textContent).toMatch(/[a-z]{3,} [a-z]{3,}/i);
  });

  it('leaves a message that is already a sentence alone', async () => {
    render(<CreateScreen />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));

    act(() => worker.emit({ t: 'error', message: '"a.bin" failed its integrity check.' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/failed its integrity check/i);
  });
});
