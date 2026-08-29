// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JoinScreen } from '../../client/screens/JoinScreen.js';
import { InvalidScreen } from '../../client/screens/InvalidScreen.js';

const KEY = 'a'.repeat(43);

vi.mock('../../client/hooks/useQRScanner.js', () => ({
  useQRScanner: () => ({ videoRef: { current: null }, status: 'unsupported', start: vi.fn() }),
}));

afterEach(() => {
  // @ts-expect-error -- test-only cleanup of a test-only stub.
  delete window.matchMedia;
});

describe('JoinScreen', () => {
  it('always offers manual code entry', () => {
    render(<JoinScreen onJoin={vi.fn()} />);
    expect(screen.getByLabelText(/session code/i)).toBeInTheDocument();
  });

  it('submits a typed code', async () => {
    const onJoin = vi.fn();
    render(<JoinScreen onJoin={onJoin} />);
    await userEvent.type(screen.getByLabelText(/session code/i), 'K7M3QP{Enter}');
    expect(onJoin).toHaveBeenCalledWith('K7M3QP');
  });

  it('explains that the camera is unavailable instead of failing silently', () => {
    render(<JoinScreen onJoin={vi.fn()} />);
    expect(screen.getByText(/camera/i)).toBeInTheDocument();
  });

  // A pasted full share link must not be silently truncated by the input's
  // maxLength, and pasting one is a complete action — same as a QR scan — so
  // it should not need a separate Enter press.
  it('joins immediately when a full share link is pasted', () => {
    const onJoin = vi.fn();
    render(<JoinScreen onJoin={onJoin} />);
    const input = screen.getByLabelText(/session code/i);
    fireEventPaste(input, 'https://host.example/s/K7M3QP');
    expect(onJoin).toHaveBeenCalledWith('K7M3QP');
  });

  // The "someone's chat app truncated the URL at the #" case, which used to
  // land on a dead 'missing-key' screen. There is nothing after the code to
  // lose any more, so an old link with a fragment still on it joins exactly
  // like the short one.
  it('joins from an older link that still carries a key fragment', () => {
    const onJoin = vi.fn();
    render(<JoinScreen onJoin={onJoin} />);
    const input = screen.getByLabelText(/session code/i);
    fireEventPaste(input, `https://host.example/s/K7M3QP#${KEY}`);
    expect(onJoin).toHaveBeenCalledWith('K7M3QP');
  });

  it('leaves a plain pasted code for the normal paste path, unaffected', () => {
    const onJoin = vi.fn();
    render(<JoinScreen onJoin={onJoin} />);
    const input = screen.getByLabelText(/session code/i);
    const notCancelled = fireEventPaste(input, 'K7M3QP');
    expect(notCancelled).toBe(true);
    expect(onJoin).not.toHaveBeenCalled();
  });

  it('focuses manual entry on mount so a keyboard user can start typing immediately', () => {
    render(<JoinScreen onJoin={vi.fn()} />);
    expect(screen.getByLabelText(/session code/i)).toHaveFocus();
  });

  // Minor 1: a coarse (touch) pointer is this screen's signal that the
  // on-screen keyboard would otherwise pop up over the "Use the camera"
  // decision, so autofocus is withheld there even though it's on by default
  // everywhere `matchMedia` is unavailable (including the test above).
  it('does not autofocus manual entry on a coarse (touch) pointer', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    render(<JoinScreen onJoin={vi.fn()} />);
    expect(screen.getByLabelText(/session code/i)).not.toHaveFocus();
  });

  // Minor 2: the camera status text must live in a live region that's
  // already present before it has anything new to say, or a screen-reader
  // user who taps "Use the camera" and is then denied hears nothing.
  it('announces a camera status change through a live region', () => {
    render(<JoinScreen onJoin={vi.fn()} />);
    expect(screen.getByText(/camera/i)).toHaveAttribute('aria-live', 'polite');
  });
});

describe('InvalidScreen', () => {
  it('explains a bad code and offers a way forward', () => {
    render(<InvalidScreen reason="bad-code" />);
    expect(screen.getByRole('button', { name: /start a new session/i })).toBeInTheDocument();
  });

  // The room-is-gone case: a reconnect attempt that reaches the relay and is
  // told `not-found` (the room itself no longer exists), as opposed to
  // `bad-code` (a mistyped code was never a real room). Distinct enough that
  // it needs its own heading and body, not a reuse of the other.
  it('explains the room itself is gone, distinctly from bad-code', () => {
    const badCode = render(<InvalidScreen reason="bad-code" />);
    const badCodeHeading = screen.getByRole('heading').textContent;
    badCode.unmount();

    render(<InvalidScreen reason="expired" />);
    const expiredHeading = screen.getByRole('heading').textContent;

    expect(expiredHeading).not.toBe(badCodeHeading);
    expect(screen.getByRole('button', { name: /start a new session/i })).toBeInTheDocument();
  });
});

/**
 * A minimal, deterministic stand-in for a real paste: jsdom implements no
 * default action for the `paste` event (no built-in text insertion), so
 * `userEvent.paste()` cannot be used to observe insertion either way — only
 * dispatch is meaningful here, which is exactly what these tests check
 * (was the event handled and prevented, or left for the browser?).
 * Returns the boolean `dispatchEvent` result: `false` if `preventDefault()`
 * was called.
 */
function fireEventPaste(element: Element, text: string): boolean {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: () => text },
  });
  return element.dispatchEvent(event);
}
