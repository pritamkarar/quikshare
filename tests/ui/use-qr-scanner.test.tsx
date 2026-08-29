// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useQRScanner } from '../../client/hooks/useQRScanner.js';

/**
 * What's testable here: the state machine around `decodeFromVideoDevice` —
 * unsupported vs. denied, and that the camera's controls are stopped both on
 * a successful scan and on unmount. What's NOT testable in jsdom: whether a
 * real camera stream actually starts, whether zxing's frame-decoding loop
 * finds a real QR code, or the browser's own permission prompt — those need
 * a real browser and a real (or virtual) camera device, so `@zxing/browser`
 * is mocked out entirely below rather than exercised for real.
 */

const decodeFromVideoDevice = vi.fn();

vi.mock('@zxing/browser', () => ({
  BrowserQRCodeReader: vi.fn().mockImplementation(() => ({
    decodeFromVideoDevice,
  })),
}));

afterEach(() => {
  decodeFromVideoDevice.mockReset();
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

/**
 * Stands in for the always-mounted <video> JoinScreen renders. This file
 * tests the hook's state machine in isolation, so it supplies the element by
 * hand — but that is not proof the screen supplies one, and for twelve tasks
 * nothing checked that it did (it did not). `join-screen-camera.test.tsx`
 * covers that seam against the real hook; keep it that way.
 */
function attachVideo(result: { current: { videoRef: { current: HTMLVideoElement | null } } }): void {
  result.current.videoRef.current = document.createElement('video');
}

describe('useQRScanner', () => {
  it('reports unsupported rather than attempting the camera when getUserMedia is absent', () => {
    // jsdom implements no mediaDevices at all by default — the same as a
    // plain http origin, where the API is simply missing rather than
    // present-and-rejecting.
    const { result } = renderHook(() => useQRScanner({ onResult: vi.fn() }));
    attachVideo(result);

    act(() => result.current.start());

    expect(result.current.status).toBe('unsupported');
    expect(decodeFromVideoDevice).not.toHaveBeenCalled();
  });

  // This case used to assert 'unsupported' — i.e. it pinned the defect as
  // correct behaviour, and told the user their page was not on https when the
  // truth was that this app had rendered no <video> to decode into. A missing
  // element is our bug, not the origin's, and the two must never be reported
  // as the same thing.
  it('reports a missing video element as unavailable, never as an https problem', () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn() },
      configurable: true,
    });
    const { result } = renderHook(() => useQRScanner({ onResult: vi.fn() }));
    // videoRef.current is left null.

    act(() => result.current.start());

    expect(result.current.status).toBe('unavailable');
    expect(decodeFromVideoDevice).not.toHaveBeenCalled();
  });

  it('reports denied when starting the camera fails', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn() },
      configurable: true,
    });
    decodeFromVideoDevice.mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    const { result } = renderHook(() => useQRScanner({ onResult: vi.fn() }));
    attachVideo(result);

    act(() => result.current.start());
    expect(result.current.status).toBe('scanning');

    await waitFor(() => expect(result.current.status).toBe('denied'));
  });

  it('stops the camera and reports the result once a code is decoded', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn() },
      configurable: true,
    });
    const stop = vi.fn();
    let deliver: ((result: { getText: () => string }) => void) | undefined;
    decodeFromVideoDevice.mockImplementation((_device, _video, callback) => {
      deliver = callback;
      return Promise.resolve({ stop });
    });
    const onResult = vi.fn();
    const { result } = renderHook(() => useQRScanner({ onResult }));
    attachVideo(result);

    act(() => result.current.start());
    await waitFor(() => expect(deliver).toBeDefined());

    act(() => deliver!({ getText: () => 'https://host.example/s/K7M3QP#key' }));

    expect(onResult).toHaveBeenCalledWith('https://host.example/s/K7M3QP#key');
    expect(stop).toHaveBeenCalled();
  });

  it('stops the camera even if the result arrives before decodeFromVideoDevice resolves with controls', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn() },
      configurable: true,
    });
    const stop = vi.fn();
    let resolveControls: ((controls: { stop: () => void }) => void) | undefined;
    let deliver: ((result: { getText: () => string }) => void) | undefined;
    decodeFromVideoDevice.mockImplementation((_device, _video, callback) => {
      deliver = callback;
      return new Promise((resolve) => { resolveControls = resolve; });
    });
    const onResult = vi.fn();
    const { result } = renderHook(() => useQRScanner({ onResult }));
    attachVideo(result);

    act(() => result.current.start());
    // The result wins the race — arrives before the controls promise settles.
    act(() => deliver!({ getText: () => 'text' }));
    await act(async () => resolveControls!({ stop }));

    expect(stop).toHaveBeenCalled();
  });

  it('stops the camera if it unmounts before decodeFromVideoDevice resolves with controls', async () => {
    // The exact failure the task warned about: tap the camera button, then
    // navigate away before the browser's permission prompt (and therefore
    // `decodeFromVideoDevice`'s promise) has settled. The controls that
    // would stop the stream do not exist yet at unmount time, so they must
    // be stopped the instant they *do* arrive, even though the screen that
    // asked for them is already gone.
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn() },
      configurable: true,
    });
    const stop = vi.fn();
    let resolveControls: ((controls: { stop: () => void }) => void) | undefined;
    decodeFromVideoDevice.mockImplementation(() => new Promise((resolve) => { resolveControls = resolve; }));
    const { result, unmount } = renderHook(() => useQRScanner({ onResult: vi.fn() }));
    attachVideo(result);

    act(() => result.current.start());
    unmount(); // torn down while the controls promise is still pending

    await act(async () => resolveControls!({ stop }));

    expect(stop).toHaveBeenCalled();
  });

  it('stops the camera on unmount', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn() },
      configurable: true,
    });
    const stop = vi.fn();
    decodeFromVideoDevice.mockResolvedValue({ stop });
    const { result, unmount } = renderHook(() => useQRScanner({ onResult: vi.fn() }));
    attachVideo(result);

    act(() => result.current.start());
    expect(stop).not.toHaveBeenCalled(); // sanity: not yet — camera is still "running"
    // Let the controls promise settle before unmounting.
    await act(async () => { await Promise.resolve(); });

    unmount();

    expect(stop).toHaveBeenCalled();
  });
});
