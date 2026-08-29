// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidScreen } from '../../client/screens/InvalidScreen.js';
import { VerifyPanel } from '../../client/ui/VerifyPanel.js';
import { JoinScreen } from '../../client/screens/JoinScreen.js';
import { TransferRecord } from '../../client/ui/TransferRecord.js';
import { TextSnippet } from '../../client/ui/TextSnippet.js';
import { DropZone } from '../../client/ui/DropZone.js';
import { QRPanel } from '../../client/ui/QRPanel.js';
import { JoinLink } from '../../client/ui/JoinLink.js';
import { DevicePanel } from '../../client/ui/DevicePanel.js';
import { AppHeader } from '../../client/ui/AppHeader.js';
import { LiveSection } from '../../client/ui/LiveSection.js';
import type { ScannerStatus } from '../../client/hooks/useQRScanner.js';
import type { TrackedFile, TrackedNote } from '../../client/hooks/useSession.js';
import type { Slot } from '../../client/media/live-session.js';
import type { MediaPeer } from '../../client/media/media-peer.js';

// Mutable so a single test (the JoinScreen focus-order case below) can put
// the camera button on screen; every other test leaves it at the default
// ('unsupported', camera hidden) that the rest of this suite was written
// against. Reset in afterEach so no test leaks its status into the next.
const scanner = vi.hoisted(() => ({ status: 'unsupported' as ScannerStatus }));
vi.mock('../../client/hooks/useQRScanner.js', () => ({
  useQRScanner: () => ({ videoRef: { current: null }, status: scanner.status, start: vi.fn() }),
}));

// QRPanel draws through the real `qrcode` package's canvas API, which jsdom's
// <canvas> does not implement — same stub `create-screen.test.tsx` uses.
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(async () => undefined) },
  toCanvas: vi.fn(async () => undefined),
}));

afterEach(() => {
  scanner.status = 'unsupported';
});

/**
 * Raw `axe.Result[]` dumps unreadable nested node/target objects on failure
 * and never names the rule that actually broke — costing a debugging session
 * to find the first real violation. Mapped down to the rule id, its help
 * text, and how many nodes it hit, so a failing `toEqual` names the broken
 * rule directly.
 */
async function violations(node: HTMLElement): Promise<Array<{ id: string; help: string; nodes: number }>> {
  const results = await axe.run(node, {
    // jsdom does no layout and cannot compute rendered color, so this is the
    // one rule axe cannot meaningfully check here — not relaxed for any
    // other reason. See task-12-report.md for how contrast is verified instead.
    rules: { 'color-contrast': { enabled: false } },
  });
  return results.violations.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.length }));
}

const SELF_DEVICE = {
  id: 'a1b2-c3d4-e5f6', kind: 'desktop' as const, os: 'macOS', browser: 'Safari',
  ip: '192.0.2.10', screen: '2560 × 1440',
};
const PEER_DEVICE = {
  id: '9f8e-7d6c-5b4a', kind: 'mobile' as const, os: 'Android', browser: 'Chrome',
  ip: '198.51.100.7', screen: '412 × 915',
};

const FILE: TrackedFile = {
  meta: { id: 1, name: 'a.bin', size: 10, type: '' },
  direction: 'receive',
  bytesMoved: 5,
  bytesPerSecond: 1,
  done: false,
  seq: 1,
};

describe('accessibility: axe', () => {
  it('join screen has no axe violations', async () => {
    const { container } = render(<JoinScreen onJoin={vi.fn()} />);
    expect(await violations(container)).toEqual([]);
  });

  // The camera preview is mounted at every status now (it has to exist before
  // `start()` runs — see JoinScreen), so the audit sees a <video> it never saw
  // before. 'scanning' is the status where that element is actually visible,
  // and it had never been audited at all.
  it('join screen has no axe violations while the camera is scanning', async () => {
    scanner.status = 'scanning';
    const { container } = render(<JoinScreen onJoin={vi.fn()} />);
    expect(await violations(container)).toEqual([]);
  });

  it('join screen has no axe violations with the camera offered but idle', async () => {
    scanner.status = 'idle';
    const { container } = render(<JoinScreen onJoin={vi.fn()} />);
    expect(await violations(container)).toEqual([]);
  });

  // InvalidScreenProps['reason'] is 'bad-code' | 'expired' | 'disconnected'
  // (the last one added for the room-is-gone case a Reconnector's
  // `not-found` outcome reaches — see reconnect.ts). All three render
  // distinct copy (see InvalidScreen.tsx's COPY map), and therefore distinct
  // DOM, so all three are audited rather than one standing in for another.
  it('invalid screen (bad-code) has no axe violations', async () => {
    const { container } = render(<InvalidScreen reason="bad-code" />);
    expect(await violations(container)).toEqual([]);
  });


  it('invalid screen (expired) has no axe violations', async () => {
    const { container } = render(<InvalidScreen reason="expired" />);
    expect(await violations(container)).toEqual([]);
  });

  /*
   * All three states of the verification gate, because they render three
   * different trees: a number with a button, a number with a status line
   * where the button was, and the pre-number placeholder. It is the one
   * thing on the session screen a user MUST read and act on, so an audit of
   * only the first would be an audit of the easy case.
   */
  it('verify panel has no axe violations while it is waiting to be confirmed', async () => {
    const { container } = render(
      <VerifyPanel digits="482193" verifiedByMe={false} verifiedByPeer={false} onConfirm={vi.fn()} />,
    );
    expect(await violations(container)).toEqual([]);
  });

  it('verify panel has no axe violations once this device has confirmed', async () => {
    const { container } = render(
      <VerifyPanel digits="482193" verifiedByMe verifiedByPeer={false} onConfirm={vi.fn()} />,
    );
    expect(await violations(container)).toEqual([]);
  });

  it('verify panel has no axe violations before a number exists', async () => {
    const { container } = render(
      <VerifyPanel digits={undefined} verifiedByMe={false} verifiedByPeer={false} onConfirm={vi.fn()} />,
    );
    expect(await violations(container)).toEqual([]);
  });

  /*
   * Both states, because they render different DOM: a described device shows
   * a <dl> of rows that the empty one does not have at all, so auditing one
   * would say nothing about the other.
   */
  it('device panel has no axe violations once both devices are known', async () => {
    const { container } = render(<DevicePanel self={SELF_DEVICE} peer={PEER_DEVICE} />);
    expect(await violations(container)).toEqual([]);
  });

  it('device panel has no axe violations while it is still waiting', async () => {
    const { container } = render(<DevicePanel self={undefined} peer={undefined} />);
    expect(await violations(container)).toEqual([]);
  });

  it('app header has no axe violations', async () => {
    const { container } = render(<AppHeader />);
    expect(await violations(container)).toEqual([]);
  });

  /*
   * Both states, because they render different DOM: a populated record shows
   * the filter chip group and a list of rows that the empty one does not
   * have at all (an EmptyState card instead), so auditing one would say
   * nothing about the other — same reasoning as the device panel above.
   */
  it('transfer record has no axe violations once it has something to show', async () => {
    const { container } = render(<TransferRecord files={[FILE]} notes={[]} />);
    expect(await violations(container)).toEqual([]);
  });

  it('transfer record has no axe violations while empty', async () => {
    const { container } = render(<TransferRecord files={[]} notes={[]} />);
    expect(await violations(container)).toEqual([]);
  });

  it('text snippet has no axe violations', async () => {
    const { container } = render(<TextSnippet onSend={vi.fn()} />);
    expect(await violations(container)).toEqual([]);
  });

  // Ruling 2: DropZone and QRPanel carry the richest interaction surface
  // (drag-and-drop, a generated QR image) and are audited directly, rather
  // than only through CreateScreen/SessionScreen, which need session mocking
  // to render at all.
  it('drop zone has no axe violations', async () => {
    const { container } = render(<DropZone onFiles={vi.fn()} />);
    expect(await violations(container)).toEqual([]);
  });

  it('qr panel has no axe violations', async () => {
    const { container } = render(<QRPanel shareUrl="https://x.dev/s/K7M3QP#key" code="K7M3QP" />);
    expect(await violations(container)).toEqual([]);
  });

  /*
   * Idle no longer renders anything at all — its two start buttons, the
   * failure alert, and the one-stream note moved to TransferPanel's Share
   * section (Task 8; see LiveSection.tsx's own doc comment on why), which
   * is audited separately below. An empty container has nothing for axe to
   * flag, so the only LiveSection state left worth auditing on its own is
   * an active share: the 'sending' variant of Slot with a camera stream
   * (Mute mic present), since that is the state exercising the most DOM at
   * once — an audio-carrying video plus two buttons — of any of Slot's
   * non-idle variants.
   */
  it('live section has no axe violations while actively sharing a camera', async () => {
    const stream = {
      id: 'a11y-stream',
      getAudioTracks: () => [{ kind: 'audio', enabled: true }],
      getVideoTracks: () => [{ kind: 'video', enabled: true }],
      getTracks: () => [],
    } as unknown as MediaStream;
    const slot: Slot = { state: 'sending', kind: 'camera', peer: {} as unknown as MediaPeer, stream };
    const { container } = render(<LiveSection slot={slot} turnAvailable onStop={vi.fn()} />);
    expect(await violations(container)).toEqual([]);
  });
});

/** Elements a Tab key can land on, absent any positive tabindex (checked
 * separately below, and never expected to exist in this codebase). */
const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]';

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1',
  );
}

function positiveTabIndexes(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[tabindex]')].filter(
    (el) => Number(el.getAttribute('tabindex')) > 0,
  );
}

function focusableInsideAriaHidden(container: HTMLElement): HTMLElement[] {
  return focusableElements(container).filter((el) => el.closest('[aria-hidden="true"]') !== null);
}

/**
 * Ruling 4 turns the brief's Step 3 (a real-browser keyboard walkthrough)
 * into what jsdom actually can check: the two invariants below, over every
 * component this file audits. Focus-ring *visibility* and sticky-overlap
 * need real layout and a real renderer — jsdom has neither — and are not
 * asserted here; see task-12-report.md's "could not verify" section.
 */
const FOCUS_CASES: Array<[string, () => HTMLElement]> = [
  ['JoinScreen', () => render(<JoinScreen onJoin={vi.fn()} />).container],
  ['JoinScreen (scanning)', () => {
    scanner.status = 'scanning';
    return render(<JoinScreen onJoin={vi.fn()} />).container;
  }],
  ['InvalidScreen (bad-code)', () => render(<InvalidScreen reason="bad-code" />).container],
  ['InvalidScreen (expired)', () => render(<InvalidScreen reason="expired" />).container],
  ['VerifyPanel', () => render(
    <VerifyPanel digits="482193" verifiedByMe={false} verifiedByPeer={false} onConfirm={vi.fn()} />,
  ).container],
  // No 'LiveSection (idle)' case: idle renders nothing at all now (Task 8
  // hoisted its buttons into TransferPanel's Share section — see the axe
  // describe block above), so there is no focusable content to check.
  ['LiveSection (sharing a camera)', () => {
    const stream = {
      id: 'a11y-focus-stream',
      getAudioTracks: () => [{ kind: 'audio', enabled: true }],
      getVideoTracks: () => [{ kind: 'video', enabled: true }],
      getTracks: () => [],
    } as unknown as MediaStream;
    const slot: Slot = { state: 'sending', kind: 'camera', peer: {} as unknown as MediaPeer, stream };
    return render(<LiveSection slot={slot} turnAvailable onStop={vi.fn()} />).container;
  }],
  ['TransferRecord', () => render(<TransferRecord files={[FILE]} notes={[]} />).container],
  ['TransferRecord (empty)', () => render(<TransferRecord files={[]} notes={[]} />).container],
  ['TextSnippet', () => render(<TextSnippet onSend={vi.fn()} />).container],
  ['DropZone', () => render(<DropZone onFiles={vi.fn()} />).container],
  ['QRPanel', () => render(<QRPanel shareUrl="https://x.dev/s/K7M3QP#key" code="K7M3QP" />).container],
];

describe.each(FOCUS_CASES)('accessibility: focus invariants — %s', (_name, renderCase) => {
  it('never uses a positive tabindex', () => {
    expect(positiveTabIndexes(renderCase())).toEqual([]);
  });

  it('never hides a focusable element inside an aria-hidden subtree', () => {
    expect(focusableInsideAriaHidden(renderCase())).toEqual([]);
  });
});

/**
 * The check axe cannot do. axe-core has no tap-target rule at all — which is
 * why a deferred "these links are ~20px tall" finding was reported clean by a
 * zero-violations audit — and jsdom computes no layout, so a real height is
 * not measurable here either. The class is the observable: `min-h-11` is
 * 44px, AGENTS.md's mobile floor.
 */
const DOWNLOADED: TrackedFile = {
  meta: { id: 2, name: 'b.bin', size: 10, type: '' },
  direction: 'receive',
  bytesMoved: 10,
  bytesPerSecond: 0,
  done: true,
  blobUrl: 'blob:2',
  seq: 2,
};

const TAP_TARGET_CASES: Array<[string, () => HTMLElement]> = [
  ['JoinLink', () => render(<JoinLink />).container],
  ['InvalidScreen (bad-code)', () => render(<InvalidScreen reason="bad-code" />).container],
  ['TransferRecord (completed download)', () => render(<TransferRecord files={[DOWNLOADED]} notes={[]} />).container],
];

/**
 * Tailwind's spacing unit is 4px, so `min-h-11` is the 44px floor. The number
 * is parsed rather than pattern-matched: a check for `min-h-\d` would wave
 * `min-h-1` (4px) straight through and report it as a pass, which is the same
 * false green that let this finding sit through two task reviews.
 */
const MIN_TAP_UNITS = 11;

function tapTargetUnits(element: Element): number {
  const match = /(?:^|\s)min-h-(\d+)(?:\s|$)/.exec(element.className);
  return match ? Number(match[1]) : 0;
}

describe.each(TAP_TARGET_CASES)('accessibility: tap targets — %s', (_name, renderCase) => {
  it('gives every link a hit target tall enough to hit on a phone', () => {
    const undersized = [...renderCase().querySelectorAll('a[href]')]
      .filter((link) => tapTargetUnits(link) < MIN_TAP_UNITS)
      .map((link) => link.textContent?.trim());

    expect(undersized).toEqual([]);
  });
});

describe('accessibility: the tap-target check itself', () => {
  // The check is the only thing standing behind a rule axe cannot see, so it
  // has to fail on an undersized target rather than on a missing class alone.
  it('rejects a link that carries a min-h below the floor', () => {
    const { container } = render(<a href="/x" className="min-h-1 underline">Too small</a>);
    const link = container.querySelector('a')!;

    expect(tapTargetUnits(link)).toBeLessThan(MIN_TAP_UNITS);
  });
});

describe('accessibility: tab order matches visual order', () => {
  /*
   * Inherited from the old "text snippet: the note field, then each
   * received item's Copy button in order" test. The received-notes list and
   * its Copy buttons moved off TextSnippet and onto TransferRecord's note
   * rows (see TextSnippet.tsx's doc comment), so this now walks
   * TransferRecord's own tab order instead: the filter chip group (All/
   * Sent/Received) precedes the rows in the DOM, so tab order reaches it
   * before any row's Copy button.
   */
  it('transfer record: the filter chips, then each note\'s Copy button in row order', async () => {
    const user = userEvent.setup();
    const notes: TrackedNote[] = [
      { seq: 1, direction: 'receive', content: 'a' },
      { seq: 2, direction: 'receive', content: 'b' },
      { seq: 3, direction: 'receive', content: 'c' },
    ];
    render(<TransferRecord files={[]} notes={notes} />);
    const expected = [
      screen.getByRole('button', { name: /^all$/i }),
      screen.getByRole('button', { name: /^sent$/i }),
      screen.getByRole('button', { name: /^received$/i }),
      // Newest first: seq 3's row renders before seq 2's, which renders
      // before seq 1's.
      screen.getByLabelText(/copy received note 3/i),
      screen.getByLabelText(/copy received note 2/i),
      screen.getByLabelText(/copy received note 1/i),
    ];

    for (const el of expected) {
      await user.tab();
      expect(document.activeElement).toBe(el);
    }
  });

  it('transfer record: completed downloads in row order', async () => {
    const user = userEvent.setup();
    const files: TrackedFile[] = [
      { meta: { id: 1, name: 'first.bin', size: 10, type: '' }, direction: 'receive', bytesMoved: 10, bytesPerSecond: 0, done: true, blobUrl: 'blob:1', seq: 2 },
      { meta: { id: 2, name: 'second.bin', size: 10, type: '' }, direction: 'receive', bytesMoved: 10, bytesPerSecond: 0, done: true, blobUrl: 'blob:2', seq: 1 },
    ];
    render(<TransferRecord files={files} notes={[]} />);

    // Each link's accessible name now includes its file name (see
    // TransferRecord.tsx), so these two lookups pin "first" and "second" to
    // the row that actually belongs to that file, independent of wherever it
    // landed in the DOM. A row-order regression fails here, or fails below
    // when it doesn't match tab order — not silently passing either way as
    // it did when every link shared the name "Save". first.bin outranks
    // second.bin's seq, so it renders first (newest first).
    const first = screen.getByRole('link', { name: 'Save first.bin' });
    const second = screen.getByRole('link', { name: 'Save second.bin' });
    expect(first).toHaveAttribute('href', 'blob:1');
    expect(second).toHaveAttribute('href', 'blob:2');

    // The filter chip group precedes the record's own rows in the DOM, so
    // tab order reaches it before either download link.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^all$/i }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^sent$/i }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^received$/i }));
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.tab();
    expect(document.activeElement).toBe(second);
  });

  it('invalid screen (bad-code): Start a new session, then the retry link', async () => {
    const user = userEvent.setup();
    render(<InvalidScreen reason="bad-code" />);
    const startOver = screen.getByRole('button', { name: /start a new session/i });
    const tryAgain = screen.getByRole('link', { name: /try the code again/i });

    await user.tab();
    expect(document.activeElement).toBe(startOver);
    await user.tab();
    expect(document.activeElement).toBe(tryAgain);
  });

  it('join screen: Use the camera, then the code input — even though autofocus lands on the input first', async () => {
    scanner.status = 'idle';
    const user = userEvent.setup();
    render(<JoinScreen onJoin={vi.fn()} />);
    const cameraButton = screen.getByRole('button', { name: /use the camera/i });
    const codeInput = screen.getByLabelText(/session code/i);

    // Autofocus (see JoinScreen.tsx) puts focus on the code input on mount,
    // ahead of any Tab press. Cleared here so the assertions below reflect
    // the DOM's actual tab order — camera button, then code input — rather
    // than the mid-sequence order visible from wherever autofocus left off.
    (document.activeElement as HTMLElement | null)?.blur();

    await user.tab();
    expect(document.activeElement).toBe(cameraButton);
    await user.tab();
    expect(document.activeElement).toBe(codeInput);
  });
});
