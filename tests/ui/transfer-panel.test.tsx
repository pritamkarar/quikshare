// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DropZone } from '../../client/ui/DropZone.js';
import { TransferRecord } from '../../client/ui/TransferRecord.js';
import { TextSnippet } from '../../client/ui/TextSnippet.js';
import { formatBytes } from '../../client/ui/format.js';
import { TransferPanel } from '../../client/screens/TransferPanel.js';
import { MAX_TEXT_CHARS } from '../../shared/messages.js';
import type { SessionHandle } from '../../client/hooks/useSession.js';
import type { TrackedFile } from '../../client/hooks/useSession.js';
import type { LiveSessionEvents, Slot } from '../../client/media/live-session.js';
import type { MediaControl } from '../../shared/messages.js';

/*
 * TransferPanel now owns building a real `LiveSession` per Task 8 (wiring
 * client/media/live-session.ts's class to a real screen), which this file's
 * pre-existing tests never asked for and should not have to think about —
 * mocked here, the same way create-screen.test.tsx mocks `qrcode` and
 * app-routing.test.tsx mocks the Worker, so the rest of this file's suite
 * (DropZone, TransferRecord, TextSnippet, and TransferPanel's own
 * unrelated tests below) keeps mounting a real component tree without
 * touching `RTCPeerConnection`, which jsdom does not implement at all.
 *
 * A tiny fake, not vi.fn()-only stubs, because several of the new tests
 * below need to reach back into "the LiveSession TransferPanel just built"
 * — to read the `peerId` it was constructed with, or to drive its events
 * (`onSlotChanged`/`onFailure`) the way a real negotiation would — the same
 * shape tests/unit/live-session.test.ts's own FakeMediaPeer serves for
 * MediaPeer, one layer down.
 */
interface FakeLiveSession {
  readonly peerId: 'a' | 'b';
  readonly events: LiveSessionEvents;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onPeerLeft: ReturnType<typeof vi.fn>;
  onMediaSignal: ReturnType<typeof vi.fn>;
}

/** Every `LiveSession` TransferPanel has constructed in the current test, oldest first. */
const liveSessions: FakeLiveSession[] = [];

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
      liveSessions.push(this as unknown as FakeLiveSession);
    }
  },
}));

/** The most recently constructed fake `LiveSession` — TransferPanel builds exactly one per mount. */
function currentLiveSession(): FakeLiveSession {
  const live = liveSessions.at(-1);
  if (!live) throw new Error('no LiveSession constructed yet — is peerId set on the fakeSession?');
  return live;
}

beforeEach(() => {
  liveSessions.length = 0;
  // TransferPanel makes no network request of its own on mount: the
  // no-TURN caution is now learned from LiveSession's onTurnAvailable
  // (fired by a real share attempt's own mediaRtcConfig() call, one layer
  // down in MediaPeer — see live-session.ts's #makePeerEvents), not from a
  // second `/turn` probe here. LiveSession itself is mocked in this file,
  // so there is nothing left in this suite that would ever call fetch.
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const tracked = (over: Partial<TrackedFile> = {}): TrackedFile => ({
  meta: { id: 1, name: 'report.pdf', size: 2048, type: 'application/pdf' },
  direction: 'send', bytesMoved: 1024, bytesPerSecond: 512, done: false, seq: 1, ...over,
});

describe('DropZone', () => {
  it('offers a click-to-browse path, not only drag and drop', () => {
    render(<DropZone onFiles={vi.fn()} />);
    expect(screen.getByRole('button', { name: /choose files/i })).toBeInTheDocument();
  });

  it('is operable by keyboard', async () => {
    render(<DropZone onFiles={vi.fn()} />);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: /choose files/i })).toHaveFocus();
  });

  it('accepts dropped files', () => {
    const onFiles = vi.fn();
    const { container } = render(<DropZone onFiles={onFiles} />);
    const zone = container.querySelector('[data-dropzone]')!;
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    const event = new Event('drop', { bubbles: true }) as Event & { dataTransfer: unknown };
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file], items: [] } });
    zone.dispatchEvent(event);
    expect(onFiles).toHaveBeenCalled();
  });
});

/*
 * FileQueue.tsx is gone -- superseded by TransferRecord, which folds files
 * and notes into one list (see client/ui/record.ts). Every test below is
 * inherited from FileQueue's own suite, retargeted at TransferRecord with an
 * empty `notes` array so it exercises the same file-row rendering rather
 * than losing the coverage. Row-level behaviour TransferRecord shares
 * verbatim with the FileQueue it replaced (formatting, truncation,
 * virtualization, the done-vs-100%-bytes distinction) is proven here, not
 * duplicated in tests/ui/transfer-record.test.tsx, which covers what is
 * actually new to TransferRecord (mixed-kind ordering, filtering, the two
 * row heights).
 */
describe('TransferRecord', () => {
  // Inherited verbatim from the brief. This does NOT prove the space is
  // non-breaking: Testing Library's default text normalizer collapses any
  // run of \s -- which includes U+00A0 -- to an ordinary space before matching,
  // so this passes identically whether formatBytes emits a real non-breaking
  // space or a plain one. It only proves the row renders a formatted size at
  // all. The actual non-breaking-space guarantee is a byte-level `toBe` in
  // tests/unit/format.test.ts ("joins value and unit with a non-breaking
  // space"), which compares against a real U+00A0 literal.
  //
  // Nor does it hard-code "2 KB" any more: the row formats through the
  // browser's locale, so a literal would fail under a non-latin-numeral
  // default (a non-Latin locale renders non-ASCII digits) -- a suite that
  // passes on one machine and fails on the next is worse than the bug that
  // motivated the Intl change. The expected text comes from the same
  // formatter, with the NBSP relaxed to a plain space because the matcher
  // normalizes it.
  it('renders the file size formatted via formatBytes', () => {
    const { container } = render(<TransferRecord files={[tracked()]} notes={[]} />);
    expect(container.querySelector('.numeric'))
      .toHaveTextContent(formatBytes(2048).replace(/\u00a0/g, ' '));
  });

  it('renders numbers with tabular figures so they do not jitter', () => {
    const { container } = render(<TransferRecord files={[tracked()]} notes={[]} />);
    expect(container.querySelector('.numeric')).toBeInTheDocument();
  });

  it('announces completion politely', () => {
    render(<TransferRecord files={[tracked({ done: true })]} notes={[]} />);
    // Two independent live regions live here (one for completion/count, one
    // for copy confirmations -- see TransferRecord.tsx), so `getByRole`
    // alone would fail on the ambiguity; the file name only ever lands in
    // the first.
    const statuses = screen.getAllByRole('status');
    expect(statuses.some((el) => /report\.pdf/i.test(el.textContent ?? ''))).toBe(true);
  });

  it('offers a cancel on a file that is still moving, naming the file it stops', async () => {
    const onCancel = vi.fn();
    render(<TransferRecord files={[tracked()]} notes={[]} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole('button', { name: /cancel sending report\.pdf/i }));

    // Direction travels with the id, always: the two id spaces are minted
    // independently, so id 1 alone names two different files.
    expect(onCancel).toHaveBeenCalledWith('send', [1]);
  });

  it('offers no cancel on a file that already finished or was already cancelled', () => {
    const { rerender } = render(
      <TransferRecord files={[tracked({ done: true })]} notes={[]} onCancel={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();

    rerender(<TransferRecord files={[tracked({ cancelled: true })]} notes={[]} onCancel={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
  });

  it('badges a cancelled file as cancelled, keeping the bytes it reached', () => {
    render(<TransferRecord files={[tracked({ cancelled: true })]} notes={[]} />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    // Not zeroed and not shown complete: how far it got is the one thing
    // still worth reading off the row.
    expect(screen.queryByText(/Sent|Received/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 KB of 2 KB/)).toBeInTheDocument();
    // A bar that stopped moving reads as a transfer still going.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('takes two clicks to stop a whole batch, and cancels both directions', async () => {
    const onCancel = vi.fn();
    render(
      <TransferRecord
        files={[
          tracked({ meta: { id: 1, name: 'up.bin', size: 10, type: '' }, direction: 'send', seq: 1 }),
          tracked({ meta: { id: 1, name: 'down.bin', size: 10, type: '' }, direction: 'receive', seq: 2 }),
          tracked({ meta: { id: 2, name: 'done.bin', size: 10, type: '' }, direction: 'send', done: true, seq: 3 }),
        ]}
        notes={[]}
        onCancel={onCancel}
      />,
    );

    // Armed, not fired: stopping a batch is destructive and has no undo.
    await userEvent.click(screen.getByRole('button', { name: /cancel all/i }));
    expect(onCancel).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /stop all 2/i }));
    // One call per direction, and the finished file is not in either.
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onCancel).toHaveBeenCalledWith('send', [1]);
    expect(onCancel).toHaveBeenCalledWith('receive', [1]);
  });

  it('offers no batch cancel for a single in-flight file, which has its own', () => {
    render(<TransferRecord files={[tracked()]} notes={[]} onCancel={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /cancel all/i })).not.toBeInTheDocument();
  });

  it('designs an empty state rather than rendering nothing', () => {
    render(<TransferRecord files={[]} notes={[]} />);
    expect(screen.getByText(/nothing yet/i)).toBeInTheDocument();
  });

  it('truncates a very long filename instead of overflowing', () => {
    const long = 'a'.repeat(300) + '.pdf';
    const { container } = render(
      <TransferRecord files={[tracked({ meta: { id: 1, name: long, size: 10, type: '' } })]} notes={[]} />,
    );
    expect(container.querySelector('.truncate')).toBeInTheDocument();
    expect(container.querySelector('.min-w-0')).toBeInTheDocument();
  });

  it('virtualizes past 50 rows instead of mounting every one', () => {
    // jsdom does no layout, so the scroll container's real offsetHeight is
    // always 0 -- which the virtualizer would read as "nothing is visible"
    // and render zero rows, proving nothing about virtualization either way.
    // Stubbed to a plausible viewport height so its actual windowing logic
    // runs the same way it would in a browser.
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(384);
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
    try {
      // seq must be unique per row (unlike FileQueue, TransferRecord keys
      // its rows by `seq`, not `meta.id` — the default `tracked()` seq of 1
      // would otherwise collide across every generated row).
      const many = Array.from({ length: 200 }, (_, i) => tracked({
        meta: { id: i + 1, name: `file-${i}.bin`, size: 10, type: '' }, seq: i + 1,
      }));
      const { container } = render(<TransferRecord files={many} notes={[]} />);
      const rendered = container.querySelectorAll('[data-file-row]').length;
      // Not all 200 rows are ever mounted at once -- only whatever the
      // virtualizer decides is near the visible viewport, far fewer than the
      // full list.
      expect(rendered).toBeGreaterThan(0);
      expect(rendered).toBeLessThan(many.length);
    } finally {
      height.mockRestore();
      width.mockRestore();
    }
  });

  it('does not render every row below the virtualization threshold either', () => {
    // Below the threshold, nothing is virtualized: all rows mount directly.
    const some = Array.from({ length: 10 }, (_, i) => tracked({
      meta: { id: i + 1, name: `file-${i}.bin`, size: 10, type: '' }, seq: i + 1,
    }));
    const { container } = render(<TransferRecord files={some} notes={[]} />);
    expect(container.querySelectorAll('[data-file-row]').length).toBe(10);
  });

  it('does not show a file as complete just because every byte has arrived', () => {
    // bytesMoved === meta.size, but `done` was never set by an explicit
    // completion event -- e.g. the file failed at the very last step (a
    // rejected sink close, a dropped file-end frame). It must not read as
    // finished just because the byte count looks like 100%.
    const stalled = tracked({ bytesMoved: 2048, done: false });
    render(<TransferRecord files={[stalled]} notes={[]} />);
    // Case-sensitive and unanchored to "i": the record's own "sent" filter
    // chip (lowercase, always present) would otherwise satisfy /^sent$/i and
    // this assertion would pass for the wrong reason. The Badge's "Sent"
    // label is capitalized, which the chip text is not.
    expect(screen.queryByText(/^Sent$/)).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('shows a done file as complete via an explicit, non-color-only cue', () => {
    render(<TransferRecord files={[tracked({ done: true, bytesMoved: 2048 })]} notes={[]} />);
    expect(screen.getByText(/^Sent$/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

describe('TextSnippet', () => {
  it('submits on Ctrl+Enter, not on plain Enter', async () => {
    const onSend = vi.fn();
    render(<TextSnippet onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: /text to send/i });
    await userEvent.type(box, 'hello{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(box, '{Control>}{Enter}{/Control}');
    expect(onSend).toHaveBeenCalledWith('hello\n');
  });

  /*
   * Reported from a real phone: the note box could not be used at all,
   * because a touch keyboard has no Ctrl or ⌘ key and the shortcut was the
   * only way to submit. This app is mostly used from a phone, so a
   * pointer-operable control is the primary path and the shortcut is the
   * accelerator — not the other way round.
   */
  it('sends from a button, so a device with no Ctrl key can send at all', async () => {
    const onSend = vi.fn();
    render(<TextSnippet onSend={onSend} />);
    await userEvent.type(screen.getByRole('textbox', { name: /text to send/i }), 'from a phone');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(onSend).toHaveBeenCalledWith('from a phone');
  });

  it('disables the send button while there is nothing to send', async () => {
    render(<TextSnippet onSend={vi.fn()} />);
    const button = screen.getByRole('button', { name: /^send$/i });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: /text to send/i }), 'x');
    expect(button).toBeEnabled();
  });

  it('treats whitespace as nothing to send, matching the shortcut', async () => {
    const onSend = vi.fn();
    render(<TextSnippet onSend={onSend} />);
    await userEvent.type(screen.getByRole('textbox', { name: /text to send/i }), '   ');
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('clears the draft after sending, so the next note starts empty', async () => {
    render(<TextSnippet onSend={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: /text to send/i });
    await userEvent.type(box, 'one');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('stops a paste at the one-frame ceiling, rather than letting it fail on the wire', async () => {
    // A note is a single unchunked control frame. Before this cap the same
    // paste silently succeeded on the relay and threw "frame of N bytes
    // exceeds MAX_FRAME_BYTES" after a WebRTC upgrade — the outcome hinging
    // on a transport swap the user was never asked about.
    const onSend = vi.fn();
    render(<TextSnippet onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: /text to send/i });
    expect(box).toHaveAttribute('maxlength', String(MAX_TEXT_CHARS));

    await userEvent.click(box);
    await userEvent.paste('x'.repeat(MAX_TEXT_CHARS + 500));

    expect((box as HTMLTextAreaElement).value).toHaveLength(MAX_TEXT_CHARS);
    // And the truncation is visible while it is still true: 90 KB of a
    // pasted log quietly vanishing would look exactly like a successful send.
    expect(screen.getByRole('alert')).toHaveTextContent(/at the 10,000-character limit/i);

    await userEvent.type(box, '{Control>}{Enter}{/Control}');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect((onSend.mock.calls[0]![0] as string).length).toBe(MAX_TEXT_CHARS);
  });

});

/*
 * Inherited from TextSnippet's own suite ("offers a copy action for
 * received text" / "confirms a successful copy" / "surfaces a failed copy
 * instead of looking identical to a successful one"). The received-notes
 * list and the Copy button that went with it moved off TextSnippet and onto
 * TransferRecord's note rows (see TextSnippet.tsx's doc comment) — the
 * clipboard success/failure behaviour is unchanged, only where it lives.
 */
describe('TransferRecord: copying a received note', () => {
  const RECEIVED_NOTE = { seq: 1, direction: 'receive' as const, content: 'a secret' };

  it('offers a copy action for a received note', () => {
    render(<TransferRecord files={[]} notes={[RECEIVED_NOTE]} />);
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('confirms a successful copy', async () => {
    const user = userEvent.setup();
    render(<TransferRecord files={[]} notes={[RECEIVED_NOTE]} />);

    // Its aria-label ("Copy received note 1") stays fixed so the button's
    // accessible name doesn't change out from under a screen reader user
    // mid-interaction — the confirmation is carried by its visible text
    // instead, so that's what this asserts on.
    await user.click(screen.getByRole('button', { name: /copy received note 1/i }));

    expect(await screen.findByText(/^copied$/i)).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe('a secret');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // And the same confirmation reaches a screen reader, which the visible
    // swap above does NOT prove: the button's accessible name is pinned by
    // that fixed aria-label precisely so it does not change mid-interaction,
    // which makes the Copy → Copied swap inaudible. The card-level
    // role="status" region is the only thing that announces it, and it was
    // already lost once during this branch and restored by review — with
    // nothing asserting on it, it can be deleted again and the suite stays
    // green. Two live regions are rendered here (completion/count and copy),
    // so getByRole alone would fail on the ambiguity; the confirmation text
    // only ever lands in the second.
    const statuses = screen.getAllByRole('status');
    expect(statuses.some((el) => /copied to clipboard/i.test(el.textContent ?? ''))).toBe(true);
  });

  it('surfaces a failed copy instead of looking identical to a successful one', async () => {
    const user = userEvent.setup();
    render(<TransferRecord files={[]} notes={[RECEIVED_NOTE]} />);
    // userEvent.setup() installs a working navigator.clipboard; this forces
    // its writeText to reject the way a denied permission or an unfocused
    // document would in a real browser.
    const failing = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

    try {
      await user.click(screen.getByRole('button', { name: /copy received note 1/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/would not let/i);
      // Silence here would look exactly like success — the button must not
      // read "Copied" for a copy that never happened.
      expect(screen.queryByText(/^copied$/i)).not.toBeInTheDocument();
    } finally {
      failing.mockRestore();
    }
  });
});

/** A complete SessionHandle, for tests that mount TransferPanel directly. */
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
    // 'a', not undefined: TransferPanel only ever renders once paired, by
    // which point the real hook always has a peerId (SessionHandle.peerId's
    // own doc comment) — defaulting the fake to match keeps every
    // pre-existing test in this file exercising the same LiveSession-wiring
    // path a real mount does, rather than the `undefined` early-return
    // branch only tests/ui/transfer-panel.test.tsx's own live-media
    // describe block below exercises on purpose.
    peerId: 'a',
    // Verified by default, for the same reason peerId is 'a': every test in
    // this file that predates the verification gate is about what the panel
    // does once a session is fully usable. The gate itself has its own tests
    // (tests/ui/verify-panel.test.tsx), which override these.
    verification: '482193',
    verifiedByMe: true,
    verifiedByPeer: true,
    confirmVerification: vi.fn(),
    endSession: vi.fn(async () => {}),
    // Off by default: the folder control is Chromium-desktop only, and
    // every test here that predates it asserts on a panel without one.
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

describe('TransferPanel', () => {
  it('offers no folder control on a browser that cannot hand one over', () => {
    render(<TransferPanel session={fakeSession()} />);
    expect(screen.queryByRole('button', { name: /folder/i })).not.toBeInTheDocument();
  });

  it('asks for a folder once, and then says where files are landing', async () => {
    const chooseFolder = vi.fn();
    const session = fakeSession({ canChooseFolder: true, chooseFolder });
    const { rerender } = render(<TransferPanel session={session} />);

    await userEvent.click(screen.getByRole('button', { name: /save to a folder/i }));
    expect(chooseFolder).toHaveBeenCalledTimes(1);

    // What the hook does once the picker resolves. The panel must stop
    // promising browser downloads and name the folder instead.
    rerender(<TransferPanel session={{ ...session, saveFolder: 'Shared' }} />);
    expect(screen.getByText(/written straight into .Shared./i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change folder/i })).toBeInTheDocument();
  });

  it('renders the drop zone, the transfer record and the text snippets', () => {
    render(<TransferPanel session={fakeSession()} />);
    expect(screen.getByRole('button', { name: /choose files/i })).toBeInTheDocument();
    expect(screen.getByText(/nothing yet/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /text to send/i })).toBeInTheDocument();
  });

  it('groups the screen into Share and Transfers, and no longer a third Devices section', () => {
    render(<TransferPanel session={fakeSession()} />);
    expect(screen.getByRole('region', { name: /share/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /transfers/i })).toBeInTheDocument();
    // The pair is drawn once, in the header. A second, fuller description of
    // the same two devices under the transfer record was reference material
    // nobody scrolled back to.
    expect(screen.queryByRole('region', { name: /devices/i })).not.toBeInTheDocument();
  });

  it('puts the record beside the controls rather than below them', () => {
    const { container } = render(<TransferPanel session={fakeSession()} />);
    // The two-column wrapper is what makes the record visible without
    // scrolling past the drop zone; asserted because nothing else in the
    // suite can see a layout class.
    expect(container.querySelector('[data-session-columns]')).toHaveClass('sm:grid-cols-2');
  });

  it('no longer renders received notes under the composer', () => {
    const session = fakeSession({ notes: [{ seq: 1, direction: 'receive', content: 'a note' }] });
    render(<TransferPanel session={session} />);
    // Exact string match, not a regex: TextSnippet's own heading is "Send a
    // note", which contains "a note" as a substring and would otherwise
    // satisfy a loose /a note/ match whether or not the composer still
    // rendered a received-notes list. Exactly once — in the record, not
    // also under the text box.
    expect(screen.getAllByText('a note')).toHaveLength(1);
  });

  it('renders a per-file or session error, unlike the placeholder it replaces', () => {
    render(<TransferPanel session={fakeSession({ error: '"a.bin" failed its integrity check.' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/integrity check/i);
  });

  it('renders a save-tier notice as information, not as an alarm', () => {
    render(<TransferPanel session={fakeSession({ notice: 'Files will be held in memory instead.' })} />);
    expect(screen.getByText(/held in memory/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('drops the join link, which has nothing left to offer once paired', () => {
    render(<TransferPanel session={fakeSession()} />);
    expect(screen.queryByRole('link', { name: /join a session/i })).not.toBeInTheDocument();
  });

  /*
   * Ending is done by leaving the screen: unmounting tears down useSession,
   * which posts `close` and terminates the worker, so the peer sees
   * `peer-left`. Asserting the route rather than a teardown spy is the point
   * — it is what makes the confirm below come for free.
   */
  it('offers an explicit way to end the session, which routes home', async () => {
    // Home replaces rather than pushes, so Back does not return to the
    // session that was just ended -- see `leaveTo`.
    const replaceState = vi.spyOn(history, 'replaceState');
    render(<TransferPanel session={fakeSession()} />);
    await userEvent.click(screen.getByRole('button', { name: /end session/i }));
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('ends without a prompt when nothing is in flight', async () => {
    const confirmed = vi.spyOn(window, 'confirm');
    vi.spyOn(history, 'pushState');
    render(<TransferPanel session={fakeSession({ files: [] })} />);
    await userEvent.click(screen.getByRole('button', { name: /end session/i }));
    expect(confirmed).not.toHaveBeenCalled();
  });
});

/**
 * The in-app half of AGENTS.md's "warn on unsaved changes before navigation".
 * `beforeunload` (covered in transfer-guards.test.tsx) does not fire for
 * pushState, and End session is deliberately the only route off this screen —
 * so clicking it used to unmount the panel and terminate the worker
 * mid-transfer with no warning at all.
 */
describe('TransferPanel: leaving mid-transfer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /*
   * The End session button is a second route off this screen, so it needs the
   * same protection the join link has — and gets it by going through
   * `navigateTo` rather than tearing the session down itself. A declined
   * confirm must leave the session running, not half-ended.
   */
  it('confirms before End session cancels a live transfer, and obeys a refusal', async () => {
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const replaceState = vi.spyOn(history, 'replaceState');
    render(<TransferPanel session={fakeSession({ files: [tracked()] })} />);

    await userEvent.click(screen.getByRole('button', { name: /end session/i }));

    expect(confirmed).toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('ends the session once the user accepts losing the transfer', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const replaceState = vi.spyOn(history, 'replaceState');
    render(<TransferPanel session={fakeSession({ files: [tracked()] })} />);

    await userEvent.click(screen.getByRole('button', { name: /end session/i }));

    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('does not interrupt leaving when the files on screen are all finished', async () => {
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const replaceState = vi.spyOn(history, 'replaceState');
    render(<TransferPanel session={fakeSession({ files: [tracked({ done: true })] })} />);

    await userEvent.click(screen.getByRole('button', { name: /end session/i }));

    expect(confirmed).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalled();
  });
});

/** Stands in for a captured MediaStreamTrack: only `.kind` matters to LiveSection's rendering. */
function fakeStream(kinds: Array<'audio' | 'video'>): MediaStream {
  const tracks = kinds.map((kind) => ({ kind, enabled: true, stop: vi.fn() }));
  return {
    id: 'transfer-panel-stream',
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  } as unknown as MediaStream;
}

/*
 * Task 8's actual wiring: a real `LiveSession` (mocked above) built from
 * `session.peerId`, its events driving `LiveSection`'s promoted card and the
 * Share-panel controls, and both torn down on unmount. Each of these proves
 * one thing the task brief calls out as easy to get wrong, rather than
 * re-testing LiveSection's own rendering (tests/ui/live-section.test.tsx)
 * or LiveSession's own state machine (tests/unit/live-session.test.ts).
 */
describe('TransferPanel: live media wiring', () => {
  /*
   * jsdom implements no `navigator.mediaDevices` at all, which is the exact
   * shape of a browser that cannot capture a screen — so without this stub
   * every test below would render the mobile layout (no Share screen button)
   * while claiming to describe the desktop one. Stubbed rather than mocked
   * away because the gate reads the real property, one layer down in
   * capture.ts's `supportsScreenCapture`.
   */
  beforeEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia: vi.fn() },
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  });

  it('hides Share screen where the browser cannot capture one, rather than offering a button that can only fail', () => {
    // Every mobile browser: `getUserMedia` present (the camera works),
    // `getDisplayMedia` absent. Receiving the peer's screen is unaffected —
    // only this device's own start control goes.
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn() },
      configurable: true,
    });
    render(<TransferPanel session={fakeSession()} />);
    expect(screen.queryByRole('button', { name: /share screen/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /share camera/i })).toBeEnabled();
  });

  it('builds LiveSession with the session\'s real peerId, never a default', () => {
    render(<TransferPanel session={fakeSession({ peerId: 'b' })} />);
    expect(currentLiveSession().peerId).toBe('b');
  });

  it('renders the camera and screen start buttons in Share, present before any peerId is known', () => {
    // peerId undefined is the one moment before TransferPanel's own
    // LiveSession effect can do anything (its early return) — the buttons
    // must still render, because Share's placement of them is unconditional
    // on Live's state, not on whether a LiveSession exists yet.
    render(<TransferPanel session={fakeSession({ peerId: undefined })} />);
    expect(screen.getByRole('button', { name: /share camera/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /share screen/i })).toBeEnabled();
    expect(liveSessions).toHaveLength(0);
  });

  it('clicking Share camera calls LiveSession.start("camera")', async () => {
    const user = userEvent.setup();
    render(<TransferPanel session={fakeSession()} />);
    await user.click(screen.getByRole('button', { name: /share camera/i }));
    expect(currentLiveSession().start).toHaveBeenCalledWith('camera');
  });

  it('clicking Share screen calls LiveSession.start("screen")', async () => {
    const user = userEvent.setup();
    render(<TransferPanel session={fakeSession()} />);
    await user.click(screen.getByRole('button', { name: /share screen/i }));
    expect(currentLiveSession().start).toHaveBeenCalledWith('screen');
  });

  it('shows a capture failure alongside the Share buttons, and clears it on the next attempt', async () => {
    const user = userEvent.setup();
    render(<TransferPanel session={fakeSession()} />);
    const live = currentLiveSession();

    act(() => live.events.onFailure({ reason: 'no-device' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/no camera/i);

    await user.click(screen.getByRole('button', { name: /share camera/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps a live-media failure out of session.error\'s own alert — never the same paragraph', () => {
    render(<TransferPanel session={fakeSession({ error: 'a real transfer error' })} />);
    const live = currentLiveSession();
    act(() => live.events.onFailure({ reason: 'denied' }));

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts.some((el) => /address bar/i.test(el.textContent ?? ''))).toBe(true);
    expect(alerts.some((el) => el.textContent === 'a real transfer error')).toBe(true);
  });

  it('promotes Live above the two-column grid once a stream starts, and collapses it back once it stops', () => {
    render(<TransferPanel session={fakeSession()} />);
    const live = currentLiveSession();

    expect(screen.queryByRole('region', { name: /^live$/i })).not.toBeInTheDocument();

    const slot: Slot = { state: 'sending', kind: 'camera', peer: {} as never, stream: fakeStream(['video', 'audio']) };
    act(() => live.events.onSlotChanged(slot));
    expect(screen.getByRole('region', { name: /^live$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop sharing/i })).toBeInTheDocument();

    act(() => live.events.onSlotChanged({ state: 'idle' }));
    expect(screen.queryByRole('region', { name: /^live$/i })).not.toBeInTheDocument();
  });

  it('still shows both start buttons while a stream is active, so switching kind or replacing a watched stream is reachable', () => {
    render(<TransferPanel session={fakeSession()} />);
    const live = currentLiveSession();
    const slot: Slot = { state: 'sending', kind: 'screen', peer: {} as never, stream: fakeStream(['video']) };
    act(() => live.events.onSlotChanged(slot));

    expect(screen.getByRole('button', { name: /share camera/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /share screen/i })).toBeEnabled();
  });

  it('routes an inbound media-* signal from the session into LiveSession.onMediaSignal', () => {
    // fakeSession()'s onMediaSignal stub stashes the callback TransferPanel
    // subscribed with — invoking it here stands in for the Receiver
    // delivering a real inbound frame (client/hooks/useSession.ts's own
    // 'media-signal' case, which fans out to every subscriber the same way).
    const captured: Array<(signal: MediaControl) => void> = [];
    const session = fakeSession({ onMediaSignal: vi.fn((cb) => { captured.push(cb); return () => {}; }) });
    render(<TransferPanel session={session} />);

    const signal = { t: 'media-stop' } as MediaControl;
    act(() => captured[0]!(signal));

    expect(currentLiveSession().onMediaSignal).toHaveBeenCalledWith(signal);
  });

  it('unmount unsubscribes onMediaSignal and stops the live session — the camera-off obligation', () => {
    const unsubscribe = vi.fn();
    const session = fakeSession({ onMediaSignal: vi.fn(() => unsubscribe) });
    const { unmount } = render(<TransferPanel session={session} />);
    const live = currentLiveSession();

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(live.stop).toHaveBeenCalledTimes(1);
  });

  it('calls LiveSession.onPeerLeft() when session.state transitions to \'ended\'', () => {
    const session = fakeSession({ state: 'paired' });
    const { rerender } = render(<TransferPanel session={session} />);
    const live = currentLiveSession();

    rerender(<TransferPanel session={{ ...session, state: 'ended' }} />);

    expect(live.onPeerLeft).toHaveBeenCalledTimes(1);
  });

  it('calls LiveSession.onPeerLeft() when session.state transitions to \'gone\'', () => {
    const session = fakeSession({ state: 'paired' });
    const { rerender } = render(<TransferPanel session={session} />);
    const live = currentLiveSession();

    rerender(<TransferPanel session={{ ...session, state: 'gone' }} />);

    expect(live.onPeerLeft).toHaveBeenCalledTimes(1);
  });

  it('has nothing to caution about while idle — no share attempt has run yet to learn it', () => {
    render(<TransferPanel session={fakeSession()} />);

    // No fetch of any kind happens on mount any more (the composition
    // defect this replaces): `turnAvailable` stays optimistically true
    // until a real share attempt's LiveSession.onTurnAvailable says
    // otherwise, so an idle session shows no caution at all.
    expect(screen.queryByText(/may not/i)).not.toBeInTheDocument();
  });

  it('cautions about no TURN server once the first share attempt learns it, next to the Share buttons while idle', () => {
    render(<TransferPanel session={fakeSession()} />);
    const live = currentLiveSession();

    // Simulates what a real share attempt does: MediaPeer.offer()/
    // answer() fetches /turn via mediaRtcConfig() and reports what it
    // found through onIceConfig, which live-session.ts's #makePeerEvents
    // relays here as onTurnAvailable. LiveSession itself is mocked in this
    // file, so this is driven directly rather than through a real
    // negotiation.
    act(() => live.events.onTurnAvailable?.(false));
    expect(screen.getByText(/may not/i)).toBeInTheDocument();

    // And it stops appearing in Share once Live's own promoted card takes
    // over showing it, rather than saying the same thing twice on screen.
    const slot: Slot = { state: 'sending', kind: 'camera', peer: {} as never, stream: fakeStream(['video', 'audio']) };
    act(() => live.events.onSlotChanged(slot));
    expect(screen.getAllByText(/may not/i)).toHaveLength(1);
  });
});

/**
 * Notification permission is asked for from the send gesture, and nowhere
 * else. On mount would prompt anyone who merely opened a session — including
 * someone who only ever receives — which is the pattern browsers added
 * permission-prompt throttling to punish.
 */
describe('TransferPanel: arming completion notifications', () => {
  let requestPermission: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    vi.stubGlobal('Notification', class {
      static permission: NotificationPermission = 'default';
      static requestPermission = requestPermission;
    });
  });

  it('does not ask on mount', () => {
    render(<TransferPanel session={fakeSession()} />);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('asks when a note is sent', async () => {
    render(<TransferPanel session={fakeSession()} />);
    await userEvent.type(screen.getByLabelText(/text to send/i), 'hi');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(requestPermission).toHaveBeenCalled();
  });

  it('asks when files are dropped', () => {
    const { container } = render(<TransferPanel session={fakeSession()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(requestPermission).toHaveBeenCalled();
  });

  /* Asking must never be what decides whether the file goes. */
  it('still sends when the browser has no Notification at all', async () => {
    vi.stubGlobal('Notification', undefined);
    const session = fakeSession();
    render(<TransferPanel session={session} />);
    await userEvent.type(screen.getByLabelText(/text to send/i), 'hi');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(session.sendText).toHaveBeenCalledWith('hi');
  });
});
