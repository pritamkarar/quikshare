// @vitest-environment jsdom
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QRPanel } from '../../client/ui/QRPanel.js';
import { CreateScreen } from '../../client/screens/CreateScreen.js';
import { useSession } from '../../client/hooks/useSession.js';
import { FakeWorker, installFakeWorker, passVerification } from './fake-worker.js';

vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(async () => undefined) },
  toCanvas: vi.fn(async () => undefined),
}));

describe('QRPanel', () => {
  it('renders the code as readable text alongside the QR', async () => {
    render(<QRPanel shareUrl="https://x.dev/s/K7M3QP#key" code="K7M3QP" />);
    await waitFor(() => expect(screen.getByText(/K7M-3QP/)).toBeInTheDocument());
  });

  it('marks the code as untranslatable so it cannot be garbled', async () => {
    render(<QRPanel shareUrl="https://x.dev/s/K7M3QP#key" code="K7M3QP" />);
    await waitFor(() => expect(screen.getByText(/K7M-3QP/)).toHaveAttribute('translate', 'no'));
  });

  it('gives the QR canvas an accessible description', async () => {
    render(<QRPanel shareUrl="https://x.dev/s/K7M3QP#key" code="K7M3QP" />);
    await waitFor(() => expect(screen.getByLabelText(/scan/i)).toBeInTheDocument());
  });

  it('never sends the URL anywhere to build the QR', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<QRPanel shareUrl="https://x.dev/s/K7M3QP#key" code="K7M3QP" />);
    await waitFor(() => expect(screen.getByText(/K7M-3QP/)).toBeInTheDocument());
    // The fragment holds the encryption key. Asking a server to draw this
    // would hand over the very secret the fragment exists to keep off the wire.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reserves the final QR size so nothing shifts when it draws', async () => {
    render(<QRPanel shareUrl="https://x.dev/s/K7M3QP#key" code="K7M3QP" />);
    const canvas = await screen.findByLabelText(/scan/i);
    expect(canvas).toHaveAttribute('width');
    expect(canvas).toHaveAttribute('height');
  });
});

const SELF_DEVICE = {
  id: 'a1b2-c3d4-e5f6', kind: 'desktop' as const, os: 'macOS', browser: 'Safari',
  ip: '192.0.2.10', screen: '2560 × 1440',
};
const PEER_DEVICE = {
  id: '9f8e-7d6c-5b4a', kind: 'mobile' as const, os: 'Android', browser: 'Chrome',
  ip: '198.51.100.7', screen: '412 × 915',
};

const READY = {
  t: 'ready',
  code: 'K7M3QP',
  peerId: 'a',
  shareUrl: 'https://quik.share/s/K7M3QP#thekey',
} as const;

/** Renders the screen and waits for its worker to be initialised. */
async function startSession(): Promise<{ worker: FakeWorker; unmount: () => void }> {
  const { unmount } = render(<CreateScreen />);
  const worker = FakeWorker.latest();
  if (!worker) throw new Error('the screen constructed no worker');
  await waitFor(() => expect(worker.last('init')).toBeDefined());
  return { worker, unmount };
}

describe('CreateScreen', () => {
  beforeEach(() => {
    installFakeWorker();
    history.pushState(null, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts the session in a worker, telling it how this page can save', async () => {
    const { worker } = await startSession();

    // Detected on the page, where the probes actually work: this realm has the
    // picker and the document that two of the three tiers need.
    expect(worker.last('init')).toMatchObject({
      intent: { t: 'create' },
      saveCapability: 'blob',
    });
    expect(worker.last('init')?.wsUrl).toMatch(/^wss?:\/\/.+\/ws$/);
    expect(worker.options?.type).toBe('module');
  });

  it('does not force the relay by default', async () => {
    const { worker } = await startSession();
    expect(worker.last('init')?.forceTransport).toBeUndefined();
  });

  it('forwards the forceTransport escape hatch from the URL to the worker', async () => {
    // Session runs inside the worker, whose own location.href is the worker
    // SCRIPT's URL, not the page's — so the page has to read this and hand
    // it across in the init message, or the escape hatch can never engage.
    history.pushState(null, '', '/?forceTransport=relay');
    const { worker } = await startSession();
    expect(worker.last('init')?.forceTransport).toBe('relay');
  });

  /**
   * The worker cannot answer this for itself — RTCPeerConnection is
   * [Exposed=Window] — so the page has to detect it and hand it across, or
   * `Session.#webrtc.available` is always false and the upgrade can never
   * run. jsdom (the default test environment here) defines no
   * RTCPeerConnection at all, which doubles as the "worker asked itself"
   * regression case: without the page-side detection this would also read
   * false, and the test would pass for the wrong reason — the stubbed-true
   * case below is what actually distinguishes the two.
   */
  it('tells the worker whether this page can host WebRTC', async () => {
    const { worker } = await startSession();
    expect(worker.last('init')?.webrtcAvailable).toBe(false);
  });

  it('reports availability true once RTCPeerConnection actually exists in this realm', async () => {
    vi.stubGlobal('RTCPeerConnection', class {} as unknown as typeof RTCPeerConnection);
    const { worker } = await startSession();
    expect(worker.last('init')?.webrtcAvailable).toBe(true);
  });

  it('shows a waiting state before the session is ready, with no dead end', async () => {
    await startSession();

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/starting a session…/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /join a session/i })).toBeInTheDocument();
  });

  it('shows the code and the QR once the session is ready', async () => {
    const { worker } = await startSession();

    act(() => worker.emit(READY));

    expect(await screen.findByText('K7M-3QP')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /scan this qr code/i })).toBeInTheDocument();
    expect(screen.getByText(/waiting for the other device/i)).toBeInTheDocument();
  });

  it('puts the code in the document title', async () => {
    const { worker } = await startSession();

    act(() => worker.emit(READY));

    await waitFor(() => expect(document.title).toContain('K7M3QP'));
  });

  it('copies the share link and confirms it', async () => {
    const user = userEvent.setup();
    const { worker } = await startSession();
    act(() => worker.emit(READY));

    await user.click(await screen.findByRole('button', { name: /copy link/i }));

    expect(await navigator.clipboard.readText()).toBe(READY.shareUrl);
    // Confirmed visibly and announced, rather than a click that appears to do
    // nothing at all.
    expect(await screen.findByRole('button', { name: /link copied/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/copied/i);
  });

  it('shows the transfer panel once the other device joins', async () => {
    const { worker } = await startSession();
    act(() => worker.emit(READY));

    act(() => worker.emit({ t: 'peer-joined' }));

    expect(await screen.findByText(/connected/i)).toBeInTheDocument();
  });

  it('shows a per-file error while paired, instead of the one state that used to display none', async () => {
    const { worker } = await startSession();
    act(() => worker.emit(READY));
    act(() => worker.emit({ t: 'peer-joined' }));
    await screen.findByText(/connected/i);

    act(() => worker.emit({ t: 'error', fileId: 3, message: '"a.bin" failed its integrity check.' }));

    // Every per-file error used to reach this exact state and vanish: the
    // paired placeholder rendered neither error, notice, nor a way out.
    expect(await screen.findByRole('alert')).toHaveTextContent(/integrity check/i);
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
  });

  it('still offers a way out of the paired view, unlike the placeholder it replaced', async () => {
    const { worker } = await startSession();
    act(() => worker.emit(READY));
    act(() => worker.emit({ t: 'peer-joined' }));

    await screen.findByText(/connected/i);
    expect(screen.getByRole('button', { name: /end session/i })).toBeInTheDocument();
    // And only that one: the join link belongs on the screens still waiting
    // to pair, where it replaced the QR. Once paired there is nothing left
    // to join, and offering it here reads as a second, contradictory exit.
    expect(screen.queryByRole('link', { name: /join a session/i })).not.toBeInTheDocument();
  });

  /*
   * The whole point of the device panel: telling one of your own devices
   * from another. The self card is filled from the relay's own answer (which
   * only the server can supply), the peer card from a sealed control frame.
   */
  it('shows both devices once each side has described itself', async () => {
    const { worker } = await startSession();
    act(() => worker.emit({ ...READY, device: SELF_DEVICE }));
    act(() => worker.emit({ t: 'peer-joined' }));
    act(() => worker.emit({ t: 'peer-device', info: PEER_DEVICE }));
    await screen.findByText(/connected/i);
    // The device panel is past the gate now, with Share and Transfers.
    await passVerification(worker);

    expect(screen.getByText('Safari on macOS')).toBeInTheDocument();
    expect(screen.getByText('a1b2-c3d4-e5f6')).toBeInTheDocument();
    expect(screen.getByText('Chrome on Android')).toBeInTheDocument();
    expect(screen.getByText('9f8e-7d6c-5b4a')).toBeInTheDocument();
  });

  /*
   * A replacement peer has never described itself, and the description on
   * screen belongs to the device that left. Left standing, the panel would
   * attribute the departed device's id and address to whoever just arrived
   * -- a card that is not merely stale but wrong about who is in the room.
   */
  it('does not attribute the departed device details to a replacement peer', async () => {
    const { worker } = await startSession();
    act(() => worker.emit({ ...READY, device: SELF_DEVICE }));
    act(() => worker.emit({ t: 'peer-joined' }));
    act(() => worker.emit({ t: 'peer-device', info: PEER_DEVICE }));
    await passVerification(worker);
    await screen.findByText('9f8e-7d6c-5b4a');

    act(() => worker.emit({ t: 'peer-left', reason: 'peer-left' }));
    act(() => worker.emit({ t: 'peer-joined' }));
    await screen.findByText(/connected/i);

    expect(screen.queryByText('9f8e-7d6c-5b4a')).not.toBeInTheDocument();
    expect(screen.getByText(/waiting for the other device/i)).toBeInTheDocument();
    // The self card is unaffected: this device did not go anywhere.
    expect(screen.getByText('a1b2-c3d4-e5f6')).toBeInTheDocument();
  });

  /*
   * A later `self-device` message must reach the card, not just the first
   * one. Asserted on the screen size rather than the address it used to
   * use, because the address is no longer rendered anywhere — the update
   * path being tested is the same one either way, and dropping the test
   * with the row would have left it unguarded.
   */
  it('follows this device description when a mid-session update changes it', async () => {
    const { worker } = await startSession();
    act(() => worker.emit({ ...READY, device: SELF_DEVICE }));
    act(() => worker.emit({ t: 'peer-joined' }));
    await passVerification(worker);
    await screen.findByText('2560 × 1440');

    act(() => worker.emit({ t: 'self-device', info: { ...SELF_DEVICE, screen: '1920 × 1080' } }));
    expect(await screen.findByText('1920 × 1080')).toBeInTheDocument();
    expect(screen.queryByText('2560 × 1440')).not.toBeInTheDocument();
  });

  it('tells the worker what this device is, so the peer can be told in turn', async () => {
    const { worker } = await startSession();
    // The detection itself lives on the page because a worker has neither
    // `screen` nor `localStorage` — so the init message is where it has to
    // appear, and its absence would be silent.
    expect(worker.last('init')?.device).toMatchObject({ id: expect.any(String) });
  });

  it('completes an earlier file in a multi-file batch without waiting for the rest', async () => {
    const { worker } = await startSession();
    act(() => worker.emit(READY));
    act(() => worker.emit({ t: 'peer-joined' }));
    await screen.findByText(/connected/i);
    await passVerification(worker);

    const files = [
      { id: 1, name: 'first.bin', size: 100, type: '' },
      { id: 2, name: 'second.bin', size: 100, type: '' },
    ];
    // Announced as soon as the batch starts, not once it finishes — see
    // Sender.onFilesQueued.
    act(() => worker.emit({ t: 'outgoing', files }));
    act(() => worker.emit({ t: 'send-progress', fileId: 1, bytesMoved: 100, totalBytes: 100, bytesPerSecond: 1000 }));
    act(() => worker.emit({ t: 'send-file-done', fileId: 1 }));
    act(() => worker.emit({ t: 'send-progress', fileId: 2, bytesMoved: 40, totalBytes: 100, bytesPerSecond: 1000 }));

    // The first file reads as sent while the second is still moving — not a
    // row stuck just short of complete until the whole batch resolves.
    // Case-sensitive: TransferRecord (Task 6) also renders a lowercase
    // "sent" filter chip that a case-insensitive /^sent$/i would match
    // instead of, or as well as, the row's own capitalized "Sent" badge.
    expect(await screen.findByText(/^Sent$/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: /second\.bin/i })).toBeInTheDocument();
  });

  it('reports a session-level failure and still offers a way forward', async () => {
    const { worker } = await startSession();

    act(() => worker.emit({ t: 'error', message: 'The relay refused the connection.' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/relay refused/i);
    expect(screen.getByRole('link', { name: /join a session/i })).toBeInTheDocument();
  });

  it('does not tear the session down because one file failed', async () => {
    const { worker } = await startSession();
    act(() => worker.emit(READY));

    act(() => worker.emit({ t: 'error', fileId: 3, message: '"a.bin" failed its integrity check.' }));

    // The file is reported, but the session it belongs to is still live.
    expect(await screen.findByRole('alert')).toHaveTextContent(/integrity check/i);
    expect(screen.getByText('K7M-3QP')).toBeInTheDocument();
  });

  it('shows a downgraded save tier as information, not as an alarm', async () => {
    // Make this jsdom look like a browser whose best tier is the streaming
    // one, and then deny it: the tier is downgraded before anything is
    // advertised, and the user is owed the reason for the lower ceiling.
    vi.stubGlobal('ReadableStream', class {});
    vi.stubGlobal('MessageChannel', class {
      port1 = { postMessage: (): void => undefined, close: (): void => undefined };
      port2 = { close: (): void => undefined };
    });
    vi.stubGlobal('navigator', {
      serviceWorker: { register: () => Promise.reject(new Error('blocked by policy')) },
    });

    const { worker } = await startSession();

    expect(worker.last('init')?.saveCapability).toBe('blob');
    const notice = await screen.findByText(/held in memory/i);
    expect(notice).toHaveTextContent(/blocked by policy/);
    // A downgrade is not a failure, and must not clobber or be clobbered by
    // the session's real errors.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the code on screen when the session fails after it was created', async () => {
    const { worker } = await startSession();
    act(() => worker.emit(READY));

    act(() => worker.emit({ t: 'error', message: 'The relay dropped the connection.' }));

    // The session plainly *was* started, and this code still works — telling
    // the user otherwise over a blank skeleton would throw that away.
    expect(await screen.findByText('K7M-3QP')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /scan this qr code/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument();
    expect(screen.queryByText(/could not be started/i)).not.toBeInTheDocument();
  });

  it('builds the save sink on the page when the worker asks for one', async () => {
    const { worker } = await startSession();
    const meta = { id: 1, name: 'a.bin', size: 5, type: 'text/plain' };

    act(() => worker.emit({ t: 'sink-open', id: 1, fileId: 1, meta }));
    await waitFor(() => expect(worker.last('sink-result')).toMatchObject({ id: 1, ok: true }));

    act(() => worker.emit({ t: 'sink-write', id: 2, fileId: 1, chunk: new Uint8Array([104, 105]) }));
    await waitFor(() => expect(worker.last('sink-result')).toMatchObject({ id: 2, ok: true }));

    act(() => worker.emit({ t: 'sink-close', id: 3, fileId: 1 }));
    await waitFor(() => expect(worker.last('sink-result')).toMatchObject({ id: 3, ok: true }));
    // The in-memory tier's blob comes back across the boundary, because a Blob
    // is structured-cloneable and a FileSystemWritableFileStream is not.
    const closed = worker.last('sink-result');
    expect(closed?.ok === true && closed.blob).toBeInstanceOf(Blob);
  });

  it('closes the session and terminates the worker when the screen goes away', async () => {
    const { worker, unmount } = await startSession();

    unmount();

    expect(worker.last('close')).toBeDefined();
    expect(worker.terminated).toBe(true);
  });

  it('refuses to open a sink for a session that has gone away', async () => {
    const { worker, unmount } = await startSession();

    unmount();
    act(() => worker.emit({
      t: 'sink-open', id: 9, fileId: 1, meta: { id: 1, name: 'a.bin', size: 1, type: '' },
    }));

    // Proves teardown reached the page's sink host: anything it was still
    // holding open has been aborted, and it will not open more.
    await waitFor(() => expect(worker.last('sink-result')).toMatchObject({ id: 9, ok: false }));
  });

  /**
   * A minimal, self-contained stand-in for the real RTCPeerConnection /
   * RTCDataChannel pair — the same shape tests/unit/session-upgrade-guard.test.ts
   * uses — just enough for `createLocalUpgradeTransport`'s offer path
   * (client/transport/upgrade.ts) to run for real: create a data channel,
   * negotiate, and open. `useSession` builds its `createPeerHost` with no
   * `createTransport` override, so this exercises the real page-side
   * transport rather than a fake one, which is the only way to prove
   * `peerHost.handle(msg)` is actually wired into the worker's message
   * stream rather than merely present in the file.
   */
  class FakeEventTarget {
    #listeners = new Map<string, Set<(event?: unknown) => void>>();
    addEventListener(type: string, cb: (event?: unknown) => void): void {
      let set = this.#listeners.get(type);
      if (!set) { set = new Set(); this.#listeners.set(type, set); }
      set.add(cb);
    }
    emit(type: string, event: unknown = {}): void {
      for (const cb of [...(this.#listeners.get(type) ?? [])]) cb(event);
    }
  }
  class FakeChannel extends FakeEventTarget {
    readyState: 'connecting' | 'open' | 'closed' = 'connecting';
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    binaryType = 'blob';
    send(): void { /* not exercised */ }
    close(): void { this.readyState = 'closed'; }
    open(): void { this.readyState = 'open'; this.emit('open'); }
  }
  class FakePeerConnection extends FakeEventTarget {
    channel = new FakeChannel();
    connectionState = 'new';
    createDataChannel(): FakeChannel { return this.channel; }
    async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'sdp' }; }
    async setLocalDescription(): Promise<void> { /* no-op fake */ }
    close(): void { /* not exercised */ }
  }

  it("answers the worker's peer-open request with a real page-side connection", async () => {
    const peers: FakePeerConnection[] = [];
    class Tracked extends FakePeerConnection { constructor() { super(); peers.push(this); } }
    vi.stubGlobal('RTCPeerConnection', Tracked as unknown as typeof RTCPeerConnection);

    const { worker } = await startSession();

    act(() => worker.emit({ t: 'peer-open', id: 1, isOfferer: true }));
    await waitFor(() => expect(peers).toHaveLength(1));
    act(() => worker.emit({ t: 'peer-wait-open', id: 1, timeoutMs: 5000 }));
    // The real WebRTCTransport's whenOpen resolves off the data channel's
    // own 'open' event — nothing here fakes PeerHost's internals.
    act(() => peers[0]!.channel.open());

    await waitFor(() => expect(worker.posted.some((m) => m.t === 'peer-opened')).toBe(true));
    expect(worker.last('peer-opened')).toMatchObject({ id: 1, ok: true });
  });

  it('stamps files and notes with one shared arrival order', async () => {
    const { worker } = await startSession();
    act(() => worker.emit({ ...READY, device: SELF_DEVICE }));
    act(() => worker.emit({ t: 'peer-joined' }));
    await screen.findByText(/connected/i);
    await passVerification(worker);

    // A note arriving between two files is the case a per-kind counter gets
    // wrong: file ids and note positions each count from their own zero, so
    // only a shared ordinal can say which of a file and a note came first.
    act(() => worker.emit({ t: 'outgoing', files: [{ id: 1, name: 'first.bin', size: 10, type: '' }] }));
    act(() => worker.emit({ t: 'text', content: 'a received note' }));
    act(() => worker.emit({ t: 'text-sent', content: 'a sent note' }));
    act(() => worker.emit({ t: 'offer', files: [{ id: 2, name: 'second.bin', size: 10, type: '' }] }));

    // Only what genuinely renders at this point. The `texts` -> `notes`
    // migration must not lose received notes or files — that is what this
    // asserts. A sent note is not asserted on here (this test predates
    // TransferRecord being wired into TransferPanel, which is what now
    // renders both directions — see Task 6); sent-note tracking is proven
    // at the worker boundary by Task 1, and its rendering by
    // transfer-record.test.tsx's own ordering test.
    expect(screen.getByText('a received note')).toBeInTheDocument();
    expect(screen.getByText('first.bin')).toBeInTheDocument();
    expect(screen.getByText('second.bin')).toBeInTheDocument();
  });
});

/*
 * The DOM test above ('stamps files and notes with one shared arrival
 * order') stays as a migration regression guard: it proves the `texts` ->
 * `notes` rename did not lose a received note or either file from what
 * actually renders. It does not touch this task's only new behaviour —
 * `seq` stamping and sent-note recording — because it was already green
 * before this task's hook changes landed (the DOM surfaces it exercises
 * predate this task). Coverage for the new behaviour belongs here instead,
 * against the hook's own state directly, with no DOM and no dependency on
 * TransferRecord (Task 5).
 */
describe('useSession: notes and file ordinals', () => {
  beforeEach(() => {
    installFakeWorker();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stamps files and notes from one shared, monotonically increasing counter', async () => {
    const { result } = renderHook(() => useSession({ t: 'create' }));
    const worker = FakeWorker.latest();
    if (!worker) throw new Error('the hook constructed no worker');
    await waitFor(() => expect(worker.last('init')).toBeDefined());

    // The same interleave as the DOM test above: a note arriving between two
    // files is the case a per-kind counter gets wrong, since file ids and
    // note positions each count from their own zero.
    act(() => worker.emit({ t: 'outgoing', files: [{ id: 1, name: 'first.bin', size: 10, type: '' }] }));
    act(() => worker.emit({ t: 'text', content: 'a received note' }));
    act(() => worker.emit({ t: 'text-sent', content: 'a sent note' }));
    act(() => worker.emit({ t: 'offer', files: [{ id: 2, name: 'second.bin', size: 10, type: '' }] }));

    // The two files must not be 1 and 2 (their own per-kind position) --
    // they must be 1 and 4, the ordinals of a counter shared with the two
    // notes that were stamped in between.
    expect(result.current.files.map((f) => f.seq)).toEqual([1, 4]);

    // Both directions are recorded -- including the sent note, which the DOM
    // test above does not assert on (see the comment there).
    expect(result.current.notes.map(({ seq, direction, content }) => ({ seq, direction, content }))).toEqual([
      { seq: 2, direction: 'receive', content: 'a received note' },
      { seq: 3, direction: 'send', content: 'a sent note' },
    ]);

    // The note ordinals fall strictly between the two file ordinals -- the
    // property a shared counter guarantees and a pair of independent,
    // per-kind counters cannot.
    const fileSeqs = result.current.files.map((f) => f.seq);
    const noteSeqs = result.current.notes.map((n) => n.seq);
    expect(Math.min(...noteSeqs)).toBeGreaterThan(Math.min(...fileSeqs));
    expect(Math.max(...noteSeqs)).toBeLessThan(Math.max(...fileSeqs));
  });
});
