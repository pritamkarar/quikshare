// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PeerLeftPanel } from '../../client/screens/PeerLeftPanel.js';

// PeerLeftPanel renders QRPanel, which draws through the real `qrcode`
// package's canvas API — jsdom's <canvas> does not implement it (see
// create-screen.test.tsx for the same stub).
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(async () => undefined) },
  toCanvas: vi.fn(async () => undefined),
}));

describe('PeerLeftPanel', () => {
  it('explains what happened without claiming the session is over', () => {
    render(<PeerLeftPanel code="K7M3QP" shareUrl="https://x.dev/s/K7M3QP#k" onEnd={vi.fn()} />);
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
    // The room really does survive one peer leaving (server/rooms.ts only
    // deletes it once every peer is gone) — so "the session is still open"
    // must be said, not just implied.
    expect(screen.getByText(/still open/i)).toBeInTheDocument();
  });

  it('re-displays the code so the peer can rejoin', () => {
    render(<PeerLeftPanel code="K7M3QP" shareUrl="https://x.dev/s/K7M3QP#k" onEnd={vi.fn()} />);
    expect(screen.getByText(/K7M-3QP/)).toBeInTheDocument();
  });

  it('re-displays the QR code too, not just the text code', () => {
    render(<PeerLeftPanel code="K7M3QP" shareUrl="https://x.dev/s/K7M3QP#k" onEnd={vi.fn()} />);
    expect(screen.getByRole('img', { name: /scan/i })).toBeInTheDocument();
  });

  it('still offers a way to end the session deliberately', () => {
    const onEnd = vi.fn();
    render(<PeerLeftPanel code="K7M3QP" shareUrl="https://x.dev/s/K7M3QP#k" onEnd={onEnd} />);
    expect(screen.getByRole('button', { name: /end session/i })).toBeInTheDocument();
  });
});
