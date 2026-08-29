// tests/unit/capture.test.ts
/*
 * capture.ts's whole job is translating navigator.mediaDevices into typed
 * values, so these tests stub `navigator` itself (the house pattern for a
 * browser global — see tests/unit/media-ice.test.ts's stubFetch) rather than
 * touching a real camera or screen. They prove four things: camera asks for
 * video+audio while screen asks for video only (spec §3 — screen audio is
 * Chromium-only and tab-scoped, so requesting it everywhere would make the
 * feature silently do nothing on Firefox/Safari); a refusal and a
 * picker-dismissal both become the same typed 'denied' failure rather than a
 * raw DOMException; 'no camera at all' is a distinct 'no-device' failure
 * because the recovery differs; and the browser's own "Stop sharing" chrome
 * — which ends a track without this module ever calling stop() itself — is
 * observable through onStreamEnded, with a working unsubscribe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CaptureError, captureCamera, captureCameraVideo, captureScreen, countCameras, facingOf,
  hasTorch, onStreamEnded, setTorch,
} from '../../client/media/capture.js';

/** A minimal MediaStream stand-in: only what capture.ts's callers touch. */
function fakeStream(videoTracks: FakeTrack[]): MediaStream {
  return { getVideoTracks: () => videoTracks } as unknown as MediaStream;
}

/**
 * Stands in for a local MediaStreamTrack, real enough to fire and remove an
 * 'ended' listener — the one thing onStreamEnded needs from it. A plain
 * EventTarget would do the same job, but this keeps the fake's surface
 * exactly as small as the contract being tested.
 */
class FakeTrack {
  #listeners = new Set<() => void>();
  addEventListener(type: string, cb: () => void): void {
    if (type === 'ended') this.#listeners.add(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    if (type === 'ended') this.#listeners.delete(cb);
  }
  /** Simulates the browser's own "Stop sharing" chrome ending the track. */
  fireEnded(): void {
    for (const cb of [...this.#listeners]) cb();
  }
}

function stubMediaDevices(overrides: Partial<MediaDevices>): void {
  vi.stubGlobal('navigator', { mediaDevices: overrides });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('captureCamera', () => {
  it('requests video and audio in one prompt', async () => {
    const stream = fakeStream([]);
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    stubMediaDevices({ getUserMedia });

    const result = await captureCamera();

    expect(result).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: true });
  });
});

describe('captureScreen', () => {
  it('requests video only, never audio', async () => {
    const stream = fakeStream([]);
    const getDisplayMedia = vi.fn().mockResolvedValue(stream);
    // Included for realism (a real secure-context browser has both), not
    // because capture.ts needs it here: its per-capability guard
    // (client/media/capture.ts's request()) checks exactly the capability
    // being called — `getDisplayMedia` for captureScreen — not
    // getUserMedia, so this stub would behave identically without it.
    stubMediaDevices({ getUserMedia: vi.fn(), getDisplayMedia });

    const result = await captureScreen();

    expect(result).toBe(stream);
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
  });
});

describe('permission failures', () => {
  it('turns a refused camera permission into a typed "denied" failure, not a raw DOMException', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    stubMediaDevices({ getUserMedia });

    const err = await captureCamera().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).failure).toEqual({ reason: 'denied' });
  });

  it('turns dismissing the screen-picker into the same "denied" failure as an explicit refusal', async () => {
    // The browser reports a dismissed picker with the identical
    // NotAllowedError a real "no" does — there is no separate DOMException
    // for "the user just closed the dialog". Same code path, same failure.
    const getDisplayMedia = vi.fn().mockRejectedValue(new DOMException('dismissed', 'NotAllowedError'));
    stubMediaDevices({ getUserMedia: vi.fn(), getDisplayMedia });

    const err = await captureScreen().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).failure).toEqual({ reason: 'denied' });
  });

  it('distinguishes "no camera at all" from a refusal, because the recovery differs', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('no device', 'NotFoundError'));
    stubMediaDevices({ getUserMedia });

    const err = await captureCamera().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).failure).toEqual({ reason: 'no-device' });
  });

  it('surfaces an unrecognized DOMException as a typed "failed" failure carrying the browser detail', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('camera in use', 'NotReadableError'));
    stubMediaDevices({ getUserMedia });

    const err = await captureCamera().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).failure).toEqual({ reason: 'failed', detail: 'camera in use' });
  });

  it('reports "unsupported" rather than throwing a raw TypeError when mediaDevices is unavailable (insecure context)', async () => {
    vi.stubGlobal('navigator', {});

    const err = await captureCamera().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).failure).toEqual({ reason: 'unsupported' });
  });

  it('reports "unsupported" for screen capture on a browser with getUserMedia but no getDisplayMedia', async () => {
    // A camera-capable browser that doesn't do screen capture at all (many
    // mobile browsers) must not read as a generic "failed" — the guard has
    // to check the capability the call actually needs, not just that
    // mediaDevices exists.
    stubMediaDevices({ getUserMedia: vi.fn() });

    const err = await captureScreen().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).failure).toEqual({ reason: 'unsupported' });
  });
});

describe('onStreamEnded', () => {
  it('fires when the browser\'s own "Stop sharing" chrome ends the video track', () => {
    const track = new FakeTrack();
    const stream = fakeStream([track]);
    const cb = vi.fn();

    onStreamEnded(stream, cb);
    track.fireEnded();

    expect(cb).toHaveBeenCalledOnce();
  });

  it('returns an unsubscribe that stops further calls', () => {
    const track = new FakeTrack();
    const stream = fakeStream([track]);
    const cb = vi.fn();

    const unsubscribe = onStreamEnded(stream, cb);
    unsubscribe();
    track.fireEnded();

    expect(cb).not.toHaveBeenCalled();
  });

  it('is a no-op on a stream with no video track', () => {
    const stream = fakeStream([]);

    expect(() => onStreamEnded(stream, vi.fn())()).not.toThrow();
  });
});

describe('camera controls', () => {
  it('asks for a facing camera as a preference on the first capture', async () => {
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream([]));
    stubMediaDevices({ getUserMedia });

    await captureCamera('environment');

    // `ideal`, not `exact`: the first capture has to succeed on a laptop
    // with one webcam that reports no facingMode at all, where an exact
    // constraint fails outright instead of handing back the only camera.
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: 'environment' } }, audio: true });
  });

  it('asks for a facing camera exactly, and without audio, when flipping', async () => {
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream([]));
    stubMediaDevices({ getUserMedia });

    await captureCameraVideo('user');

    // `exact`, because a flip that silently returns the same camera is a
    // button that does nothing. `audio: false`, because the microphone
    // already in the call keeps running — asking again would hand back a
    // second track and drop whatever mute the user had set.
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { exact: 'user' } }, audio: false });
  });

  it('counts only cameras, and says zero rather than throwing when it cannot ask', async () => {
    stubMediaDevices({
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput' }, { kind: 'videoinput' }, { kind: 'audioinput' }, { kind: 'audiooutput' },
      ]),
    });
    expect(await countCameras()).toBe(2);

    stubMediaDevices({ enumerateDevices: vi.fn().mockRejectedValue(new Error('blocked by policy')) });
    // Not knowing is the same outcome as one camera: no flip control. It is
    // not a failure worth reporting.
    expect(await countCameras()).toBe(0);

    stubMediaDevices({});
    expect(await countCameras()).toBe(0);
  });

  it('reads a facing mode off the track, and only the two real values', () => {
    expect(facingOf({ getSettings: () => ({ facingMode: 'environment' }) } as MediaStreamTrack)).toBe('environment');
    expect(facingOf({ getSettings: () => ({ facingMode: 'user' }) } as MediaStreamTrack)).toBe('user');
    // Hardware that will not say, and the values that are not a direction.
    expect(facingOf({ getSettings: () => ({}) } as MediaStreamTrack)).toBeUndefined();
    expect(facingOf({ getSettings: () => ({ facingMode: 'left' }) } as unknown as MediaStreamTrack)).toBeUndefined();
    expect(facingOf(undefined)).toBeUndefined();
  });

  it('reports a torch only where the live track actually claims one', () => {
    expect(hasTorch({ getCapabilities: () => ({ torch: true }) } as unknown as MediaStreamTrack)).toBe(true);
    expect(hasTorch({ getCapabilities: () => ({ torch: false }) } as unknown as MediaStreamTrack)).toBe(false);
    // A front camera on the same phone: the capability is simply absent.
    expect(hasTorch({ getCapabilities: () => ({}) } as unknown as MediaStreamTrack)).toBe(false);
    // Browsers with no getCapabilities at all, and a track that throws.
    expect(hasTorch({} as MediaStreamTrack)).toBe(false);
    expect(hasTorch({ getCapabilities: () => { throw new Error('no'); } } as unknown as MediaStreamTrack)).toBe(false);
    expect(hasTorch(undefined)).toBe(false);
  });

  it('sets the torch as an advanced constraint, so an unsupported one cannot fail the rest', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    await setTorch({ applyConstraints } as unknown as MediaStreamTrack, true);
    // A basic constraint naming an optional capability makes the whole call
    // reject, taking the track's other settings down with it.
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
  });
});
