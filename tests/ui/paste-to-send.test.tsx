// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransferPanel } from '../../client/screens/TransferPanel.js';
import type { SessionHandle } from '../../client/hooks/useSession.js';
import type { LiveSessionEvents } from '../../client/media/live-session.js';

/*
 * TransferPanel builds a real `LiveSession` on mount, which reaches for
 * `RTCPeerConnection` — not implemented in jsdom at all. Mocked exactly as
 * tests/ui/transfer-panel.test.tsx mocks it, so this file can mount a real
 * component tree without touching WebRTC. Nothing here reads the constructed
 * session back, so this is the stub-only form of that fake.
 */
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

const shot = (name = 'screenshot.png'): File =>
  new File([new Uint8Array([1, 2])], name, { type: 'image/png' });

/**
 * A paste carrying files, dispatched at a real element.
 *
 * jsdom has no usable `DataTransfer`, so `clipboardData` is defined onto the
 * event directly — which is the whole of what the handler reads. The same
 * shape tests/ui/transfer-panel.test.tsx's drop test uses for `dataTransfer`.
 */
function paste(target: EventTarget, files: File[]): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files } });
  target.dispatchEvent(event);
  return event;
}

describe('pasting into a paired session', () => {
  let session: SessionHandle;

  beforeEach(() => {
    session = fakeSession();
  });

  it('sends a pasted file the way dropping it would', () => {
    render(<TransferPanel session={session} />);

    const event = paste(document.body, [shot()]);

    expect(session.sendFiles).toHaveBeenCalledTimes(1);
    expect(vi.mocked(session.sendFiles).mock.calls[0]![0].map((file) => file.name))
      .toEqual(['screenshot.png']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('sends every file in one paste', () => {
    render(<TransferPanel session={session} />);

    paste(document.body, [shot('one.png'), shot('two.png')]);

    expect(vi.mocked(session.sendFiles).mock.calls[0]![0]).toHaveLength(2);
  });

  it('never steals a paste aimed at the note composer', () => {
    render(<TransferPanel session={session} />);
    const composer = screen.getByRole('textbox');

    const event = paste(composer, [shot()]);

    // Hijacking this would make it impossible to paste a link into the one
    // control on the screen built for sending links.
    expect(session.sendFiles).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores a paste that carries no files', () => {
    render(<TransferPanel session={session} />);

    const event = paste(document.body, []);

    expect(session.sendFiles).not.toHaveBeenCalled();
    // Not prevented: an ordinary text paste must go on behaving ordinarily.
    expect(event.defaultPrevented).toBe(false);
  });

  it('sends nothing before both users have confirmed the number', () => {
    const unverified = fakeSession({ verifiedByMe: true, verifiedByPeer: false });
    render(<TransferPanel session={unverified} />);

    paste(document.body, [shot()]);

    // The clipboard is not an exception to the gate.
    expect(unverified.sendFiles).not.toHaveBeenCalled();
  });

  it('stops listening once the panel is gone', () => {
    const { unmount } = render(<TransferPanel session={session} />);

    unmount();
    paste(document.body, [shot()]);

    // A document-level listener that outlives its component would send into
    // a session that no longer exists.
    expect(session.sendFiles).not.toHaveBeenCalled();
  });
});
