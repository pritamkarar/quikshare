// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { DevicePanel } from '../../client/ui/DevicePanel.js';
import type { DeviceInfo } from '../../shared/device.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SELF: DeviceInfo = {
  id: 'a1b2-c3d4-e5f6', kind: 'desktop', os: 'macOS', browser: 'Safari',
  ip: '192.0.2.10', screen: '2560 × 1440',
};
const PEER: DeviceInfo = {
  id: '9f8e-7d6c-5b4a', kind: 'mobile', os: 'Android', browser: 'Chrome',
  ip: '198.51.100.7', screen: '412 × 915',
};

/** The card whose heading is `name`, so the two cards' values cannot be confused. */
function card(name: RegExp): HTMLElement {
  return screen.getByRole('heading', { name }).closest('li')!;
}

describe('DevicePanel', () => {
  it('shows each device on its own card, attributed to the right side', () => {
    render(<DevicePanel self={SELF} peer={PEER} />);

    const mine = within(card(/this device/i));
    expect(mine.getByText('Safari on macOS')).toBeInTheDocument();
    expect(mine.getByText('a1b2-c3d4-e5f6')).toBeInTheDocument();
    expect(mine.getByText('2560 × 1440')).toBeInTheDocument();
    expect(mine.getByText('Computer')).toBeInTheDocument();

    const theirs = within(card(/the other device/i));
    expect(theirs.getByText('Chrome on Android')).toBeInTheDocument();
    expect(theirs.getByText('9f8e-7d6c-5b4a')).toBeInTheDocument();
    expect(theirs.getByText('Phone')).toBeInTheDocument();
  });

  /*
   * The address is the most identifying thing either browser knows about
   * the other, and it answers none of the question these cards exist for.
   * It still crosses the wire (shared/device.ts) — this asserts that no
   * card puts it on screen, in either column, by any route.
   */
  it('never renders a device address, on either card', () => {
    render(<DevicePanel self={SELF} peer={PEER} />);

    expect(screen.queryByText(SELF.ip!)).not.toBeInTheDocument();
    expect(screen.queryByText(PEER.ip!)).not.toBeInTheDocument();
    expect(screen.queryByText(/ip address/i)).not.toBeInTheDocument();
  });

  /*
   * A card with no description is the ordinary state for the first instant
   * of every session, not an error -- so it says what it is waiting for
   * rather than rendering empty rows.
   */
  it('says what it is waiting for instead of showing blank rows', () => {
    render(<DevicePanel self={SELF} peer={undefined} />);
    const theirs = within(card(/the other device/i));
    expect(theirs.getByText(/waiting for the other device/i)).toBeInTheDocument();
    expect(theirs.queryByText(/device id/i)).not.toBeInTheDocument();
  });

  /*
   * A field the device could not supply -- an older relay that sends no
   * address, a browser with no usable `screen` -- must read as absent, not
   * as a blank value that looks like a rendering bug.
   */
  it('names a missing field rather than leaving it blank', () => {
    render(<DevicePanel self={{ ...SELF, screen: undefined }} peer={PEER} />);
    const mine = within(card(/this device/i));
    expect(mine.getByText('Not available')).toBeInTheDocument();
  });

  /*
   * AGENTS.md: status is never carried by colour or an icon alone. The
   * device kind has a written label beside its glyph on every card,
   * including the one that could not work out what it was looking at.
   */
  it('writes the device kind out, including when it is unknown', () => {
    render(<DevicePanel self={{ ...SELF, kind: 'unknown' }} peer={PEER} />);
    expect(within(card(/this device/i)).getByText('Unknown')).toBeInTheDocument();
  });

  /*
   * Two facts a user cannot infer from the cards, and both matter: the
   * details did not go through the relay in the clear, and nothing the other
   * side said about itself has been verified.
   */
  it('says the details are exchanged encrypted and are unverified claims', () => {
    render(<DevicePanel self={SELF} peer={PEER} />);
    expect(screen.getByText(/relay never sees them/i)).toBeInTheDocument();
    expect(screen.getByText(/is not\s+verified/i)).toBeInTheDocument();
  });
});
