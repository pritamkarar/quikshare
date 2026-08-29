import type { DeviceInfo } from '../../shared/device.js';
import { DEVICE_KIND } from './device-kind.js';

/**
 * Who is actually on this session, and on what.
 *
 * Everything here is informational — nothing in the transfer path reads a
 * field of it — but it answers a question the app could not previously
 * answer at all: *which* of my devices is this, and did I just pair with the
 * right one? The device id is what makes that concrete when both cards say
 * "Chrome on Android".
 *
 * A note on the peer's card: every value in it is a claim the other browser
 * made about itself, sanitised (`parseDeviceInfo`) but not verified — there
 * is no way to verify it and no reason to try, since nothing is authorised
 * by any of it. The heading says "The other device", never "Verified".
 */

/** Rendered in place of any field the device did not, or could not, supply. */
const UNKNOWN = 'Not available';

interface FieldProps {
  label: string;
  value: string | undefined;
  /**
   * Ids and pixel dimensions are compared character by character across the
   * two cards, which is exactly what a proportional font is bad at. Paired
   * with `numeric` (tabular figures) for the same reason — both classes live
   * in client/styles/app.css.
   */
  mono?: boolean;
}

/**
 * Label above value, in a column of a grid — where this used to be a
 * label-left/value-right row with a hairline under each one.
 *
 * Three stacked rows each drawing their own rule is the densest, dullest
 * shape a three-field spec can take, and it made a card of reference
 * material look like the most structured thing on the page. Reading down a
 * short column instead needs no rules at all, and it halves the card's
 * height, which is the whole reason this section could stay on a screen that
 * now leads with the same two devices.
 */
function Field({ label, value, mono = false }: FieldProps) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[0.6875rem] text-[var(--color-text-muted)]">{label}</dt>
      {/* break-all: a device id is long enough to push a column wider than
          its share of the card on a narrow screen. AGENTS.md. */}
      <dd
        className={`min-w-0 break-all text-sm ${mono ? 'mono numeric' : ''}`}
        // A device that reported nothing for this field gets muted text as
        // well as the words, so "Not available" never reads as a value.
        style={value === undefined ? { color: 'var(--color-text-muted)' } : undefined}
      >
        {value ?? UNKNOWN}
      </dd>
    </div>
  );
}

export interface DeviceCardProps {
  /** "This device" / "The other device" — the card's own heading. */
  title: string;
  device: DeviceInfo | undefined;
  /** Shown in place of the rows while `device` is undefined. */
  pending: string;
  /** The heading level's id, so the <dl> can be labelled by it. */
  headingId: string;
}

export function DeviceCard({ title, device, pending, headingId }: DeviceCardProps) {
  const kind = DEVICE_KIND[device?.kind ?? 'unknown'];
  const Glyph = kind.icon;

  return (
    <li className="neo lift rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex items-center gap-2.5">
        <span className="neo-inset-sm inline-flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface-2)] text-lg text-[var(--color-text-muted)]">
          <Glyph />
        </span>
        <div className="min-w-0">
          <h3 id={headingId} className="text-sm font-semibold">{title}</h3>
          {/* The one-line summary people actually read; the rows below are
              for when it is not enough to tell two devices apart. */}
          <p className="truncate text-xs text-[var(--color-text-muted)]">
            {device ? `${device.browser} on ${device.os}` : pending}
          </p>
        </div>
      </div>

      {device && (
        <dl
          aria-labelledby={headingId}
          className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--color-border-strong)] pt-3 lg:grid-cols-3"
        >
          <Field label="Type" value={kind.label} />
          {/* No IP address field. It was the most identifying value on the
              page and the least useful for the question these cards exist to
              answer — "is this the device in my hand?" — which the id and the
              screen size settle without publishing where either of you is
              sitting. The field still crosses the wire (shared/device.ts);
              nothing renders it. */}
          <Field label="Screen" value={device.screen} mono />
          {/* Last: the longest value of the three, and the one read least
              often. Three columns only from `lg`, where the two cards are
              wide enough for them; below that a device id in a third of a
              half-width card wraps to three lines. */}
          <Field label="Device ID" value={device.id} mono />
        </dl>
      )}
    </li>
  );
}

export interface DevicePanelProps {
  self: DeviceInfo | undefined;
  peer: DeviceInfo | undefined;
}

export function DevicePanel({ self, peer }: DevicePanelProps) {
  return (
    <section aria-labelledby="devices-heading" className="flex flex-col gap-3">
      <h2 id="devices-heading" className="text-[0.9375rem] font-semibold">Devices</h2>
      {/* A list, because that is what two peer cards are — and it keeps the
          reading order and the count available to a screen reader without a
          bespoke aria-label saying "2 devices". */}
      <ul className="grid gap-3 sm:grid-cols-2">
        <DeviceCard
          headingId="device-self"
          title="This device"
          device={self}
          pending="Working out what this device is…"
        />
        <DeviceCard
          headingId="device-peer"
          title="The other device"
          device={peer}
          pending="Waiting for the other device to introduce itself…"
        />
      </ul>
      {/* Said plainly rather than left implied. Two facts are worth knowing
          and neither is obvious from the cards: these details were swapped
          between the two browsers over the encrypted channel (so the relay
          did not learn the pairing from this feature), and nothing the other
          side reported about itself has been — or can be — verified. */}
      <p className="text-xs text-[var(--color-text-muted)]">
        Each device tells the other these details over the same encrypted channel your files use, and the
        relay never sees them. What the other device reports about itself is its own claim, and is not
        verified.
      </p>
    </section>
  );
}
