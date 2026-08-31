import type { DeviceInfo } from "../../shared/device.js";
import type { TransportKind } from "../transport/types.js";
import { Button } from "./Button.js";
import { DEVICE_KIND } from "./device-kind.js";
import { IconExit, IconRelay } from "./icons.js";
import { TransportBadge } from "./TransportBadge.js";

export interface SessionHeaderProps {
  code: string;
  transportKind: TransportKind;
  self: DeviceInfo | undefined;
  peer: DeviceInfo | undefined;
  onEnd: () => void;
}

/**
 * The top of a paired session: who is connected to whom, and by which route.
 *
 * It replaces a bar that held a heading, a chip and a button in a band the
 * full width of the page — the one element every session opens on, saying
 * nothing about the session. Two things moved into it, and neither is
 * decoration:
 *
 *   - The pair itself. This app's whole proposition is that two devices are
 *     linked, and nothing on the page drew that link; the two device cards
 *     that carried the only clue were the LAST thing on the screen, under
 *     the transfer record. The glyph-line-glyph lockup below is that link,
 *     and the line is not a flourish: it is dashed through a relay node when
 *     the transport is relayed and solid when it is direct, so it states the
 *     same fact the badge beside it names (client/styles/app.css, `.flow-line`).
 *   - The session code, which the connected screen never showed at all. It
 *     is the one identifier that tells two open tabs apart, and the thing to
 *     read out if the other device has to come back.
 *
 * What the session has moved is deliberately NOT here: a batch progress bar
 * and per-direction tallies used to sit to the right of the link, and they
 * said — in different words, one card higher — what the transfer record
 * below already says per file. The header answers "who am I connected to";
 * "what has moved" is the record's question, and it only ever had one
 * honest answer on screen at a time.
 *
 * Everything here is derived from props — there is no timer and no state in
 * this file — so it re-renders exactly when the session it describes changes
 * and never on its own.
 */
export function SessionHeader({
  code,
  transportKind,
  self,
  peer,
  onEnd,
}: SessionHeaderProps) {
  return (
    <header className="neo flex flex-col gap-5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* connect-pop is the one deliberate entrance in the app: this
            heading only ever mounts at the instant pairing succeeds, which is
            the thing the user has been waiting for. */}
        <h1 id="transfer-heading" className="connect-pop text-xl font-semibold">
          Connected
        </h1>
        <TransportBadge kind={transportKind} />
        {/* Capped and centred from `lg`. Left to fill the card, the run
          between the two devices stretched across most of 1400px, at which
          width a 3px rule stops reading as a connection and starts reading
          as a horizontal divider someone left in. */}
        <div className="flex w-full items-start gap-2 sm:gap-5 lg:mx-auto lg:max-w-[42rem]">
          <LinkEnd title="This device" device={self} pending="Identifying…" />
          <Flow direct={transportKind === "webrtc"} />
          <LinkEnd title="The other device" device={peer} pending="Waiting…" />
        </div>
        {/* One group, so the code and the way out travel together when the
            row wraps. `justify-between` below `sm` rather than `ml-auto`
            everywhere: at phone width this group is the whole second line,
            and pinning it right left "End session" hanging alone under the
            heading with a hole beside it. */}
        <div className="flex w-full items-center justify-between gap-2 sm:ml-auto sm:w-auto">
          {/* Recessed rather than raised: this is a value to read, not a
              control to press, and the well is how every other read-only
              token on the page is drawn. */}
          <span className="neo-inset-sm mono rounded-full bg-[var(--color-surface-2)] px-3 py-1.5 text-sm tracking-[0.08em] text-[var(--color-text-muted)]">
            <span className="sr-only">Session code </span>
            <span translate="no">{code}</span>
          </span>
          {/* Ends the session by leaving the screen: unmounting tears down
              useSession, which posts `close` and terminates the worker, so the
              peer sees `peer-left`. Routing rather than a bespoke teardown also
              means this inherits useTransferGuards' navigation guard for free —
              with a transfer in flight, `navigateTo` runs the same confirm that
              already protects JoinLink, and a declined confirm leaves the
              session untouched. */}
          <Button
            variant="ghost"
            icon={<IconExit />}
            className="shrink-0"
            onClick={onEnd}
          >
            End session
          </Button>
        </div>
      </div>
    </header>
  );
}

/**
 * One end of the link. The glyph is raised while the two flanking it are
 * recessed or flat, which is what makes the row read as two objects with
 * something running between them rather than as three chips in a line.
 */
function LinkEnd({
  title,
  device,
  pending,
}: {
  title: string;
  device: DeviceInfo | undefined;
  pending: string;
}) {
  const Glyph = DEVICE_KIND[device?.kind ?? "unknown"].icon;
  return (
    <div className="flex min-w-0 basis-24 flex-col items-center gap-2 text-center sm:basis-32">
      <span className="neo inline-flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface)] text-xl text-[var(--color-text-muted)] sm:size-14 sm:text-2xl">
        <Glyph />
      </span>
      {/* The OS alone, not the "Safari on macOS" line DevicePanel draws. Two
          reasons, and the second is the real one: this column is a sixth of
          the header at phone width, and printing the same sentence twice on
          one screen makes the panel below look like a repeat rather than the
          detail view it is. Between the glyph (phone or computer) and the OS,
          the header answers "which of mine is that" on its own; the id that
          settles two identical devices stays in the panel. Both lines
          truncate anyway — every value here is user-agent-derived. */}
      <span className="min-w-0 max-w-full">
        <span className="block truncate text-xs font-semibold">{title}</span>
        <span className="block truncate text-[0.6875rem] text-[var(--color-text-muted)]">
          {device ? device.os : pending}
        </span>
      </span>
    </div>
  );
}

/**
 * The channel between the two devices, drawn as what it is.
 *
 * `aria-hidden`, and deliberately: every fact in here is already spoken by
 * the TransportBadge two lines above, which is a live region that announces
 * "Direct" or "Relayed" in words. A screen reader hearing the same state a
 * second time as a graphic would be told it twice.
 *
 * Relayed splits the line around a node, because that is the shape of the
 * path: two hops through a server in the middle. Direct is one unbroken run.
 */
function Flow({ direct }: { direct: boolean }) {
  const line = (
    <span
      className="flow-line h-[3px] min-w-3 flex-1 rounded-full"
      data-direct={direct ? "" : undefined}
    />
  );
  return (
    <div
      aria-hidden="true"
      className="flex min-w-0 flex-1 items-center gap-2 pt-6 sm:gap-3 sm:pt-7"
    >
      {line}
      {!direct && (
        <>
          <span className="neo-inset-sm inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-2)] text-sm text-[var(--color-text-muted)]">
            <IconRelay />
          </span>
          <span className="flow-line h-[3px] min-w-3 flex-1 rounded-full" />
        </>
      )}
    </div>
  );
}
