import { useEffect, useId, useState, type ClipboardEvent } from 'react';
import { normalizeCode } from '../../shared/codes.js';
import { parseRoute } from '../routing.js';

export interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Called with the session code, typed or extracted from a pasted link. */
  onSubmit: (code: string) => void;
  /** Overridable so a screen with different context (e.g. one that also accepts a pasted link) can say so. */
  ariaLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * A pasted share link (`https://host/s/CODE`) is longer than any typed code
 * and would otherwise be clipped by `maxLength` before `onChange` ever sees
 * it — exactly the input someone who was *sent* a link, rather than shown a
 * QR code, is most likely to paste here. Reuses `parseRoute` (rather than
 * re-deriving the `/s/:code` shape) so this can never drift from what the
 * router itself accepts.
 *
 * Returns `undefined` for anything that is not a URL matching that shape —
 * a bare code (dashed, lowercase, whatever) is left entirely to the normal
 * character-by-character normalization in `onChange`, unchanged. A link that
 * still carries an old key fragment works too: `parseRoute` reads the path
 * and ignores whatever follows the `#`.
 */
function extractFromPastedLink(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined; // not an absolute URL at all
  }
  const route = parseRoute(url);
  return route.t === 'session' ? route.code : undefined;
}

/** Says what is wrong AND what "right" looks like, so the fix is obvious. */
const INCOMPLETE = 'Session codes are six characters. Check the other device and try again.';

/*
 * Border strengthens on hover/active/focus-visible using the same
 * mix-toward-color-text trick as Button (see Button.tsx): --color-border is
 * a low-opacity tint of --color-text already, so mixing more of --color-text
 * into it raises both its opacity and its distance from the surface behind
 * it, in both themes, without a literal color anywhere. focus-visible swaps
 * to the fully-opaque accent token and layers on top of the global
 * `:focus-visible` ring in app.css (not overridden here).
 */
const BORDER =
  'border-[var(--color-border-strong)] ' +
  'hover:border-[color-mix(in_oklab,var(--color-border-strong)_35%,var(--color-text)_65%)] ' +
  'active:border-[color-mix(in_oklab,var(--color-border-strong)_15%,var(--color-text)_85%)] ' +
  'focus-visible:border-[var(--color-accent)]';

export function CodeInput({
  value, onChange, onSubmit,
  ariaLabel = 'Session code', placeholder = 'K7M3QP', autoFocus = false,
}: CodeInputProps) {
  // A controlled <input> whose DOM value doesn't match `value` right after a
  // native input event gets that DOM value forcibly reset by React once the
  // event finishes — including when a consumer's `onChange` doesn't feed a
  // new `value` back in synchronously (e.g. this exact scenario in a test
  // harness, or a consumer that debounces). Without an internal echo, that
  // reset drops every character but the one just typed. Keeping our own
  // `display` state, updated inside this component regardless of what the
  // caller does with `onChange`, guarantees a real commit happens and the
  // DOM keeps the full accumulated text. `value` is still respected as the
  // source of truth for anything set from *outside* (initial value, a
  // programmatic reset/prefill) via the effect below.
  const [display, setDisplay] = useState(value);
  // AGENTS.md: an incomplete submission must surface validation. Pressing
  // Enter on a half-typed code used to do nothing whatsoever — no message, no
  // announcement, no focus move — at the exact moment someone who mistyped is
  // trying again, on the one path this screen guarantees.
  const [problem, setProblem] = useState('');
  const problemId = useId();

  useEffect(() => {
    setDisplay(value);
  }, [value]);

  return (
    <div className="flex w-full flex-col gap-1">
      <input
        type="text"
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        autoFocus={autoFocus}
        spellCheck={false}
        aria-label={ariaLabel}
        // Always pointed at the message element, which is always rendered: a
        // live region inserted at the same moment as its content is not
        // reliably announced (the same lesson as CreateScreen's status line).
        aria-describedby={problemId}
        aria-invalid={problem === '' ? undefined : true}
        placeholder={placeholder}
        value={display}
        maxLength={9}
        onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
          const pastedCode = extractFromPastedLink(event.clipboardData.getData('text'));
          // Not one of our links (or not a URL at all) — leave the native
          // paste alone so a plain, possibly dashed or lowercase code pastes
          // exactly as it always has, through the normal onChange path below.
          if (!pastedCode) return;
          event.preventDefault();
          setDisplay(pastedCode);
          onChange(pastedCode);
          // A full link is already a complete action, same as a QR scan, so it
          // submits immediately rather than waiting on a separate Enter press.
          onSubmit(pastedCode);
        }}
        onChange={(event) => {
          // Accept messy input and normalize; never block typing.
          const raw = event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
          const normalized = normalizeCode(raw) || raw;
          // Cleared as soon as they start fixing it, rather than nagging until
          // the next submit.
          setProblem('');
          setDisplay(normalized);
          onChange(normalized);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          const code = normalizeCode(display);
          if (!code) {
            // Pressing Enter twice on the same bad code re-sets an identical
            // string, so React does not re-render and the polite live region
            // does not re-announce. Left alone deliberately: the message is
            // already on screen and already tied to this field by
            // aria-describedby, and every way to force a repeat announcement
            // (clear, then restore a tick later) trades that for a flicker
            // and a timer to unwind on unmount.
            setProblem(INCOMPLETE);
            return;
          }
          setProblem('');
          onSubmit(code);
        }}
        // A literal 16px, not a rem-relative Tailwind class: this is the
        // threshold below which iOS silently zooms in on focus, so it must
        // never regress via an unrelated root font-size change elsewhere.
        style={{ fontSize: '16px' }}
        // A well, like every other place text is entered on this page. The
        // border above survives the change: on a recessed surface the shadow
        // says "input" and the border still carries the hover/focus state
        // change, which a shadow alone would not.
        className={`neo-inset mono min-h-14 w-full rounded-[var(--radius-md)] border bg-[var(--color-surface-2)] px-5 text-center uppercase tracking-[0.4em] text-[var(--color-text)] transition-colors duration-[var(--duration-fast)] ${BORDER}`}
      />
      {/* Rendered before it has anything to say (see aria-describedby above),
          and given a floor height so an appearing message does not shove the
          rest of the screen down. Polite, not assertive: AGENTS.md asks for
          polite live regions for inline validation. */}
      <p
        id={problemId}
        aria-live="polite"
        className="min-h-5 text-sm text-[var(--color-danger)]"
      >
        {problem}
      </p>
    </div>
  );
}
