import { QRPanel } from '../ui/QRPanel.js';
import { Button } from '../ui/Button.js';
import { IconExit } from '../ui/icons.js';

export interface PeerLeftPanelProps {
  code: string;
  shareUrl: string;
  onEnd: () => void;
}

/**
 * Shown when the other device disconnects. The room outlives it —
 * server/rooms.ts only deletes a room once every peer has left, not when
 * one does — so this is not the same failure as InvalidScreen's 'expired'
 * (a room that genuinely no longer exists). The code and QR are re-shown so
 * the same device, or a different one, can scan straight back in; ending
 * the session is still offered as a deliberate choice, not forced.
 */
export function PeerLeftPanel({ code, shareUrl, onEnd }: PeerLeftPanelProps) {
  return (
    <section aria-labelledby="peer-left-heading" className="mx-auto w-full max-w-3xl flex flex-1 flex-col justify-center items-center gap-6 py-8 text-center">
      <h1 id="peer-left-heading" className="text-2xl font-semibold">The other device disconnected</h1>
      <p className="max-w-sm text-pretty text-[var(--color-text-muted)]">
        This session is still open. Scan the code again from the same device, or from a different one.
      </p>
      <QRPanel shareUrl={shareUrl} code={code} />
      <Button variant="ghost" icon={<IconExit />} onClick={onEnd}>End session</Button>
    </section>
  );
}
