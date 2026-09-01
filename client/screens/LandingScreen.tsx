import type { ComponentType, ReactNode } from 'react';
import { navigateTo } from '../routing.js';
import { Button } from '../ui/Button.js';
import { HeroArt } from '../ui/HeroArt.js';
import {
  IconCamera, IconClock, IconDesktop, IconDirect, IconExpand, IconKey, IconLink,
  IconPlus, IconQr, IconSend, IconShield, type IconProps,
} from '../ui/icons.js';

/**
 * What the product is, and the two things you can do with it.
 *
 * This screen exists so that '/' has no side effect. It previously mounted
 * CreateScreen, which allocates a room on the relay the moment it renders —
 * so every page load, refresh and crawler consumed a room code and a slot in
 * the create rate limit for a session nobody had asked for. Creating one is
 * now an explicit act with its own route.
 *
 * Four sections, and deliberately four different shapes: a split hero, a
 * connected rail, a bento grid, and a closing band. The page used to be a
 * hero followed by six identical cards in two rows of three, which is the
 * layout every generated landing page arrives at and which says the same
 * thing about all six claims — that none of them is more important than any
 * other. The grid below is sized by what actually matters: end-to-end
 * encryption is the reason to pick this over a chat attachment, so it is the
 * cell that is twice the size of the others and the only one that is filled.
 */

/** One capability, and how much of the grid it is worth. */
interface Point {
  icon: ComponentType<IconProps>;
  title: string;
  body: string;
  /** Column and row span from `lg` up; below that every cell is equal. */
  span: string;
  /**
   * The two deliberate exceptions to the soft-UI rule that a surface shares
   * the page's color (client/styles/tokens.css). At most two cells in the
   * grid set this, or the exception stops reading as one.
   */
  fill?: 'accent' | 'dots';
}

const POINTS: Point[] = [
  {
    icon: IconShield,
    title: 'Encrypted end to end',
    body: 'The two devices agree a key directly and show you a number to compare, so you can see the relay stayed out of it. We only ever carry ciphertext.',
    span: 'lg:col-span-2 lg:row-span-2',
    fill: 'accent',
  },
  {
    icon: IconCamera,
    title: 'Camera and screen, live',
    body: 'Show the other device what you are looking at: your camera and mic, or your whole screen. Nothing is recorded anywhere. Close the tab and it is gone.',
    span: 'lg:col-span-4',
    fill: 'dots',
  },
  {
    icon: IconKey,
    title: 'No account, no install',
    body: 'Open the page on both devices. That is the whole setup.',
    span: 'lg:col-span-2',
  },
  {
    icon: IconExpand,
    title: 'No size limit',
    body: 'Files stream straight to disk as they arrive, so a multi-gigabyte transfer never has to fit in memory.',
    span: 'lg:col-span-2',
  },
  {
    icon: IconDirect,
    title: 'Direct when it can be',
    body: 'Files go browser to browser when the network allows it, and through our relay when it does not. The session says which.',
    span: 'lg:col-span-3',
  },
  {
    icon: IconDesktop,
    title: 'Know both devices',
    body: 'Every session shows what is on each end — phone or computer, and which system it runs — so you can confirm you reached the right one.',
    span: 'lg:col-span-3',
  },
];

/** The three moments between opening the page and watching a file move. */
const STEPS: { icon: ComponentType<IconProps>; title: string; body: string }[] = [
  {
    icon: IconPlus,
    title: 'Start on one device',
    body: 'One tab, one button. A code and a QR appear straight away.',
  },
  {
    icon: IconQr,
    title: 'Scan it with the other',
    body: 'Point its camera at the code, or type the six characters by hand.',
  },
  {
    icon: IconSend,
    title: 'Drop a file in',
    body: 'Compare the number both screens show, then send in either direction.',
  },
];

/** Section shell: one measure, one vertical rhythm, one reveal, everywhere. */
function Section({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="reveal flex flex-col gap-8">
      {children}
    </section>
  );
}

export function LandingScreen() {
  return (
    <div
      // The page's own measure, on the wrapper rather than on any one
      // section: all four share it, and App deliberately sets only the
      // outer ceiling (see its comment). The attribute is the hook the
      // routing test asserts that separation through, matching
      // TransferPanel's `data-session-columns`.
      data-landing-shell
      className="aurora mx-auto flex w-full max-w-6xl flex-col gap-24 py-8 lg:gap-32 lg:py-12"
    >
      {/* ------------------------------------------------------------------
          Hero. Two columns from `lg` up, one below it. Stacked at every
          width, this hero left a 1600px screen showing a centred 672px
          column with the artwork pushed below the fold — the pitch and the
          picture never met. Side by side, the copy keeps a comfortable
          measure while the art takes the space that was empty.
          ------------------------------------------------------------------ */}
      <section
        aria-labelledby="landing-heading"
        className="grid items-center gap-10 pt-2 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14 lg:pt-4"
      >
        <div className="stagger-in flex flex-col items-center gap-6 text-center lg:items-start lg:text-left">
          {/* The mark used to sit here too. It came out when AppHeader arrived:
              the two stacked directly on top of each other, 28px above 64px,
              which reads as a rendering mistake rather than as branding. The
              header carries the identity on every route now, and this screen
              keeps the headline and HeroArt, which is the better hero anyway. */}
          <h1
            id="landing-heading"
            className="text-balance text-4xl font-semibold tracking-[-0.035em] sm:text-5xl xl:text-[4.25rem] xl:leading-[0.98]"
          >
            Send anything to your{' '}
            <span className="text-[var(--color-accent)]">other device</span>
          </h1>

          {/* Twenty-three words, three lines at this measure. The ceiling is
              the fold, not a word count: an earlier version ran to thirty-five
              words and four lines, which pushed the buttons off a laptop
              screen — the one thing a hero must never do. Three lines clears
              it, and buys the sentence room to name all four things the
              session can carry rather than only the one the headline does.

              "live video" became "your camera or your whole screen" because
              the two are separate controls in the session (TransferPanel's
              Share column) and a screen share is the half nobody guesses from
              the shorter phrase. */}
          <p className="max-w-md text-pretty text-lg text-[var(--color-text-muted)]">
            Scan a code and the two browsers link up. Files, notes, your camera or your whole
            screen — both ways, encrypted end to end.
          </p>

          <div className="flex w-full max-w-sm flex-col gap-3 pt-1 sm:flex-row sm:justify-center lg:justify-start">
            <Button icon={<IconPlus />} className="sm:min-w-44" onClick={() => navigateTo('/new')}>
              Start a session
            </Button>
            <Button variant="ghost" icon={<IconLink />} className="sm:min-w-44" onClick={() => navigateTo('/join')}>
              Join a session
            </Button>
          </div>
        </div>

        {/* Out of the stagger-in column and into its own grid cell, so it can
            sit beside the copy rather than under it. `float` gives it a slow
            vertical drift — transform only, and flattened under
            prefers-reduced-motion (client/styles/app.css). */}
        <HeroArt className="float mx-auto w-full max-w-lg lg:max-w-none" />
      </section>

      {/* ------------------------------------------------------------------
          The rail: three moments on one line, threaded by the same dashed
          wire the hero artwork draws. Not three cards — a card around each
          step would say they are three separate things, and the whole point
          of this section is that they are one motion.
          ------------------------------------------------------------------ */}
      <Section id="steps-heading">
        <h2 id="steps-heading" className="max-w-2xl text-balance text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">
          Two devices, one code
        </h2>

        <ol className="grid gap-10 sm:grid-cols-3 sm:gap-8">
          {STEPS.map(({ icon: Glyph, title, body }, index) => (
            <li key={title} className="relative flex flex-col items-center gap-3 text-center sm:items-start sm:text-left">
              {/*
                The thread, drawn per step rather than as one span across the
                whole row. A single absolutely-positioned line has to guess
                where the first and last chips are as a percentage of the
                grid, and that guess is wrong the moment the column count or
                the gap changes — it was, at 1440px, by about 40px at each
                end. A segment that starts at its own chip and runs to the
                next column has nothing to guess.

                Only from `sm` up, where the steps are actually in a row:
                stacked on a phone a horizontal line would connect nothing.
                `-right-8` reaches exactly across `sm:gap-8`.
              */}
              {index < STEPS.length - 1 && (
                <div
                  aria-hidden="true"
                  className="absolute left-14 -right-8 top-6 hidden border-t-2 border-dashed border-[var(--color-border-strong)] opacity-40 sm:block"
                />
              )}
              {/*
                Raised and filled with the page color, so it sits ON the
                dashed line above rather than being crossed out by it. This is
                the one place the soft-UI extrusion is doing real
                compositional work instead of decoration.
              */}
              <span className="neo relative flex size-12 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface)] text-xl text-[var(--color-accent)]">
                <Glyph />
              </span>
              <h3 className="text-base font-semibold">{title}</h3>
              <p className="max-w-xs text-pretty text-sm text-[var(--color-text-muted)]">{body}</p>
            </li>
          ))}
        </ol>
      </Section>

      {/* ------------------------------------------------------------------
          The capability grid.
          ------------------------------------------------------------------ */}
      <Section id="capabilities-heading">
        <div className="flex flex-col gap-3">
          <h2 id="capabilities-heading" className="max-w-2xl text-balance text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">
            Nothing to sign up for. Nothing left behind.
          </h2>
        </div>

        <ul
          // Named, because it is not the only list on this page any more and
          // "the capability list" is the one a test — or a screen reader
          // user skipping by landmark — actually wants.
          aria-label="What Quik Share does"
          // `lg:` on the row sizing, not unprefixed, and that prefix is a bug
          // fix. Equal auto-rows is what makes the double-height cell exactly
          // twice a normal one; in a SINGLE column it instead makes every
          // card as tall as the tallest, which on a phone gave six cards of
          // identical height with two thirds of most of them empty. Rows only
          // need to agree once there is more than one card in them.
          className="grid gap-4 sm:grid-cols-2 lg:auto-rows-[minmax(0,1fr)] lg:grid-cols-6 lg:gap-5"
        >
          {POINTS.map(({ icon: Glyph, title, body, span, fill }) => {
            const accent = fill === 'accent';
            return (
              <li
                key={title}
                // h-full so the cards in a row share one height: without it a
                // three-word body and a three-line one produced a ragged row of
                // raised surfaces, which reads as broken rather than as staggered.
                className={[
                  'neo lift flex h-full flex-col rounded-[var(--radius-lg)] border p-6',
                  span,
                  fill === 'dots' ? 'grid-dots' : '',
                  accent
                    ? 'fill-accent border-transparent lg:p-8'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)]',
                ].join(' ')}
              >
                <span
                  className={[
                    'mb-5 inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-xl',
                    accent
                      // On the filled cell the chip cannot be a recessed well
                      // — an inset built from the PAGE's light and dark tones
                      // reads as a smear on an accent fill, the same reason
                      // Button splits `neo-fill` from `neo-press`.
                      ? 'bg-[rgb(255_255_255/18%)] text-[var(--color-accent-fg)]'
                      : 'neo-inset-sm bg-[color-mix(in_oklab,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]',
                  ].join(' ')}
                >
                  <Glyph />
                </span>
                <div>
                  <h3 className={accent ? 'text-lg font-semibold' : 'text-base font-semibold'}>{title}</h3>
                  <p
                    className={[
                      // A measure, not a width: the wide cell is 4 columns
                      // across and its three sentences would otherwise run as
                      // 110-character lines.
                      'mt-2 max-w-[58ch] text-pretty text-sm',
                      accent ? 'text-[color-mix(in_oklab,var(--color-accent-fg)_82%,transparent)]' : 'text-[var(--color-text-muted)]',
                    ].join(' ')}
                  >
                    {body}
                  </p>
                </div>

                {/*
                  The filled cell spans two rows, so its copy alone left a
                  third of it empty. What fills it is the thing the copy is
                  actually about: the number this app puts on both screens
                  before it will send a byte, drawn the way VerifyPanel draws
                  it (mono, tabular, wide-tracked). `mt-auto` pushes it to the
                  foot of whatever height the row ends up being.

                  aria-hidden and captioned as an example, because the digits
                  are a sample of a shape, not a value: a real session derives
                  its own six from the key the two devices agree, and a screen
                  reader announcing this one would be reading out a number
                  that means nothing.
                */}
                {accent && (
                  <div aria-hidden="true" className="mt-auto pt-8">
                    <p className="text-xs opacity-70">For example</p>
                    <p className="mono mt-1.5 inline-flex rounded-[var(--radius-sm)] bg-[rgb(255_255_255/16%)] px-3.5 py-2 text-xl font-semibold tracking-[0.22em] tabular-nums">
                      X8G HT7
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      {/* ------------------------------------------------------------------
          The close. One recessed band rather than another raised card: the
          page has been handing out raised surfaces for three sections, and
          the last thing on it should read as the floor rather than as one
          more thing on top of it.
          ------------------------------------------------------------------ */}
      <Section id="start-heading">
        <div className="neo-inset flex flex-col items-center gap-6 rounded-[var(--radius-xl)] bg-[var(--color-surface-2)] px-6 py-12 text-center sm:px-12 sm:py-16">
          <h2 id="start-heading" className="max-w-xl text-balance text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">
            Open it on the other device
          </h2>
          {/* Not "no upload": files DO cross our relay whenever the network
              refuses a direct link (the "Direct when it can be" card above
              says so), and a landing page that quietly claims otherwise is
              the one kind of copy this product cannot afford. What is true is
              that nothing is kept. */}
          <p className="max-w-lg text-balance text-[var(--color-text-muted)]">
            No sign-in, and nothing kept once both tabs are closed.
          </p>
          <div className="flex w-full max-w-sm flex-col gap-3 pt-1 sm:flex-row sm:justify-center">
            <Button icon={<IconPlus />} className="sm:min-w-44" onClick={() => navigateTo('/new')}>
              Start a session
            </Button>
            <Button variant="ghost" icon={<IconLink />} className="sm:min-w-44" onClick={() => navigateTo('/join')}>
              Join a session
            </Button>
          </div>
          {/* The one claim on this page that is about time rather than
              capability, and it belongs here rather than in the hero, where
              it would be a fifth text element in a stack that allows four. */}
          <p className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <IconClock aria-hidden="true" />
            A session lasts exactly as long as both tabs stay open
          </p>
        </div>
      </Section>
    </div>
  );
}
