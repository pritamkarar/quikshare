import { useEffect, useRef, useState } from 'react';
import { toCanvas } from 'qrcode';

/** The drawn size, in CSS pixels. Fixed so the canvas reserves its own space. */
const QR_SIZE = 288;

/** Groups the code as XXX-XXX so it can be read aloud without mistakes. */
function groupCode(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

export interface QRPanelProps {
  shareUrl: string;
  code: string;
}

export function QRPanel({ shareUrl, code }: QRPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setFailed(false);
    // Rendered locally, always. Nothing secret is in this URL any more (the
    // key is agreed between the devices), but a QR of the room you are in is
    // still yours, and a remote generator would be a request per session
    // announcing it.
    void toCanvas(canvas, shareUrl, {
      width: QR_SIZE,
      margin: 2,
      errorCorrectionLevel: 'M',
      // Fixed black on white rather than themed: a camera needs the contrast,
      // and a dark-theme QR on a dark card is measurably harder to scan.
      color: { dark: '#000000', light: '#ffffff' },
    }).catch(() => setFailed(true));
  }, [shareUrl]);

  return (
    <div className="flex flex-col items-center gap-4">
      {/* A bright card on a dark canvas: cameras lock on faster. */}
      <div className="neo rounded-[var(--radius-xl)] bg-white p-5">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Scan this QR code with the other device"
          // Set up front, not left to the drawing: a canvas defaults to
          // 300×150, so without these the layout jumps when the QR appears.
          width={QR_SIZE}
          height={QR_SIZE}
          className="block h-auto w-full max-w-[288px]"
        />
      </div>
      {failed && (
        // Never a dead end: the code below is a complete alternative to the
        // QR, so a failed drawing costs the reader a scan, not the session.
        <p role="alert" className="max-w-xs text-center text-sm text-[var(--color-danger)]">
          The QR code could not be drawn. Type the code below on the other device instead.
        </p>
      )}
      <p
        // A code is an identifier, not prose: auto-translation garbles it.
        translate="no"
        className="mono numeric text-3xl tracking-[0.35em] text-[var(--color-text)]"
      >
        {groupCode(code)}
      </p>
    </div>
  );
}
