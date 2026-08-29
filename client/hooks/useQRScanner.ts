import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { BrowserQRCodeReader } from '@zxing/browser';

/**
 * 'unsupported' is the browser/origin saying no (no `getUserMedia`, i.e. an
 * insecure origin); 'unavailable' is this app's own fault (no video element
 * to decode into). They are deliberately distinct: reporting a missing
 * element as an https problem tells the user a falsehood about their own
 * page, and hides a bug behind advice that cannot help.
 */
export type ScannerStatus = 'idle' | 'scanning' | 'denied' | 'unsupported' | 'unavailable';

export interface QRScannerHandle {
  videoRef: RefObject<HTMLVideoElement | null>;
  status: ScannerStatus;
  start(): void;
}

/**
 * The camera is an enhancement over typing the code, never a requirement —
 * see JoinScreen, which renders the manual `CodeInput` regardless of
 * `status`. This hook only owns the camera's own state machine: whether the
 * API exists at all, whether the user allowed it, and making sure the
 * stream is torn down the moment it is no longer wanted.
 */
export function useQRScanner({ onResult }: { onResult: (text: string) => void }): QRScannerHandle {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<ScannerStatus>('idle');
  const controlsRef = useRef<{ stop: () => void } | undefined>(undefined);
  // Guards the race between `decodeFromVideoDevice`'s promise resolving with
  // the controls that stop it, and something else already having decided the
  // camera should stop — either a result arriving first, or the component
  // unmounting first (e.g. the user taps "Use the camera" and navigates away
  // before the browser's permission prompt has even resolved). Either way,
  // controls that arrive after the request must be stopped the instant they
  // exist, rather than left running because nothing was there yet to stop.
  const stopRequestedRef = useRef(false);

  const start = useCallback(() => {
    // `getUserMedia` requires a secure context; on plain http it is simply
    // absent rather than present-and-rejecting. That distinction is exactly
    // what separates 'unsupported' (this page needs https — not the user's
    // problem to fix) from 'denied' (the user said no).
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported');
      return;
    }
    // Separate from the capability check above, and separate from 'scanning':
    // the element must already be in the DOM when this runs, because only
    // `start()` can move the status — a screen that mounts its <video> when
    // the status becomes 'scanning' can never get here at all. JoinScreen
    // keeps it mounted at every status for exactly this reason.
    const video = videoRef.current;
    if (!video) {
      setStatus('unavailable');
      return;
    }
    stopRequestedRef.current = false;
    setStatus('scanning');
    const reader = new BrowserQRCodeReader();
    void reader
      .decodeFromVideoDevice(undefined, video, (result) => {
        if (!result) return;
        stopRequestedRef.current = true;
        controlsRef.current?.stop();
        // A user who has paired should not still be filming.
        setStatus('idle');
        onResult(result.getText());
      })
      .then((controls) => {
        controlsRef.current = controls;
        // The result callback above may already have fired and asked for a
        // stop before this promise settled with something to stop.
        if (stopRequestedRef.current) controls.stop();
      })
      .catch(() => setStatus('denied'));
  }, [onResult]);

  // Runs on unmount only (empty deps): leaving a MediaStream running holds
  // the camera and keeps its hardware indicator light on after the user has
  // navigated away, which is its own small privacy failure. Also arms
  // `stopRequestedRef` — not just the direct `.stop()` below — so controls
  // that resolve *after* this cleanup runs (start() was called, but the
  // permission prompt hadn't settled yet) are still stopped the moment
  // `start`'s `.then` sees them, instead of running forever unowned.
  useEffect(() => () => {
    stopRequestedRef.current = true;
    controlsRef.current?.stop();
  }, []);

  return { videoRef, status, start };
}
