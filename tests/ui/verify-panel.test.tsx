// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { VerifyPanel } from '../../client/ui/VerifyPanel.js';
import { TransferPanel } from '../../client/screens/TransferPanel.js';
import type { SessionHandle } from '../../client/hooks/useSession.js';

vi.mock('../../client/media/live-session.js', () => ({
  // TransferPanel builds one per mount and jsdom has no RTCPeerConnection.
  LiveSession: class {
    start = vi.fn();
    stop = vi.fn();
    onPeerLeft = vi.fn();
    onMediaSignal = vi.fn();
  },
}));

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
    selfDevice: undefined,
    peerDevice: undefined,
    verification: '482193',
    verifiedByMe: false,
    verifiedByPeer: false,
    confirmVerification: vi.fn(),
    endSession: vi.fn(async () => {}),
    // Off by default: the folder control is Chromium-desktop only, and
    // every test here that predates it asserts on a panel without one.
    canChooseFolder: false,
    saveFolder: undefined,
    chooseFolder: vi.fn(),
    sendFiles: vi.fn(),
    cancelFiles: vi.fn(),
    sendText: vi.fn(),
    sendMediaSignal: vi.fn(),
    onMediaSignal: () => () => undefined,
    ...over,
  };
}

describe('VerifyPanel', () => {
  it('shows the number grouped for reading aloud', () => {
    render(<VerifyPanel digits="482193" verifiedByMe={false} verifiedByPeer={false} onConfirm={vi.fn()} />);
    expect(screen.getByText('482 193')).toBeInTheDocument();
  });

  /*
   * An auto-translated digit group would be compared against an
   * untranslated one on the other device and read as a mismatch — of the
   * two failure modes that produces (a session abandoned for no reason, or
   * a user taught to ignore the check), neither is acceptable.
   */
  it('opts the number out of machine translation', () => {
    render(<VerifyPanel digits="482193" verifiedByMe={false} verifiedByPeer={false} onConfirm={vi.fn()} />);
    expect(screen.getByText('482 193')).toHaveAttribute('translate', 'no');
  });

  it('confirms once, then says what it is waiting for', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <VerifyPanel digits="482193" verifiedByMe={false} verifiedByPeer={false} onConfirm={onConfirm} />,
    );

    await user.click(screen.getByRole('button', { name: /numbers match/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(<VerifyPanel digits="482193" verifiedByMe verifiedByPeer={false} onConfirm={onConfirm} />);
    // Not a blank space where the button was: the user has done their half
    // and the screen says whose turn it is.
    expect(screen.getByText(/waiting for the other device/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /numbers match/i })).not.toBeInTheDocument();
  });

  /*
   * The joiner is 'paired' as soon as the relay answers, which is before the
   * key agreement has finished — a real window, short but not zero. An empty
   * column where the send controls are about to be would read as a broken
   * screen.
   */
  it('says what it is doing before a number exists, rather than rendering nothing', () => {
    render(<VerifyPanel digits={undefined} verifiedByMe={false} verifiedByPeer={false} onConfirm={vi.fn()} />);
    expect(screen.getByText(/agreeing a key/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

/*
 * The gate itself, at the level a user meets it. `Session` refuses every send
 * until both ends confirm (client/session.ts's `#requireVerified`), so a drop
 * zone rendered before then is a control that can only produce errors — the
 * panel must not offer one.
 */
describe('TransferPanel: the verification gate', () => {
  it('offers the number instead of the send controls until both sides confirm', () => {
    render(<TransferPanel session={fakeSession()} />);

    expect(screen.getByText('482 193')).toBeInTheDocument();
    expect(screen.queryByText(/drop files/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /share camera/i })).not.toBeInTheDocument();
  });

  it('still hides them when only this device has confirmed', () => {
    render(<TransferPanel session={fakeSession({ verifiedByMe: true })} />);

    // 'Confirmed here', not the 'waiting' half of that sentence: the header
    // above is also on this screen, and its peer end says "Waiting…" too.
    expect(screen.getByText(/confirmed here/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /share camera/i })).not.toBeInTheDocument();
  });

  it('hands over the send controls once both have', () => {
    render(<TransferPanel session={fakeSession({ verifiedByMe: true, verifiedByPeer: true })} />);

    expect(screen.queryByText('482 193')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /share camera/i })).toBeInTheDocument();
  });

  /*
   * The workspace is gated whole, and this replaces the opposite ruling.
   * The Transfers column used to stay mounted throughout, on the grounds
   * that nothing can arrive before both devices confirm — so an empty
   * record beside the number was the honest state rather than a hidden one
   * — and that the folder picker had real work to do during the wait. Both
   * still hold. The call went the other way anyway: comparing six digits
   * across two screens is the entire job at that moment, and every other
   * region is something to look at instead of doing it.
   */
  it('shows nothing but the gate until both devices have confirmed', () => {
    // canChooseFolder on, or the folder assertion below proves nothing: the
    // default fixture cannot offer a picker in either state.
    const { rerender } = render(<TransferPanel session={fakeSession({ canChooseFolder: true })} />);

    for (const name of [/share/i, /transfers/i]) {
      expect(screen.queryByRole('region', { name })).not.toBeInTheDocument();
    }
    // Including the folder picker, which lives in the Transfers column and
    // is the one control this costs: it was worth offering before any file
    // could arrive. Named here so its absence reads as the decision it is.
    expect(screen.queryByRole('button', { name: /save to a folder|change folder/i })).not.toBeInTheDocument();

    rerender(
      <TransferPanel
        session={fakeSession({ canChooseFolder: true, verifiedByMe: true, verifiedByPeer: true })}
      />,
    );
    for (const name of [/share/i, /transfers/i]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /save to a folder|change folder/i })).toBeInTheDocument();
  });

  /*
   * Half a gate is still a gate. This device's own click cannot reveal the
   * workspace on its own, because Session still refuses every send until the
   * peer has confirmed too — controls that could only produce errors.
   */
  it('keeps the workspace hidden when only this device has confirmed', () => {
    render(<TransferPanel session={fakeSession({ verifiedByMe: true })} />);
    expect(screen.queryByRole('region', { name: /share/i })).not.toBeInTheDocument();
    expect(screen.getByText(/confirmed here/i)).toBeInTheDocument();
  });
});
