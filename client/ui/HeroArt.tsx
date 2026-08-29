/*
 * The landing hero: a phone showing its session code, a laptop receiving the
 * file, and the sealed parcel crossing between them.
 *
 * Authored as inline SVG rather than shipped as an image for three reasons
 * that matter here: it stays crisp at any density with no srcset, it costs a
 * couple of KB inside the JS that already loads, and — the deciding one — it
 * is drawn in theme tokens, so it recolours with light and dark mode instead
 * of needing two exported PNGs that drift apart.
 *
 * The phone's screen draws a QR code rather than the three grey placeholder
 * bars it used to. Those bars said "a device with something on it", which is
 * true of every device; the QR is the actual first screen of this app, it is
 * what the picture is asking you to scan, and its finder patterns are the
 * same shape as the product's own mark (client/ui/Logo.tsx). The laptop's
 * screen gained the other half of that story — a file part-way through
 * arriving — so the two ends of the wire now show a before and an after
 * instead of two identical stand-ins.
 *
 * Decorative. The <h1> and the paragraph beside it already say what the
 * product does, so this carries `aria-hidden` and adds nothing for a screen
 * reader to repeat.
 *
 * The dash animation is the only motion, it runs on `stroke-dashoffset`
 * (paint-only, never layout), and the global reduced-motion collapse in
 * app.css already flattens it to a static dashed line.
 */

/** One QR finder pattern: the square-in-a-square, at the given corner. */
function Finder({ x, y }: { x: number; y: number }) {
  return (
    <>
      <rect x={x} y={y} width="14" height="14" rx="4.5" fill="none" stroke="var(--color-accent)" strokeWidth="3" />
      <rect x={x + 5} y={y + 5} width="4" height="4" rx="1.2" fill="var(--color-accent)" />
    </>
  );
}

export function HeroArt({ className = '' }: { className?: string }) {
  return (
    <svg
      // Cropped tight to the artwork: the devices end at y=196, so a taller
      // box would ship empty space that reads as a layout gap on the page.
      viewBox="0 0 420 208"
      className={className}
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="hero-screen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.14" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.03" />
        </linearGradient>
        <linearGradient id="hero-card" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-accent)" />
          <stop offset="100%" stopColor="var(--color-success)" />
        </linearGradient>
      </defs>

      {/* Phone, showing the code to scan. */}
      <g stroke="var(--color-border-strong)" strokeWidth="2" fill="var(--color-surface)">
        <rect x="24" y="40" width="92" height="156" rx="18" />
      </g>
      <rect x="32" y="48" width="76" height="140" rx="12" fill="url(#hero-screen)" />
      <rect x="57" y="55" width="26" height="4" rx="2" fill="var(--color-border-strong)" />

      {/* The QR. Three finder patterns and a scatter of modules — enough to
          read as a code at a glance without pretending to be a scannable one,
          which at this size it could never be. */}
      <Finder x={44} y={76} />
      <Finder x={82} y={76} />
      <Finder x={44} y={114} />
      <g fill="var(--color-accent)" opacity="0.55">
        <rect x="82" y="114" width="5" height="5" rx="1.4" />
        <rect x="91" y="114" width="5" height="5" rx="1.4" />
        <rect x="82" y="123" width="5" height="5" rx="1.4" />
        <rect x="91" y="123" width="14" height="5" rx="1.4" />
        <rect x="65" y="97" width="5" height="5" rx="1.4" />
        <rect x="74" y="97" width="5" height="5" rx="1.4" />
        <rect x="65" y="106" width="14" height="5" rx="1.4" />
        <rect x="65" y="115" width="5" height="5" rx="1.4" />
      </g>
      {/* The six characters under the code, as a shape rather than as text:
          any real string here would be a fake session code on a marketing
          page, and a blurred one at this size besides. */}
      <rect x="52" y="144" width="36" height="6" rx="3" fill="var(--color-text-muted)" opacity="0.45" />

      {/* Laptop, with the file part-way in. */}
      <g stroke="var(--color-border-strong)" strokeWidth="2" fill="var(--color-surface)">
        <rect x="250" y="56" width="146" height="102" rx="14" />
      </g>
      <rect x="258" y="64" width="130" height="86" rx="9" fill="url(#hero-screen)" />
      <path
        d="M236 172h174a8 8 0 0 1-8 8H244a8 8 0 0 1-8-8Z"
        fill="var(--color-surface-2)"
        stroke="var(--color-border-strong)"
        strokeWidth="2"
        strokeLinejoin="round"
      />

      {/* The arriving file: a row, and a progress track part-filled. The fill
          is static — a bar that animated forever would be the one thing on
          this page still moving after the eye has left it. */}
      <rect x="272" y="80" width="102" height="30" rx="8" fill="var(--color-surface)" opacity="0.75" />
      <rect x="281" y="88" width="14" height="14" rx="4" fill="var(--color-accent)" opacity="0.3" />
      <g fill="var(--color-text-muted)" opacity="0.6">
        <rect x="303" y="89" width="46" height="5" rx="2.5" />
        <rect x="303" y="98" width="28" height="5" rx="2.5" />
      </g>
      <rect x="272" y="122" width="102" height="7" rx="3.5" fill="var(--color-surface-2)" />
      <rect x="272" y="122" width="64" height="7" rx="3.5" fill="var(--color-accent)" opacity="0.85" />

      {/* The path the file takes: phone's right edge to the laptop's left
          edge, apex at (183, 74). Dashed and animated, so it reads as motion
          rather than as a static connector. */}
      <path
        d="M120 128Q183 44 246 104"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="7 9"
        opacity="0.7"
        className="hero-wire"
      />

      {/* The file in flight, sealed. Centred on the arc's apex so it rides the
          wire; the drift below is ±10px, which keeps it clear of the phone
          (ends x=116) and the laptop (starts x=250) at every frame. */}
      <g className="hero-parcel">
        <rect x="157" y="48" width="52" height="52" rx="16" fill="url(#hero-card)" />
        <path
          d="M173 65h12m-12 9h20m-20 9h15"
          stroke="var(--color-accent-fg)"
          strokeWidth="2.5"
          strokeLinecap="round"
          opacity="0.95"
        />
        <circle cx="207" cy="96" r="13" fill="var(--color-success)" />
        <path
          d="M203.5 93.5v-2a3.5 3.5 0 0 1 7 0v2"
          fill="none"
          stroke="var(--color-accent-fg)"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <rect x="202" y="93.5" width="10" height="7.5" rx="2" fill="var(--color-accent-fg)" />
      </g>
    </svg>
  );
}
