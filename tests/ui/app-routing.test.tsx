// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../client/App.js';
import { FakeWorker, installFakeWorker } from './fake-worker.js';

// PeerLeftPanel (reached once the other device disconnects) renders QRPanel,
// which draws through the real `qrcode` package's canvas API — jsdom's
// <canvas> does not implement it (same stub create-screen.test.tsx uses).
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(async () => undefined) },
  toCanvas: vi.fn(async () => undefined),
}));


// Every test starts from a clean slate: App reads the ROUTE from
// `location.href` at mount time, so the URL has to be set before each render
// rather than after.
beforeEach(() => {
  // The create screen starts a real session, and jsdom implements no Worker.
  installFakeWorker();
  history.pushState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  /*
   * The header is chrome, not a screen: it must be there on every route,
   * including the ones a session can fail into, and it must sit OUTSIDE the
   * <main> the skip link targets so a keyboard user can jump past it.
   */
  it('puts the header on every route, outside the main landmark', () => {
    for (const path of ['/', '/new', '/join', '/s/K7M3QP', '/s/not-a-code']) {
      history.pushState(null, '', path);
      const { unmount } = render(<App />);
      const banner = screen.getByRole('banner');
      expect(within(banner).getByRole('link', { name: /quik share/i })).toBeInTheDocument();
      expect(within(banner).getByRole('link', { name: /github/i })).toBeInTheDocument();
      expect(screen.getByRole('main').contains(banner)).toBe(false);
      unmount();
    }
  });

  /*
   * The canonical URL is the same job as <title> — the head describing the
   * current context — and it is what stops '/join', '/join/' and
   * '/s/CODE?filter=images' being read as separate pages of duplicated
   * content. The tag itself ships in client/index.html; jsdom renders into a
   * bare document, so it has to be put back before App can update it.
   */
  it('points the canonical link at the current route, without a query or a trailing slash', () => {
    const link = document.createElement('link');
    link.rel = 'canonical';
    document.head.append(link);

    const cases = [
      ['/', 'https://quikshare.qd.je/'],
      ['/join/', 'https://quikshare.qd.je/join'],
      ['/s/K7M3QP?filter=images', 'https://quikshare.qd.je/s/K7M3QP'],
    ] as const;

    for (const [path, expected] of cases) {
      history.pushState(null, '', path);
      const { unmount } = render(<App />);
      expect(link.href).toBe(expected);
      unmount();
    }

    link.remove();
  });

  it('renders the landing screen at the root, inside a main landmark', () => {
    render(<App />);
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    // getAllBy, not getBy: the landing page offers both actions twice, in the
    // hero and again in the band that closes the page.
    expect(screen.getAllByRole('button', { name: /start transfer/i })).not.toHaveLength(0);
  });

  /*
   * The root must start nothing. CreateScreen allocates a room the moment it
   * mounts, so while it lived at '/' every page load — every refresh, every
   * crawler — consumed a room code and a create rate-limit slot for a session
   * nobody asked for. Asserting on the worker is what makes this real: a
   * landing screen that still mounted the session would pass a
   * heading-only check.
   */
  it('starts no session at the root', () => {
    render(<App />);
    expect(FakeWorker.latest()).toBeUndefined();
  });

  it('renders the create screen at /new', () => {
    history.pushState(null, '', '/new');
    render(<App />);
    expect(screen.getByRole('heading', { name: /scan to connect/i })).toBeInTheDocument();
  });

  it('creates a session from the landing screen only when asked', async () => {
    render(<App />);
    expect(FakeWorker.latest()).toBeUndefined();
    await userEvent.click(screen.getAllByRole('button', { name: /start transfer/i })[0]!);
    expect(screen.getByRole('heading', { name: /scan to connect/i })).toBeInTheDocument();
    await waitFor(() => expect(FakeWorker.latest()?.last('init')).toBeDefined());
  });

  it('renders the join screen at /join', () => {
    history.pushState(null, '', '/join');
    render(<App />);
    expect(screen.getByRole('heading', { name: /join a session/i })).toBeInTheDocument();
    // Task 9's guaranteed path: manual entry is present even though jsdom
    // has no camera and useQRScanner's initial status is 'idle'.
    expect(screen.getByLabelText(/session code/i)).toBeInTheDocument();
  });

  it('renders the session screen for a URL that is nothing but a code', async () => {
    history.pushState(null, '', '/s/K7M3QP');
    render(<App />);
    // The screen renders the parsed code immediately (it needs no reply from
    // the session to know it) — proving the route's code reached it.
    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
    expect(screen.getByText('K7M3QP')).toBeInTheDocument();
    // And that the code alone is what the worker was told to join with,
    // which is the whole point of the key agreement: no fragment required.
    const worker = FakeWorker.latest();
    await waitFor(() => expect(worker?.last('init')).toBeDefined());
    expect(worker?.last('init')).toMatchObject({ intent: { t: 'join', code: 'K7M3QP' } });
  });

  /*
   * The verification gate, end to end through the page's own plumbing: the
   * worker announces a number, the user confirms it, the worker is told, and
   * only a confirmation from BOTH ends opens the send controls. The gate is
   * enforced in `Session` itself (client/session.ts's `#requireVerified`);
   * this is the half a user actually touches.
   */
  it('gates the send controls behind the verification number, in both directions', async () => {
    history.pushState(null, '', '/s/K7M3QP');
    render(<App />);
    const worker = FakeWorker.latest();
    await waitFor(() => expect(worker?.last('init')).toBeDefined());
    act(() => worker?.emit({ t: 'ready', code: 'K7M3QP', peerId: 'b', shareUrl: 'https://x/s/K7M3QP' }));
    act(() => worker?.emit({ t: 'verification', digits: '482193' }));

    expect(await screen.findByText('482 193')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /share camera/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /numbers match/i }));
    expect(worker?.last('confirm-verification')).toBeDefined();
    // One confirmation is not enough: the other device has not looked yet.
    expect(screen.queryByRole('button', { name: /share camera/i })).not.toBeInTheDocument();

    act(() => worker?.emit({ t: 'peer-verified' }));
    expect(await screen.findByRole('button', { name: /share camera/i })).toBeInTheDocument();
  });

  /*
   * A replacement peer agrees a different key, so the worker sends a new
   * number — and a new number is one nobody has compared yet. Inheriting the
   * previous pair's confirmation is exactly the hole a machine-in-the-middle
   * would walk through.
   */
  it('puts the gate back up when a new number arrives', async () => {
    history.pushState(null, '', '/s/K7M3QP');
    render(<App />);
    const worker = FakeWorker.latest();
    await waitFor(() => expect(worker?.last('init')).toBeDefined());
    act(() => worker?.emit({ t: 'ready', code: 'K7M3QP', peerId: 'b', shareUrl: 'https://x/s/K7M3QP' }));
    act(() => worker?.emit({ t: 'verification', digits: '482193' }));
    await userEvent.click(screen.getByRole('button', { name: /numbers match/i }));
    act(() => worker?.emit({ t: 'peer-verified' }));
    await screen.findByRole('button', { name: /share camera/i });

    act(() => worker?.emit({ t: 'verification', digits: '917024' }));

    expect(await screen.findByText('917 024')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /share camera/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /numbers match/i })).toBeInTheDocument();
  });

  it('shows the transfer panel once the session screen pairs', async () => {
    history.pushState(null, '', '/s/K7M3QP');
    render(<App />);
    const worker = FakeWorker.latest();
    await waitFor(() => expect(worker?.last('init')).toBeDefined());

    act(() => worker?.emit({ t: 'ready', code: 'K7M3QP', peerId: 'b', shareUrl: 'https://x/s/K7M3QP#k' }));

    expect(await screen.findByText(/connected/i)).toBeInTheDocument();
  });

  it('keeps the room recoverable, not a dead end, once the other device disconnects', async () => {
    history.pushState(null, '', '/s/K7M3QP');
    render(<App />);
    const worker = FakeWorker.latest();
    await waitFor(() => expect(worker?.last('init')).toBeDefined());
    act(() => worker?.emit({ t: 'ready', code: 'K7M3QP', peerId: 'b', shareUrl: 'https://x/s/K7M3QP#k' }));
    await screen.findByText(/connected/i);

    act(() => worker?.emit({ t: 'peer-left', reason: 'peer-left' }));

    // The room survives one peer leaving (server/rooms.ts only deletes it
    // once every peer is gone), so the code is re-shown for a rejoin rather
    // than the screen claiming the session is over.
    expect(await screen.findByRole('heading', { name: /disconnected/i })).toBeInTheDocument();
    expect(screen.getByText('K7M-3QP')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /end session/i })).toBeInTheDocument();
  });

  it('renders the invalid screen with reason bad-code for a malformed code', () => {
    history.pushState(null, '', '/s/TOOLONG9');
    render(<App />);
    expect(screen.getByRole('heading', { name: /that code does not look right/i })).toBeInTheDocument();
    expect(screen.getByText(/six characters/i)).toBeInTheDocument();
  });

  it('links the create screen to /join with a real anchor, not a div handler', () => {
    history.pushState(null, '', '/new');
    render(<App />);
    const link = screen.getByRole('link', { name: /join a session/i });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/join');
  });

  it('navigates from create to join on a plain click, without a full page reload', async () => {
    history.pushState(null, '', '/new');
    render(<App />);
    const link = screen.getByRole('link', { name: /join a session/i });
    await userEvent.click(link);
    expect(screen.getByRole('heading', { name: /join a session/i })).toBeInTheDocument();
    expect(location.pathname).toBe('/join');
  });

  it('sets document.title for the initial route', () => {
    history.pushState(null, '', '/join');
    render(<App />);
    expect(document.title).toContain('Join');
  });

  it('updates document.title on client-side navigation, not just on first mount', async () => {
    render(<App />);
    const landingTitle = document.title;
    expect(landingTitle).toContain('Quik Share');
    await userEvent.click(screen.getAllByRole('button', { name: /join a device/i })[0]!);
    expect(document.title).not.toBe(landingTitle);
    expect(document.title).toContain('Join');
  });

  /*
   * The shell used to pick its width from the route, and that was a bug
   * with a measurable cost: the CREATOR stays on '/new' for the whole
   * session — CreateScreen swaps itself for TransferPanel once a peer
   * joins — so the paired workspace rendered inside the narrow prose
   * measure '/new' wants while it is still a QR code. At a 1440px window
   * that gave the creator 340px columns against 345px of Share buttons
   * (they wrapped onto two rows) while the joiner, on '/s/:code', got
   * 596px for the identical screen.
   */
  it('gives every route the same wide shell, so a screen is never narrowed by its URL', () => {
    for (const path of ['/', '/new', '/join', '/s/K7M3QP']) {
      history.pushState(null, '', path);
      const view = render(<App />);
      expect(screen.getByRole('main'), path).toHaveClass('max-w-[100rem]');
      view.unmount();
    }
  });

  it('lets each screen set its own measure inside that shell, and never narrows the header', () => {
    history.pushState(null, '', '/');
    const landing = render(<App />);
    // The landing page is not prose: it has a two-column hero, a step rail
    // and a bento grid, and wants more than a reading measure but less than
    // the shell. The measure lives on the page's own wrapper rather than on
    // the hero, since the hero is now one of four sections sharing it.
    expect(landing.container.querySelector('[data-landing-shell]'))
      .toHaveClass('max-w-6xl');
    // The header is deliberately NOT tied to any of this: it spans the
    // window on every route, so the wordmark sits at the edge of a wide
    // display instead of floating in the middle of an empty bar. This is
    // the assertion that would fail if someone re-coupled the two.
    expect(within(screen.getByRole('banner')).getByRole('link', { name: /quik share/i })
      .closest('div')).not.toHaveClass('max-w-6xl');
    landing.unmount();

    history.pushState(null, '', '/join');
    const join = render(<App />);
    // Narrower than the other prose screens, and deliberately: this one is a
    // single six-character field, which at a 3xl measure stretched to 768px.
    expect(join.container.querySelector('section[aria-labelledby="join-heading"]'))
      .toHaveClass('max-w-xl');
  });
});
