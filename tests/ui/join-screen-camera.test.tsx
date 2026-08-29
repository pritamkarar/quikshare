// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JoinScreen } from '../../client/screens/JoinScreen.js';

/**
 * The seam every other JoinScreen test mocks away. `join-screen.test.tsx` and
 * `a11y.test.tsx` both replace `useQRScanner` wholesale, and
 * `use-qr-scanner.test.tsx` hands the hook a video element it built by hand —
 * so nothing anywhere rendered this screen against the real hook, and a
 * primary path that could never start survived twelve task reviews.
 *
 * Only `@zxing/browser` is stubbed here (jsdom has no camera and no decoding
 * loop); the hook, the screen, and the wiring between them are real.
 */

const decodeFromVideoDevice = vi.fn();

vi.mock('@zxing/browser', () => ({
  BrowserQRCodeReader: vi.fn().mockImplementation(() => ({ decodeFromVideoDevice })),
}));

/** A browser that fully supports the camera: secure context, API present. */
function supportCamera(): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn() },
    configurable: true,
  });
}

afterEach(() => {
  decodeFromVideoDevice.mockReset();
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

describe('JoinScreen with the real QR scanner', () => {
  it('actually starts the decoder when "Use the camera" is clicked', async () => {
    supportCamera();
    decodeFromVideoDevice.mockResolvedValue({ stop: vi.fn() });
    render(<JoinScreen onJoin={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /use the camera/i }));

    expect(decodeFromVideoDevice).toHaveBeenCalledTimes(1);
    // The second argument is the element zxing renders the stream into: it has
    // to be a real, mounted <video>, not null.
    const target = decodeFromVideoDevice.mock.calls[0]![1] as unknown;
    expect(target).toBeInstanceOf(HTMLVideoElement);
    expect((target as HTMLVideoElement).isConnected).toBe(true);
  });

  it('keeps the idle preview renderable rather than display:none', () => {
    // `hidden` (and any display:none equivalent) can suspend or refuse media
    // playback outright in some engines, so the always-mounted element is
    // clipped out of view instead — it has to remain a valid getUserMedia
    // target while idle, which is the whole reason it is mounted early.
    const { container } = render(<JoinScreen onJoin={vi.fn()} />);
    const video = container.querySelector('video');

    expect(video).not.toBeNull();
    expect(video!.hidden).toBe(false);
    expect(video!.className).not.toMatch(/(?:^|\s)hidden(?:\s|$)/);
  });

  it('never blames https when the camera is available', async () => {
    supportCamera();
    decodeFromVideoDevice.mockResolvedValue({ stop: vi.fn() });
    render(<JoinScreen onJoin={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /use the camera/i }));

    expect(screen.queryByText(/secure \(https\)/i)).not.toBeInTheDocument();
  });

  it('keeps a way back to the camera after the user declines it', async () => {
    supportCamera();
    decodeFromVideoDevice.mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    render(<JoinScreen onJoin={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /use the camera/i }));

    // A denial is recoverable — the user can grant permission and retry — so
    // the screen must not remove its only camera affordance and leave a
    // reload as the only way back.
    expect(await screen.findByRole('button', { name: /camera/i })).toBeInTheDocument();
  });

  it('still explains an insecure origin, where the camera API is simply absent', async () => {
    // jsdom has no mediaDevices at all by default — the same shape as a plain
    // http origin.
    render(<JoinScreen onJoin={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /use the camera/i }));

    expect(screen.getByText(/secure \(https\)/i)).toBeInTheDocument();
    expect(decodeFromVideoDevice).not.toHaveBeenCalled();
  });
});
