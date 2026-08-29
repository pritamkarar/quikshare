// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionHeader } from '../../client/ui/SessionHeader.js';
import type { DeviceInfo } from '../../shared/device.js';

afterEach(cleanup);

const SELF: DeviceInfo = {
  id: 'a1b2-c3d4-e5f6', kind: 'desktop', os: 'macOS', browser: 'Safari',
  ip: '192.0.2.10', screen: '2560 × 1440',
};
const PEER: DeviceInfo = {
  id: '9f8e-7d6c-5b4a', kind: 'mobile', os: 'Android', browser: 'Chrome',
  ip: '198.51.100.7', screen: '412 × 915',
};

function renderHeader(over: Partial<Parameters<typeof SessionHeader>[0]> = {}) {
  return render(
    <SessionHeader
      code="K7M3QP"
      transportKind="relay"
      self={SELF}
      peer={PEER}
      onEnd={vi.fn()}
      {...over}
    />,
  );
}

describe('SessionHeader', () => {
  it('names both ends of the link, and says which one is yours', () => {
    renderHeader();
    expect(screen.getByText('This device')).toBeInTheDocument();
    expect(screen.getByText('macOS')).toBeInTheDocument();
    expect(screen.getByText('The other device')).toBeInTheDocument();
    expect(screen.getByText('Android')).toBeInTheDocument();
  });

  it('says what it is waiting for rather than drawing a nameless device', () => {
    renderHeader({ peer: undefined });
    expect(screen.getByText(/waiting/i)).toBeInTheDocument();
  });

  it('shows the session code, labelled for anyone who cannot see the layout', () => {
    renderHeader();
    expect(screen.getByText('K7M3QP')).toBeInTheDocument();
    expect(screen.getByText(/session code/i)).toBeInTheDocument();
  });

  /*
   * A batch progress bar and per-direction "Sent 2 files" tallies used to sit
   * to the right of the link. They are gone on purpose: the transfer record
   * below this card already answers "what has moved", per file, and the
   * header saying it again a card higher was the same question answered
   * twice. This asserts the removal rather than trusting it, since the props
   * it was derived from are gone too — nothing else would fail if a summary
   * crept back in.
   */
  it('says nothing about what the session has moved', () => {
    renderHeader();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/moving/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Sent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Received/)).not.toBeInTheDocument();
  });

  it('ends the session through its own callback rather than navigating itself', async () => {
    const onEnd = vi.fn();
    renderHeader({ onEnd });
    await userEvent.click(screen.getByRole('button', { name: /end session/i }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations', async () => {
    const { container } = renderHeader();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
