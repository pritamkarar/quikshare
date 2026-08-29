import { useState } from 'react';
import { CodeInput } from '../ui/CodeInput.js';
import { Button } from '../ui/Button.js';
import { IconQr } from '../ui/icons.js';
import { useQRScanner, type ScannerStatus } from '../hooks/useQRScanner.js';
import { parseRoute } from '../routing.js';

export interface JoinScreenProps {
  /**
   * Called with the session code, however the screen came by it — typed,
   * pasted bare, pasted as a full link, or scanned. The caller (App) turns
   * it into a route via `navigateTo`.
   */
  onJoin: (code: string) => void;
}

/**
 * Every status that cannot scan says something different, because they are
 * different situations and only one of them is the user's to fix — but they
 * end with the same instruction, because the fallback is the same either
 * way: the six-character code, typed into the field right below. That used
 * to be "paste the link", back when the key rode in the fragment and a code
 * alone could not open anything.
 */
function cameraMessage(status: ScannerStatus): string {
  switch (status) {
    case 'denied':
      return 'Camera access was declined. Type the code from the other device below instead.';
    case 'unsupported':
      return 'The camera needs a secure (https) connection, and this page is not on one. Type the code from the other device below instead.';
    case 'unavailable':
      // Never phrased as an https problem: the origin was fine and the API was
      // there, so telling the user to find a secure connection would send them
      // after something that is not wrong.
      return 'The camera could not be started on this page. Type the code from the other device below instead.';
    case 'scanning':
      // The preview itself is hidden from assistive tech (see the <video>
      // below), so this is the only thing that tells a screen-reader user the
      // camera actually came on.
      return 'The camera is on. Point it at the QR code on the other device.';
    case 'idle':
      return 'Scan the QR code on the other device, or type its code below.';
  }
}

/**
 * A coarse (touch) pointer is this screen's signal that the primary way in
 * is a phone, where autofocusing `CodeInput` would summon the on-screen
 * keyboard on load — right over the "Use the camera" decision the screen is
 * trying to offer. Absent `matchMedia` entirely (jsdom in tests, and any
 * non-browser environment), this degrades to `false` — i.e. autofocus —
 * which is already today's behavior on desktop, so no test stub is needed.
 */
function hasCoarsePointer(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

export function JoinScreen({ onJoin }: JoinScreenProps) {
  const [code, setCode] = useState('');

  const scanner = useQRScanner({
    onResult: (text) => {
      try {
        const route = parseRoute(new URL(text));
        if (route.t === 'session') onJoin(route.code);
        // Anything else scanned — not one of our links — is not this
        // screen's error to report; scanning simply continues.
      } catch {
        // Not a URL at all.
      }
    },
  });

  // No document.title effect here: unlike CreateScreen's (which depends on
  // the live session code), this screen's title is fully determined by the
  // route alone, and App's existing `titleFor(route)` sync already covers
  // that — see the comment on titleFor in routing.ts.

  return (
    <section aria-labelledby="join-heading" className="mx-auto w-full max-w-xl flex flex-1 flex-col justify-center gap-6 py-8">
      <div className="flex items-center gap-3">
        {/* Decorative; the heading names the screen. Present so this screen
            has the same visual weight at the top as Landing and Invalid. */}
        <span className="neo inline-flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[color-mix(in_oklab,var(--color-accent)_16%,transparent)] text-2xl text-[var(--color-accent)]">
          <IconQr />
        </span>
        <h1 id="join-heading" className="text-2xl font-semibold">Join a session</h1>
      </div>

      <div className="neo flex flex-col items-center gap-4 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center sm:p-8">
        {/*
          One region that always exists and whose text changes, rather than
          one mounted only for some statuses: a live region inserted at the
          same moment as its content is not reliably announced (see
          CreateScreen's identical comment/pattern) — this is what lets a
          screen-reader user who taps "Use the camera" and is then denied
          actually hear about it, instead of having to go looking for why.
        */}
        <p aria-live="polite" className="text-[var(--color-text-muted)]">{cameraMessage(scanner.status)}</p>
        {/*
          Mounted at every status, never conditionally: `start()` needs this
          element to already exist when it runs, and only `start()` can set
          'scanning' — so rendering the <video> off the 'scanning' status made
          the camera unstartable, which is exactly the bug this replaces.

          Hidden by `sr-only` rather than `hidden`/`display: none` when there
          is nothing to show: `sr-only` is position/clip based, so the element
          stays rendered and remains a valid `getUserMedia` target, whereas a
          display-hidden <video> can have playback suspended or refused
          outright by some engines.

          aria-hidden throughout: a silent camera preview conveys nothing a
          screen-reader user can act on, the decoded result is acted on
          immediately, and the live region above narrates the camera's state —
          AGENTS.md asks for decorative media to be hidden from assistive tech
          rather than handed a name that helps nobody.
        */}
        <video
          ref={scanner.videoRef}
          aria-hidden="true"
          className={scanner.status === 'scanning'
            ? 'neo-inset w-full rounded-[var(--radius-lg)] bg-black'
            : 'sr-only'}
          muted
          playsInline
        />
        {/* 'denied' is recoverable — grant the permission, tap again — so it
            keeps the affordance rather than leaving a page reload as the only
            way back. 'unsupported'/'unavailable' cannot be retried into
            working, so they get the message alone. */}
        {(scanner.status === 'idle' || scanner.status === 'denied') && (
          <Button variant="ghost" icon={<IconQr />} onClick={scanner.start}>
            {scanner.status === 'denied' ? 'Try the camera again' : 'Use the camera'}
          </Button>
        )}
      </div>

      {/*
        The guaranteed path: rendered regardless of camera status (never
        hidden behind "camera unavailable" — someone may simply prefer
        typing), and focused on mount on a fine (mouse/trackpad) pointer,
        since typing the code is what this screen is for and the camera is
        only ever an enhancement on top of it — see hasCoarsePointer for why
        a touch device is left to tap "Use the camera" without the on-screen
        keyboard popping up first. A pasted full link works here too —
        CodeInput extracts the code from it rather than truncating it.
      */}
      <div className="flex flex-col gap-2">
        <CodeInput
          value={code}
          onChange={setCode}
          onSubmit={onJoin}
          ariaLabel="Session code or pasted link"
          autoFocus={!hasCoarsePointer()}
        />
        <p className="text-center text-sm text-[var(--color-text-muted)]">
          {/* Both really do work now, which is the point of the whole
              key-agreement change: six characters read aloud get you in, and
              a pasted link gets you in too. */}
          Six characters from the other device, or paste its link.
        </p>
      </div>
    </section>
  );
}
