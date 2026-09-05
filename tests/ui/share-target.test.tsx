// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransferPanel } from '../../client/screens/TransferPanel.js';
import { CreateScreen } from '../../client/screens/CreateScreen.js';
import { stashLocal, takeLocal, takeShare } from '../../client/share/inbox.js';
import { installFakeWorker } from './fake-worker.js';
import type { SessionHandle } from '../../client/hooks/useSession.js';
import type { LiveSessionEvents } from '../../client/media/live-session.js';
import type { SharedPayload } from '../../client/share/inbox.js';

/*
 * TransferPanel builds a real `LiveSession` on mount, which reaches for
 * `RTCPeerConnection` — not implemented in jsdom at all. Mocked exactly as
 * tests/ui/transfer-panel.test.tsx mocks it, so this file can mount a real
 * component tree without touching WebRTC.
 */
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(async () => undefined) },
  toCanvas: vi.fn(async () => undefined),
}));

/*
 * Only `takeShare` is faked. The constants beside it are what CreateScreen
 * reads the query flag with, and faking those would let this suite agree
 * with itself about a flag the service worker never sets.
 */
vi.mock('../../client/share/inbox.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../client/share/inbox.js')>(),
  takeShare: vi.fn(),
}));

vi.mock('../../client/media/live-session.js', () => ({
  LiveSession: class {
    readonly peerId: 'a' | 'b';
    readonly events: LiveSessionEvents;
    start = vi.fn();
    stop = vi.fn();
    onPeerLeft = vi.fn();
    onMediaSignal = vi.fn();

    constructor(peerId: 'a' | 'b', events: LiveSessionEvents) {
      this.peerId = peerId;
      this.events = events;
    }
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Copied from tests/ui/transfer-panel.test.tsx — a fully usable paired session. */
function fakeSession(over: Partial<SessionHandle> = {}): SessionHandle {
  return {
    state: 'paired',
    code: 'K7M3QP',
    shareUrl: 'https://x.dev/s/K7M3QP',
    files: [],
    notes: [],
    error: undefined,
    endedReason: undefined,
    notice: undefined,
    transportKind: 'relay',
    peerId: 'a',
    verification: '482193',
    verifiedByMe: true,
    verifiedByPeer: true,
    confirmVerification: vi.fn(),
    endSession: vi.fn(async () => {}),
    canChooseFolder: false,
    saveFolder: undefined,
    chooseFolder: vi.fn(),
    selfDevice: undefined,
    peerDevice: undefined,
    sendFiles: vi.fn(),
    cancelFiles: vi.fn(),
    sendText: vi.fn(),
    sendMediaSignal: vi.fn(),
    onMediaSignal: vi.fn(() => () => {}),
    ...over,
  };
}

const payload = (): SharedPayload => ({
  files: [new File(['x'], 'holiday.jpg', { type: 'image/jpeg' })],
  note: 'https://e.example',
});

describe('a share waiting on the verification gate', () => {
  it('does not send before both users have confirmed the number', () => {
    const session = fakeSession({ verifiedByMe: true, verifiedByPeer: false });
    render(<TransferPanel session={session} pending={payload()} />);

    // The share sheet is not an exception to the gate: a payload staged by
    // the OS is still a send that must wait for both people.
    expect(session.sendFiles).not.toHaveBeenCalled();
    expect(session.sendText).not.toHaveBeenCalled();
  });

  it('sends the files and the note once both have', async () => {
    const session = fakeSession();
    render(<TransferPanel session={session} pending={payload()} />);

    await waitFor(() => expect(session.sendFiles).toHaveBeenCalledTimes(1));
    expect(vi.mocked(session.sendFiles).mock.calls[0]![0].map((file) => file.name))
      .toEqual(['holiday.jpg']);
    expect(session.sendText).toHaveBeenCalledWith('https://e.example');
  });

  it('sends it once, however often the panel re-renders', async () => {
    const session = fakeSession();
    const pending = payload();
    const { rerender } = render(<TransferPanel session={session} pending={pending} />);

    await waitFor(() => expect(session.sendFiles).toHaveBeenCalledTimes(1));
    rerender(<TransferPanel session={session} pending={pending} />);
    rerender(<TransferPanel session={session} pending={pending} />);

    expect(session.sendFiles).toHaveBeenCalledTimes(1);
  });

  it('tells its owner the payload is spent, so a remount cannot resend it', async () => {
    // The ref that makes the above true dies with the component, and this
    // panel is unmounted and rebuilt whenever a peer leaves and rejoins.
    const onPendingSent = vi.fn();
    const session = fakeSession();
    render(<TransferPanel session={session} pending={payload()} onPendingSent={onPendingSent} />);

    await waitFor(() => expect(onPendingSent).toHaveBeenCalledTimes(1));
  });

  it('sends nothing at all when there was no share', async () => {
    const session = fakeSession();
    render(<TransferPanel session={session} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: /share/i })).toBeInTheDocument());
    expect(session.sendFiles).not.toHaveBeenCalled();
    expect(session.sendText).not.toHaveBeenCalled();
  });

  it('sends only the files when the share carried no note', async () => {
    const session = fakeSession();
    render(<TransferPanel session={session} pending={{ files: [new File(['x'], 'a.png', { type: 'image/png' })], note: undefined }} />);

    await waitFor(() => expect(session.sendFiles).toHaveBeenCalledTimes(1));
    // An empty note is not a note; sending one would put a blank row on the
    // other device's record.
    expect(session.sendText).not.toHaveBeenCalled();
  });

  it('sends only the note when the share was a bare link', async () => {
    const session = fakeSession();
    render(<TransferPanel session={session} pending={{ files: [], note: 'https://e.example' }} />);

    await waitFor(() => expect(session.sendText).toHaveBeenCalledTimes(1));
    expect(session.sendFiles).not.toHaveBeenCalled();
  });
});

describe('landing from the share sheet', () => {
  beforeEach(() => {
    installFakeWorker();
    // CreateScreen reads `caches` only to hand it to takeShare, which is
    // faked here — but the guard in front of it is real, and jsdom has no
    // CacheStorage, so without this every test below takes the missed path.
    vi.stubGlobal('caches', {} as CacheStorage);
    vi.mocked(takeShare).mockReset();
  });

  it('claims the stash and says what is waiting', async () => {
    history.replaceState(null, '', '/new?shared=1');
    vi.mocked(takeShare).mockResolvedValue({
      files: [
        new File(['a'], 'one.jpg', { type: 'image/jpeg' }),
        new File(['b'], 'two.jpg', { type: 'image/jpeg' }),
      ],
      note: undefined,
    });

    render(<CreateScreen />);

    expect(await screen.findByText(/2 files ready/i)).toBeInTheDocument();
    // The flag has done its whole job by being read once; a reload of this
    // URL must not read as a second share of files already taken.
    expect(location.search).toBe('');
  });

  it('counts a shared link as something waiting too', async () => {
    history.replaceState(null, '', '/new?shared=1');
    vi.mocked(takeShare).mockResolvedValue({ files: [], note: 'https://e.example' });

    render(<CreateScreen />);

    expect(await screen.findByText(/1 link ready/i)).toBeInTheDocument();
  });

  it('names both when a share carried a file and a link', async () => {
    history.replaceState(null, '', '/new?shared=1');
    vi.mocked(takeShare).mockResolvedValue({
      files: [new File(['a'], 'one.jpg', { type: 'image/jpeg' })],
      note: 'https://e.example',
    });

    render(<CreateScreen />);

    expect(await screen.findByText(/1 file and 1 link ready/i)).toBeInTheDocument();
  });

  it('says so when the share never reached the app', async () => {
    history.replaceState(null, '', '/new?shared=missed');

    render(<CreateScreen />);

    // The files are unrecoverable by this point; the only useful thing left
    // to do is tell the user, so they can share again.
    expect(await screen.findByText(/did not come through/i)).toBeInTheDocument();
    expect(takeShare).not.toHaveBeenCalled();
  });

  it('says so when the stash turned out to be empty', async () => {
    history.replaceState(null, '', '/new?shared=1');
    // The worker redirected, so something was shared — an empty cache here
    // means it was evicted or the write was torn, not that nothing happened.
    vi.mocked(takeShare).mockResolvedValue(undefined);

    render(<CreateScreen />);

    expect(await screen.findByText(/did not come through/i)).toBeInTheDocument();
  });

  it('says so on a browser with no cache storage at all', async () => {
    history.replaceState(null, '', '/new?shared=1');
    // Undefined on an insecure origin — where the worker could not have run
    // either, so there was never anything to claim.
    vi.stubGlobal('caches', undefined);

    render(<CreateScreen />);

    expect(await screen.findByText(/did not come through/i)).toBeInTheDocument();
    expect(takeShare).not.toHaveBeenCalled();
  });

  it('claims nothing on an ordinary visit', () => {
    history.replaceState(null, '', '/new');

    render(<CreateScreen />);

    expect(takeShare).not.toHaveBeenCalled();
  });
});

describe('landing from the front page drop zone', () => {
  beforeEach(() => {
    installFakeWorker();
    vi.mocked(takeShare).mockReset();
  });

  it('claims the held files and says what is waiting', async () => {
    history.replaceState(null, '', '/new');
    stashLocal({
      files: [
        new File(['a'], 'one.jpg', { type: 'image/jpeg' }),
        new File(['b'], 'two.jpg', { type: 'image/jpeg' }),
      ],
      note: undefined,
    });

    render(<CreateScreen />);

    expect(await screen.findByText(/2 files ready/i)).toBeInTheDocument();
    // Held in memory, never in the Cache: the share path is not consulted.
    expect(takeShare).not.toHaveBeenCalled();
    // And taken, so a remount of this screen cannot read as a second drop.
    expect(takeLocal()).toBeUndefined();
  });
});
