import { useId, type ReactNode } from 'react';
import type { TransportKind } from '../transport/types.js';
import { Badge } from './Badge.js';
import { IconDirect, IconInfo, IconRelay } from './icons.js';

/**
 * Tone choice: relaying is not a fault. It is the normal fallback path the
 * whole WebRTC-with-relay design exists to provide, and on many networks
 * it is the only path — the note below says as much ("still encrypted end
 * to end"). Badge's `relayed` tone paints it with `--color-warning`, which
 * would tell the user something is wrong while the copy tells them nothing
 * is: a contradiction, not the redundant status cue AGENTS.md asks for.
 * `neutral` here mirrors the tone TransferPanel already uses one line down
 * for its save-tier notice ("Not an alert and not danger-colored: ... is
 * something to know, not something that went wrong.") — the same kind of
 * fact, styled the same way. `live` for the direct path uses the one accent
 * this palette reserves for a live state (tokens.css).
 *
 * No motion on the kind change: it fires at most once per session (the
 * quiet WebRTC upgrade), so a bespoke crossfade would need a second DOM
 * node and JS-timed mounting for a flourish almost nobody will watch
 * happen. An instant, honest swap is simpler and just as clear. The global
 * `prefers-reduced-motion` collapse in tokens.css already covers this for
 * free if a transition is ever added later.
 */
const COPY: Record<TransportKind, { tone: 'live' | 'neutral'; icon: ReactNode; label: string; note: string }> = {
  webrtc: {
    tone: 'live' as const,
    icon: <IconDirect />,
    label: 'Direct',
    note: 'Travelling straight between your devices, with nothing in between. Encrypted end to end.',
  },
  relay: {
    tone: 'neutral' as const,
    // Drawn with a node in the middle, so the picture itself says "through
    // something" — the difference from Direct is not carried by colour alone.
    icon: <IconRelay />,
    label: 'Relayed',
    note: 'Your network blocked a direct link, so your files travel through our server instead. Still encrypted end to end, and never stored there.',
  },
};

export interface TransportBadgeProps {
  kind: TransportKind;
}

/**
 * The transport, as a chip that sits beside the session heading, and its
 * explanation behind a click.
 *
 * The sentence used to be on screen permanently, under the heading. It is
 * worth reading once and then never again, and at that size it was the
 * largest thing in the session header — pushing the actual workspace down
 * on every screen for a fact that does not change after the first second.
 * The chip still says which path is in use in words, always; only the
 * paragraph moved.
 *
 * Behind the native `popover` attribute rather than component state: the
 * browser gives light-dismiss, Escape, top-layer stacking and focus
 * handling for free, and every one of those is a thing a hand-rolled
 * dropdown gets subtly wrong. Placement is CSS anchor positioning
 * (`.note-anchor` / `.note-pop` in client/styles/app.css), which degrades
 * to the UA's centred default where it is unsupported — a small centred
 * card, still readable, still dismissible.
 */
export function TransportBadge({ kind }: TransportBadgeProps) {
  const copy = COPY[kind];
  // Not a module constant: two of these on one page would collide, and an
  // id collision is exactly what silently breaks popovertarget.
  const noteId = useId();

  return (
    // role="status" implies aria-live="polite", but that mapping is
    // implicit — set it explicitly so the announcement doesn't depend on a
    // screen reader's default. It wraps the button rather than sitting
    // inside it: the region is what announces a change of transport, and a
    // live region is not itself a control.
    <span role="status" aria-live="polite" className="inline-flex">
      <button
        type="button"
        popoverTarget={noteId}
        // Contains the visible label verbatim (WCAG 2.5.3), and adds what
        // pressing it does — which the chip's own text cannot say.
        aria-label={`${copy.label} connection: what this means`}
        // min-h-11 is 44px, the tap-target floor every other control here
        // meets. The pill itself is 34px and stays that size — the extra
        // height is transparent padding around it, so the chip looks
        // identical and is no longer a 34px target for a thumb.
        className="note-anchor inline-flex min-h-11 cursor-pointer items-center rounded-full"
      >
        <Badge
          tone={copy.tone}
          icon={copy.icon}
          label={copy.label}
          // neo-press over Badge's own flat `neo`: it lifts on hover and
          // presses on click, which is how the chip says it is a control at
          // all. Both classes set only box-shadow and neo-press is declared
          // second in app.css, so this wins cleanly rather than fighting.
          className="neo-press"
        />
        {/* The affordance. Outside the pill rather than crammed inside it:
            Badge takes a plain string label, and a trailing glyph would mean
            widening Badge's contract for this one caller. */}
        <IconInfo aria-hidden="true" className="ml-1.5 text-sm text-[var(--color-text-muted)]" />
      </button>

      {/* No bare status label: say what it means for the person reading it.
          role="note" has no implicit element mapping, so it's set explicitly. */}
      <div id={noteId} popover="auto" className="note-pop neo max-w-xs rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <p role="note" className="text-pretty text-xs text-[var(--color-text-muted)]">
          {copy.note}
        </p>
      </div>
    </span>
  );
}
