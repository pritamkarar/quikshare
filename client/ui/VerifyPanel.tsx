import { formatVerification } from '../crypto.js';
import { Button } from './Button.js';
import { IconCheck, IconShield } from './icons.js';

export interface VerifyPanelProps {
  /** Six digits from `deriveSession`; the panel renders nothing without them. */
  digits: string | undefined;
  verifiedByMe: boolean;
  verifiedByPeer: boolean;
  onConfirm: () => void;
}

/**
 * The one thing standing between this session and a machine-in-the-middle.
 *
 * The session key is agreed over the relay now (ECDH in the hello frame)
 * rather than carried in the link, which is what let the share URL lose its
 * `#` and 43 characters of base64 — and what gives the relay a position it
 * did not have before: swap both public keys and it holds one key with each
 * device, reading everything. What it cannot do is make the two devices
 * derive the SAME number, because it does not share one secret with both.
 * So the number is shown on both screens, and nothing sends until the people
 * looking at them agree.
 *
 * Which is why this is a gate and not a badge. A number nobody is required
 * to look at protects nobody; the whole design collapses to "trust the
 * relay" the moment this becomes dismissible.
 */
export function VerifyPanel({ digits, verifiedByMe, verifiedByPeer, onConfirm }: VerifyPanelProps) {
  // The joiner reaches 'paired' the moment the relay answers, which is before
  // the two devices have finished agreeing a key — so there is a real, if
  // short, window with no number to show yet. It says so, rather than
  // rendering an empty column where the send controls will be.
  if (!digits) {
    return (
      <p aria-live="polite" className="neo-inset rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-4 py-3 text-center text-sm text-[var(--color-text-muted)]">
        Agreeing a key with the other device…
      </p>
    );
  }
  const waiting = verifiedByMe && !verifiedByPeer;

  return (
    <section
      aria-labelledby="verify-heading"
      // Capped and centred rather than full width. This panel now spans the
      // page instead of sitting in a column, and six digits to be read off
      // two screens and compared are worth a card you look INTO — stretched
      // to 1400px the number floated in the middle of an empty band.
      className="neo mx-auto flex w-full max-w-2xl flex-col items-center gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center sm:p-8"
    >
      <div className="flex items-center gap-2 text-[var(--color-accent)]">
        <IconShield aria-hidden="true" />
        <h2 id="verify-heading" className="text-lg font-semibold text-[var(--color-text)]">
          Check this number
        </h2>
      </div>

      {/* translate="no": an auto-translated digit group would be compared
          against an untranslated one and read as a mismatch. tabular-nums
          because the two screens are read side by side, digit by digit. */}
      <p
        translate="no"
        data-testid="verification-number"
        className="mono text-3xl font-semibold tracking-[0.2em] tabular-nums sm:text-4xl"
      >
        {formatVerification(digits)}
      </p>

      <p className="max-w-sm text-pretty text-sm text-[var(--color-text-muted)]">
        Both devices should be showing the same number. If they are not, something is sitting
        between them. End the session and start a new one.
      </p>

      {/* Loading-shaped state, per AGENTS.md: the label says what is happening
          rather than going blank, and the button keeps its place so the layout
          does not jump when the peer answers. */}
      {waiting ? (
        <p aria-live="polite" className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <IconCheck aria-hidden="true" />
          Confirmed here. Waiting for the other device…
        </p>
      ) : (
        <Button icon={<IconCheck />} onClick={onConfirm} disabled={verifiedByMe}>
          The numbers match
        </Button>
      )}

      <p className="text-xs text-[var(--color-text-muted)]">
        Sending is off until both devices confirm.
      </p>
    </section>
  );
}
