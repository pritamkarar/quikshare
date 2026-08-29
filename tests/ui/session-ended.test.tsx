// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../client/App.js';
import { CreateScreen } from '../../client/screens/CreateScreen.js';
import { SessionScreen } from '../../client/screens/SessionScreen.js';
import { FakeWorker, installFakeWorker, passVerification } from './fake-worker.js';

/**
 * Fix-round-1, Important: a confirmed, permanent `session-ended` (from
 * Session.onSessionEnded, fired only once a Reconnector has actually given
 * up or the relay confirmed the room is gone) must land on a screen that
 * does not offer the same code/QR again — unlike a plain 'peer-left', which
 * still shows PeerLeftPanel because the room genuinely does survive that.
 */

// CreateScreen draws through the real `qrcode` package's canvas API, which
// jsdom's <canvas> does not implement — same stub the other screen suites use.
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(async () => undefined) },
  toCanvas: vi.fn(async () => undefined),
}));

const KEY = 'a'.repeat(43);
const READY = {
  t: 'ready',
  code: 'K7M3QP',
  peerId: 'a',
  shareUrl: 'https://quik.share/s/K7M3QP#thekey',
} as const;

beforeEach(() => {
  installFakeWorker();
  // jsdom implements neither half of the object-URL pair, and useSession
  // calls both: one per received Blob, and a revoke for each on teardown.
  // Only the in-memory save tier reaches this at all.
  URL.createObjectURL ??= () => 'blob:stub';
  URL.revokeObjectURL ??= () => {};
  // '/new', not '/': the root is the landing page and starts no session, so
  // the host side of these tests has to begin where a session is actually
  // created.
  history.pushState(null, '', '/new');
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

describe('a confirmed session-ended outcome — joiner (SessionScreen)', () => {
  it('reaches "This session no longer exists" for room-gone, not the disconnect-and-rescan screen', async () => {
    render(<SessionScreen code="K7M3QP" />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));

    act(() => worker.emit({ t: 'session-ended', reason: 'room-gone' }));

    expect(screen.getByRole('heading', { name: /no longer exists/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /other device disconnected/i })).not.toBeInTheDocument();
    // No QR/code re-offered: there is nothing left for it to open.
    expect(screen.queryByRole('img', { name: /scan/i })).not.toBeInTheDocument();
  });

  it('reaches "Could not reconnect" for gave-up — distinct from room-gone, since the room may still be fine', async () => {
    render(<SessionScreen code="K7M3QP" />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));

    act(() => worker.emit({ t: 'session-ended', reason: 'gave-up' }));

    expect(screen.getByRole('heading', { name: /could not reconnect/i })).toBeInTheDocument();
    // Must not claim the room itself no longer exists — that's a different,
    // stronger fact this device cannot actually confirm.
    expect(screen.queryByText(/no longer exists/i)).not.toBeInTheDocument();
  });

  it('a trailing error after session-ended does not drag the screen off the terminal state', async () => {
    render(<SessionScreen code="K7M3QP" />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));

    act(() => worker.emit({ t: 'session-ended', reason: 'room-gone' }));
    // The same disconnect surfacing a second time, e.g. an in-flight send's
    // Sender.abort rejecting after the fact.
    act(() => worker.emit({ t: 'error', message: 'socket-closed' }));

    expect(screen.getByRole('heading', { name: /no longer exists/i })).toBeInTheDocument();
  });
});

describe('a confirmed session-ended outcome — host (CreateScreen)', () => {
  it('stops showing the code once the room is confirmed gone', async () => {
    render(<CreateScreen />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));

    act(() => worker.emit({ t: 'session-ended', reason: 'room-gone' }));

    expect(screen.getByRole('heading', { name: /no longer exists/i })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /scan/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/K7M-3QP/)).not.toBeInTheDocument();
  });

  it('stops showing the code once this device gives up reconnecting', async () => {
    render(<CreateScreen />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));

    act(() => worker.emit({ t: 'session-ended', reason: 'gave-up' }));

    expect(screen.getByRole('heading', { name: /could not reconnect/i })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /scan/i })).not.toBeInTheDocument();
  });

  // Rendered through the real App, not CreateScreen directly: the dead end
  // is a routing fact. CreateScreen renders InvalidScreen inline while the
  // route is *already* '/', so navigating to '/' pushes the same route,
  // App re-renders <CreateScreen /> into the same slot, React reconciles
  // instead of remounting, useSession's mount effect never re-runs and the
  // state stays 'gone'. Spec §10 forbids dead ends, and only a manual
  // reload escaped this one.
  it('the "Start a new session" button really starts one, instead of reconciling back into the dead session', async () => {
    render(<App />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));
    act(() => worker.emit({ t: 'session-ended', reason: 'gave-up' }));
    expect(screen.getByRole('heading', { name: /could not reconnect/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /start a new session/i }));

    // A second worker really constructed is the only proof that a *session*
    // restarted; the heading alone could come back from a re-render that
    // reused the same dead one.
    expect(FakeWorker.instances).toHaveLength(2);
    expect(worker.terminated).toBe(true);
    expect(screen.getByRole('heading', { name: /scan to connect/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /could not reconnect/i })).not.toBeInTheDocument();
  });
});

/** One received file, offered then completed — the pair useSession needs to build a row. */
const HOLIDAY = { id: 1, name: 'holiday.jpg', size: 12, type: 'image/jpeg' } as const;

describe('the other device ended the session on purpose — joiner (SessionScreen)', () => {
  it('sends the joiner to the landing page instead of leaving them on the session link', async () => {
    history.pushState(null, '', '/s/K7M3QP');
    render(<SessionScreen code="K7M3QP" />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));

    act(() => worker.emit({ t: 'session-ended', reason: 'peer-ended' }));

    // Not PeerLeftPanel's rejoin QR: there is nothing to rejoin. The other
    // user chose to end this, and the room goes with them.
    await waitFor(() => expect(location.pathname).toBe('/'));
  });

  it('keeps a plain disconnect on the rejoin screen, which is still recoverable', async () => {
    history.pushState(null, '', '/s/K7M3QP');
    render(<SessionScreen code="K7M3QP" />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));

    // 'peer-left' is a dropped socket — a closed tab, a dead network, a
    // refresh. The room outlives it (server/rooms.ts), so the code is still
    // worth showing.
    act(() => worker.emit({ t: 'peer-left', reason: 'socket closed' }));

    expect(await screen.findByText(/the other device disconnected/i)).toBeInTheDocument();
    expect(location.pathname).toBe('/s/K7M3QP');
  });

  it('holds the joiner back when received files exist only in this tab', async () => {
    history.pushState(null, '', '/s/K7M3QP');
    render(<SessionScreen code="K7M3QP" />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));
    // The in-memory save tier: the file was never written anywhere, and the
    // Save link in the record is the only copy. Redirecting would destroy it.
    // The offer is what puts the row in the record; file-complete updates it.
    act(() => worker.emit({ t: 'offer', files: [HOLIDAY] }));
    act(() => worker.emit({ t: 'file-complete', meta: HOLIDAY, blob: new Blob(['x'.repeat(12)], { type: 'image/jpeg' }) }));

    act(() => worker.emit({ t: 'session-ended', reason: 'peer-ended' }));

    expect(await screen.findByText(/ended the session/i)).toBeInTheDocument();
    // Still there to be saved, and still on a screen that offers a way out.
    expect(screen.getByText('holiday.jpg')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
    expect(location.pathname).toBe('/s/K7M3QP');
  });

  it('leaves for the landing page once the held-back joiner is done', async () => {
    history.pushState(null, '', '/s/K7M3QP');
    render(<SessionScreen code="K7M3QP" />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));
    act(() => worker.emit({ t: 'offer', files: [HOLIDAY] }));
    act(() => worker.emit({ t: 'file-complete', meta: HOLIDAY, blob: new Blob(['x'.repeat(12)], { type: 'image/jpeg' }) }));
    act(() => worker.emit({ t: 'session-ended', reason: 'peer-ended' }));

    await userEvent.click(await screen.findByRole('button', { name: /done/i }));

    await waitFor(() => expect(location.pathname).toBe('/'));
  });
});

describe('ending a session from the connected screen', () => {
  it('tells the peer it was deliberate before the screen goes away', async () => {
    history.pushState(null, '', '/s/K7M3QP');
    render(<SessionScreen code="K7M3QP" />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));
    await passVerification(worker);

    await userEvent.click(await screen.findByRole('button', { name: /end session/i }));

    // The order is the point: posted while the worker is still alive, and the
    // navigation waits on the answer. Reversed, useSession's cleanup would
    // terminate the worker with the frame still queued and the peer would be
    // left on the rejoin screen.
    await waitFor(() => expect(worker.last('end-session')).toBeDefined());
    expect(location.pathname).toBe('/s/K7M3QP');

    act(() => worker.emit({ t: 'end-session-sent' }));

    await waitFor(() => expect(location.pathname).toBe('/'));
  });

  it('leaves anyway when the worker never answers', async () => {
    history.pushState(null, '', '/s/K7M3QP');
    render(<SessionScreen code="K7M3QP" />);
    const worker = await startedWorker();
    act(() => worker.emit(READY));
    await passVerification(worker);

    // Faked only from here: the setup above is real async work (a real
    // useSession, a real verification round trip) that a frozen clock would
    // simply never finish.
    vi.useFakeTimers();
    try {
      act(() => { screen.getByRole('button', { name: /end session/i }).click(); });

      // No 'end-session-sent' is ever emitted. A button whose whole job is to
      // leave must not be the thing that traps someone on the screen.
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

      expect(location.pathname).toBe('/');
    } finally {
      vi.useRealTimers();
    }
  });
});
