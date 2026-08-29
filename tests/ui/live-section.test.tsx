// @vitest-environment jsdom
/*
 * LiveSection renders every *active* state of the session's one live-media
 * slot (client/media/live-session.ts's `Slot` union) — offering, sending,
 * connecting, watching — plus the no-TURN caution that travels alongside
 * every one of them. The component takes all of it as props precisely so it
 * can be driven here without a browser, a peer or a camera — see the task
 * brief.
 *
 * Idle no longer belongs to this file: Task 8 hoisted the two start
 * buttons, the failure alert, and the one-stream note out of LiveSection's
 * idle branch and into TransferPanel's Share section (spec §6's layout mock
 * places them there, always present, not gated on Live's state — see
 * LiveSection.tsx's own component doc comment for the full reasoning).
 * `LiveSection` itself renders `null` for `{ state: 'idle' }` now, and that
 * is the entire idle behaviour left to prove here — everything the old
 * idle-branch tests covered (both buttons enabled, onStart wiring, the
 * failure alert's wording, the idle no-TURN caution) now belongs to
 * tests/ui/transfer-panel.test.tsx, which owns the Share section these
 * moved into.
 *
 * Fakes follow tests/unit/live-session.test.ts's own pattern (a minimal
 * FakeTrack, a stream built from plain objects rather than a real
 * MediaStream, which jsdom does not implement) rather than inventing a
 * second style.
 */
import { useRef, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LiveSection } from '../../client/ui/LiveSection.js';
import type { CameraState, Slot } from '../../client/media/live-session.js';
import type { MediaPeer } from '../../client/media/media-peer.js';

/** LiveSection never reads `.peer` — every Slot variant just needs one to satisfy the type. */
const FAKE_PEER = {} as unknown as MediaPeer;

/** Stands in for a local/remote MediaStreamTrack: only `.enabled` and `.kind` matter here. */
class FakeTrack {
  enabled = true;
  constructor(public kind: 'audio' | 'video') {}
}

let nextStreamId = 0;

/** A stream with a fresh `.id` per call, matching what a real capture() produces each attempt. */
function fakeStream(tracks: FakeTrack[]): MediaStream {
  const id = `stream-${nextStreamId++}`;
  return {
    id,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  } as unknown as MediaStream;
}

function cameraStream(): { stream: MediaStream; audio: FakeTrack } {
  const audio = new FakeTrack('audio');
  const video = new FakeTrack('video');
  return { stream: fakeStream([video, audio]), audio };
}

function screenStream(): MediaStream {
  return fakeStream([new FakeTrack('video')]);
}

const IDLE: Slot = { state: 'idle' };

function noop() {}

describe('LiveSection: idle', () => {
  it('renders nothing at all — the start buttons now live in TransferPanel\'s Share section', () => {
    const { container } = render(<LiveSection slot={IDLE} turnAvailable onStop={noop} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing even with TURN unavailable — the idle caution moved to Share too', () => {
    const { container } = render(<LiveSection slot={IDLE} turnAvailable={false} onStop={noop} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('LiveSection: no TURN available', () => {
  it('still shows the caution once a share is active', () => {
    const { stream } = cameraStream();
    const slot: Slot = { state: 'sending', kind: 'camera', peer: FAKE_PEER, stream };
    render(<LiveSection slot={slot} turnAvailable={false} onStop={noop} />);

    expect(screen.getByText(/may not/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop sharing/i })).toBeEnabled();
  });
});

describe.each<['offering' | 'sending', string]>([
  ['offering', 'a share not yet accepted by the other device'],
  ['sending', 'a share the other device has accepted'],
])('LiveSection: sharing (%s) — %s', (state) => {
  it('renders the local preview muted, with a comment-worthy invariant: video.muted is true', () => {
    const { stream } = cameraStream();
    const slot: Slot = { state, kind: 'camera', peer: FAKE_PEER, stream };
    const { container } = render(<LiveSection slot={slot} turnAvailable onStop={noop} />);

    const video = container.querySelector('video')!;
    expect(video).not.toBeNull();
    expect(video.muted).toBe(true);
    expect(video.srcObject).toBe(stream);
  });

  it('shows Mute mic and Stop sharing for a camera share (which carries an audio track)', () => {
    const { stream } = cameraStream();
    const slot: Slot = { state, kind: 'camera', peer: FAKE_PEER, stream };
    render(<LiveSection slot={slot} turnAvailable onStop={noop} />);

    expect(screen.getByRole('button', { name: /mute mic/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop sharing/i })).toBeInTheDocument();
  });

  it('has no Mute control at all for a screen share — absent, not disabled', () => {
    const slot: Slot = { state, kind: 'screen', peer: FAKE_PEER, stream: screenStream() };
    render(<LiveSection slot={slot} turnAvailable onStop={noop} />);

    expect(screen.queryByRole('button', { name: /mute/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop sharing/i })).toBeInTheDocument();
  });

  it('clicking Stop sharing calls onStop', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const { stream } = cameraStream();
    const slot: Slot = { state, kind: 'camera', peer: FAKE_PEER, stream };
    render(<LiveSection slot={slot} turnAvailable onStop={onStop} />);

    await user.click(screen.getByRole('button', { name: /stop sharing/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('LiveSection: mute is bound to the real audio track, not a UI flag', () => {
  it('toggling Mute mic flips MediaStreamTrack.enabled directly, and the label follows the track', async () => {
    const user = userEvent.setup();
    const { stream, audio } = cameraStream();
    const slot: Slot = { state: 'sending', kind: 'camera', peer: FAKE_PEER, stream };
    render(<LiveSection slot={slot} turnAvailable onStop={noop} />);

    expect(audio.enabled).toBe(true);
    const button = screen.getByRole('button', { name: /mute mic/i });

    await user.click(button);
    expect(audio.enabled).toBe(false);
    expect(screen.getByRole('button', { name: /unmute mic/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /unmute mic/i }));
    expect(audio.enabled).toBe(true);
    expect(screen.getByRole('button', { name: /mute mic/i })).toBeInTheDocument();
  });
});

describe('LiveSection: connecting (receiving, no stream yet)', () => {
  it('renders a placeholder and a Cancel button — never an error', () => {
    const slot: Slot = { state: 'receiving', kind: 'camera', peer: FAKE_PEER, stream: undefined };
    render(<LiveSection slot={slot} turnAvailable onStop={noop} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('renders no video element until the stream actually arrives', () => {
    const slot: Slot = { state: 'receiving', kind: 'camera', peer: FAKE_PEER, stream: undefined };
    const { container } = render(<LiveSection slot={slot} turnAvailable onStop={noop} />);
    expect(container.querySelector('video')).toBeNull();
  });

  it('Cancel genuinely calls onStop, the same teardown a real Cancel needs to reach LiveSession.stop()', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const slot: Slot = { state: 'receiving', kind: 'screen', peer: FAKE_PEER, stream: undefined };
    render(<LiveSection slot={slot} turnAvailable onStop={onStop} />);

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('LiveSection: watching (receiving, stream arrived)', () => {
  it('renders the remote video unmuted, with a note that starting your own replaces it', () => {
    const { stream } = cameraStream();
    const slot: Slot = { state: 'receiving', kind: 'camera', peer: FAKE_PEER, stream };
    const { container } = render(<LiveSection slot={slot} turnAvailable onStop={noop} />);

    const video = container.querySelector('video')!;
    expect(video).not.toBeNull();
    expect(video.muted).toBe(false);
    expect(video.srcObject).toBe(stream);
    expect(screen.getByText(/replace/i)).toBeInTheDocument();
  });

  it('gives volume and fullscreen through the native player rather than bespoke controls', () => {
    const { stream } = cameraStream();
    const slot: Slot = { state: 'receiving', kind: 'screen', peer: FAKE_PEER, stream };
    const { container } = render(<LiveSection slot={slot} turnAvailable onStop={noop} />);

    expect(container.querySelector('video')).toHaveAttribute('controls');
  });

  // AGENTS.md forbids a dead end, and watching a stream with no way to end
  // it (short of leaving the whole session) is one — LiveSession already
  // supports it via the same stop() every other Stop/Cancel button calls
  // (client/media/live-session.ts's #release()), this just wires a button
  // to it.
  it('offers a control to stop watching, which calls onStop', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const { stream } = cameraStream();
    const slot: Slot = { state: 'receiving', kind: 'camera', peer: FAKE_PEER, stream };
    render(<LiveSection slot={slot} turnAvailable onStop={onStop} />);

    await user.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

/**
 * Not part of LiveSection's own props, but proven here rather than nowhere:
 * `key={slot.stream.id}` on the Sharing branch (LiveSection.tsx) forces a
 * remount whenever the underlying MediaStream changes, so a locally-mutated
 * `muted` state can never disagree with a brand new track's own `enabled`.
 * A small harness stands in for TransferPanel switching `slot` under
 * LiveSection, since that switch is what triggers the remount in practice.
 */
describe('LiveSection: switching streams while already sharing', () => {
  it('remounts Sharing so a stale local mute state cannot outlive the stream it described', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [slot, setSlot] = useState<Slot>(() => {
        const { stream } = cameraStream();
        return { state: 'sending', kind: 'camera', peer: FAKE_PEER, stream };
      });
      const nextStream = useRef(screenStream());
      return (
        <>
          <LiveSection slot={slot} turnAvailable onStop={noop} />
          <button onClick={() => setSlot({ state: 'sending', kind: 'screen', peer: FAKE_PEER, stream: nextStream.current })}>
            switch to screen
          </button>
        </>
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /mute mic/i }));
    expect(screen.getByRole('button', { name: /unmute mic/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /switch to screen/i }));
    // The new slot is a screen share, which carries no audio track at all —
    // if the old 'Sharing' instance had survived instead of remounting, its
    // stale muted-audio-track UI would still be showing something here.
    expect(screen.queryByRole('button', { name: /mute mic|unmute mic/i })).not.toBeInTheDocument();
  });
});

describe('LiveSection: camera controls', () => {
  const CAMERA: CameraState = { facing: 'user', canFlip: true, canTorch: true, torchOn: false, busy: false };

  function sharing(camera: Partial<CameraState> | undefined, props: Record<string, unknown> = {}) {
    const { stream } = cameraStream();
    const slot: Slot = {
      state: 'sending',
      kind: 'camera',
      peer: FAKE_PEER,
      stream,
      camera: camera && { ...CAMERA, ...camera },
    };
    return render(<LiveSection slot={slot} turnAvailable onStop={noop} {...props} />);
  }

  it('names the camera it will switch to, not the one already in hand', async () => {
    const onFlipCamera = vi.fn();
    sharing({ facing: 'user' }, { onFlipCamera });
    // A button labelled with the current state reads as a status line, and
    // the preview above it already says which way the camera points.
    await userEvent.click(screen.getByRole('button', { name: /rear camera/i }));
    expect(onFlipCamera).toHaveBeenCalledTimes(1);

    sharing({ facing: 'environment' }, { onFlipCamera });
    expect(screen.getByRole('button', { name: /front camera/i })).toBeInTheDocument();
  });

  it('keeps the flip control out of the way while one is already in flight', () => {
    sharing({ busy: true }, { onFlipCamera: vi.fn() });
    expect(screen.getByRole('button', { name: /rear camera/i })).toBeDisabled();
  });

  it('toggles the lamp, and asks for the state the button offers', async () => {
    const onTorch = vi.fn();
    sharing({ torchOn: false }, { onTorch });
    await userEvent.click(screen.getByRole('button', { name: /flash on/i }));
    expect(onTorch).toHaveBeenCalledWith(true);

    sharing({ torchOn: true }, { onTorch });
    await userEvent.click(screen.getByRole('button', { name: /flash off/i }));
    expect(onTorch).toHaveBeenCalledWith(false);
  });

  it('leaves out a control the hardware cannot do, rather than greying it out', () => {
    // A greyed-out Flash on a laptop is a question the user has to answer
    // for themselves, and the answer is always no — the same rule the mute
    // button already follows for a screen share with no audio track.
    sharing({ canFlip: false, canTorch: false }, { onFlipCamera: vi.fn(), onTorch: vi.fn() });
    expect(screen.queryByRole('button', { name: /camera$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /flash/i })).not.toBeInTheDocument();
    // The controls that do not depend on the camera are untouched.
    expect(screen.getByRole('button', { name: /mute mic/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop sharing/i })).toBeInTheDocument();
  });

  it('shows no camera controls for a screen share', () => {
    const slot: Slot = { state: 'sending', kind: 'screen', peer: FAKE_PEER, stream: screenStream() };
    render(<LiveSection slot={slot} turnAvailable onStop={noop} onFlipCamera={vi.fn()} onTorch={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /camera$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /flash/i })).not.toBeInTheDocument();
  });

  it('shows nothing before the camera state has been worked out', () => {
    sharing(undefined, { onFlipCamera: vi.fn(), onTorch: vi.fn() });
    expect(screen.queryByRole('button', { name: /camera$/i })).not.toBeInTheDocument();
  });
});

describe('LiveSection: screen share quality', () => {
  function screenSharing(props: Record<string, unknown> = {}) {
    const slot: Slot = {
      state: 'sending', kind: 'screen', peer: FAKE_PEER, stream: screenStream(), preset: 'text',
    };
    return render(<LiveSection slot={slot} turnAvailable onStop={noop} onPreset={vi.fn()} {...props} />);
  }

  it('offers the three trades as one exclusive choice, not three toggles', () => {
    screenSharing();
    const group = screen.getByRole('radiogroup', { name: /screen share quality/i });
    expect(group).toBeInTheDocument();
    // aria-pressed toggles would tell a screen reader three separate on/off
    // facts and leave the exclusivity to be inferred.
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /sharp text/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /smooth motion/i })).not.toBeChecked();
  });

  it('says what each trade costs, not only what it protects', () => {
    screenSharing();
    // "Sharp text" alone does not tell anyone what it gives up, and that is
    // the whole decision.
    expect(screen.getByRole('radio', { name: /gives up frames first/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /gets softer first/i })).toBeInTheDocument();
  });

  it('reports a chosen preset up rather than acting on it locally', async () => {
    const onPreset = vi.fn();
    screenSharing({ onPreset });
    await userEvent.click(screen.getByRole('radio', { name: /save data/i }));
    expect(onPreset).toHaveBeenCalledWith('data');
  });

  it('shows no quality presets on a camera share', () => {
    const { stream } = cameraStream();
    const slot: Slot = { state: 'sending', kind: 'camera', peer: FAKE_PEER, stream, preset: 'text' };
    render(<LiveSection slot={slot} turnAvailable onStop={noop} onPreset={vi.fn()} />);
    expect(screen.queryByRole('radiogroup', { name: /screen share quality/i })).not.toBeInTheDocument();
  });

  it('shows what the stream is doing, in a politely announced region', () => {
    screenSharing({ stats: { kbps: 1400, width: 1920, height: 1080, fps: 28, rttMs: 41 } });
    const line = screen.getByText(/1\.4 Mbps/);
    expect(line).toHaveTextContent('1.4 Mbps · 1920×1080 · 28 fps · 41 ms');
    // Every couple of seconds, so assertive would interrupt continuously.
    expect(line).toHaveAttribute('aria-live', 'polite');
  });

  it('leaves out a number the browser has not reported, rather than showing a zero', () => {
    // A report taken moments after connecting has no frame rate yet, and
    // "0 fps" beside a moving picture is worse than saying nothing.
    screenSharing({ stats: { kbps: 800, width: 1280, height: 720 } });
    const line = screen.getByText(/800 kbps/);
    expect(line).toHaveTextContent('800 kbps · 1280×720');
    expect(line.textContent).not.toMatch(/fps|ms/);
  });

  it('shows no readout at all before the first reading', () => {
    screenSharing({ stats: undefined });
    expect(screen.queryByText(/kbps|Mbps/)).not.toBeInTheDocument();
    screenSharing({ stats: {} });
    expect(screen.queryByText(/kbps|Mbps/)).not.toBeInTheDocument();
  });
});
