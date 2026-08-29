// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TransportBadge } from '../../client/ui/TransportBadge.js';

describe('TransportBadge', () => {
  it('labels the direct path in words, not just color', () => {
    render(<TransportBadge kind="webrtc" />);
    const status = screen.getByRole('status');
    expect(within(status).getByText(/direct/i)).toBeInTheDocument();
    // Scoped to the badge itself (not the explanatory note, whose relay copy
    // legitimately contains the word "direct") so this can't pass by
    // accident if the badge rendered the other kind's label instead.
    expect(within(status).queryByText(/relayed/i)).not.toBeInTheDocument();
  });

  it('labels the relayed path in words', () => {
    render(<TransportBadge kind="relay" />);
    const status = screen.getByRole('status');
    expect(within(status).getByText(/relayed/i)).toBeInTheDocument();
    expect(within(status).queryByText(/^direct$/i)).not.toBeInTheDocument();
  });

  /*
   * The explanation used to sit permanently under the session heading. It
   * is now one click behind the chip — still in the document, still wired
   * to it, no longer a paragraph in the way of the workspace.
   *
   * Asserted as *wiring*, not as a click: jsdom hides a closed [popover]
   * (which is why `queryByRole('note')` comes back empty) but does not
   * implement invoker activation, so clicking here would prove nothing
   * either way. That the click actually opens it is asserted against a real
   * browser in tests/e2e/session-layout.spec.ts, which is the only place it
   * can be.
   */
  it('keeps the explanation behind the badge rather than always on screen', () => {
    render(<TransportBadge kind="relay" />);

    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    const note = screen.getByRole('note', { hidden: true });
    expect(note).toHaveTextContent(/encrypted/i);
    expect(screen.getByRole('button').getAttribute('popovertarget'))
      .toBe(note.closest('[popover]')?.id);
  });

  it('names the chip as a control, keeping the visible label inside the name', () => {
    // WCAG 2.5.3: the accessible name must contain the visible text, or
    // speech input ("click Direct") cannot reach it.
    render(<TransportBadge kind="webrtc" />);
    expect(screen.getByRole('button')).toHaveAccessibleName(/direct/i);
  });

  it('announces a transport change politely', () => {
    render(<TransportBadge kind="webrtc" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('also wires the relayed announcement politely, not just the direct one', () => {
    // A component that only sets aria-live on one branch of a kind switch
    // would still pass the test above; this exercises the other branch.
    render(<TransportBadge kind="relay" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  // Design decision (see task-4-report.md): relaying is the fallback path
  // the whole design exists to provide, not a fault, and its copy says so
  // ("still encrypted end to end"). A warning color beside reassuring text
  // is a contradiction, not the redundant cue AGENTS.md asks for — so this
  // deliberately does NOT use Badge's `relayed` (warning-colored) tone.
  it('uses an informational tone for the fallback path, not a warning color', () => {
    const { container } = render(<TransportBadge kind="relay" />);
    const badgeEl = container.querySelector('[role="status"] button > span');
    expect(badgeEl).not.toBeNull();
    expect(badgeEl?.className).not.toMatch(/color-warning/);
  });

  it('uses the live tone for the direct path', () => {
    const { container } = render(<TransportBadge kind="webrtc" />);
    const badgeEl = container.querySelector('[role="status"] button > span');
    expect(badgeEl).not.toBeNull();
    expect(badgeEl?.className).toMatch(/color-success/);
  });
});
