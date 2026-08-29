/*
 * What one device tells the other about itself, and the rules for believing
 * it.
 *
 * This lives in shared/ rather than client/ because both ends of the wire
 * need the same shape: the browser that *describes* itself (client/device.ts)
 * and the browser that *renders* the description (client/ui/DevicePanel.tsx)
 * are different machines, and the second one is reading attacker-controlled
 * text. `parseDeviceInfo` below is the only way this type is allowed to come
 * into existence from the wire.
 */

export const DEVICE_KINDS = ['mobile', 'tablet', 'desktop', 'unknown'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export interface DeviceInfo {
  /**
   * Stable per browser profile, not per session — it is how someone tells
   * "my laptop" from "my other laptop" across several transfers. Minted and
   * kept by the device it names (client/device.ts); it is not a credential
   * and nothing is ever authorised by it.
   */
  id: string;
  kind: DeviceKind;
  /** "Windows", "Android", "iOS"… — a family, never a version string. */
  os: string;
  /** "Chrome", "Safari", "Firefox"… — likewise. */
  browser: string;
  /**
   * As observed by the relay, and forwarded here by the device it belongs to
   * — never by the server on that device's behalf. A peer therefore only
   * ever learns the address its counterpart chose to send, and the frame
   * carrying it is sealed, so the relay cannot read the pairing back out of
   * its own traffic.
   */
  ip?: string;
  /** CSS pixels, pre-formatted ("1920 × 1080") by the device that measured it. */
  screen?: string;
}

/**
 * Long enough for "Samsung Internet" and an IPv6 address with a zone id,
 * short enough that a hostile peer cannot push the panel's layout around
 * with a 10 kB "browser name".
 */
const MAX_FIELD_CHARS = 48;

/**
 * Strips anything that is not printable text, then clamps.
 *
 * The stripping is the part that matters. `\p{C}` covers the Cf format
 * category, which is where the bidi overrides live (U+202E and friends) —
 * left in, they let a peer make "Chrome" render as "emorhC", or paint an
 * arbitrary string over the label beside it. The `Zl`/`Zp` separators are
 * removed for the same reason a newline is: every field here is rendered on
 * one line, and a line break in the middle of one is a layout the panel was
 * never designed for. Returns undefined rather than '' so a field that
 * sanitised down to nothing is *absent* — the UI already renders an absent
 * field as "unknown", and an empty string would render as a blank row that
 * looks like a bug.
 */
export function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const stripped = value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return stripped === '' ? undefined : stripped.slice(0, MAX_FIELD_CHARS);
}

function isDeviceKind(value: unknown): value is DeviceKind {
  return DEVICE_KINDS.some((kind) => kind === value);
}

/**
 * The trust boundary for the peer's self-description.
 *
 * The frame this arrives on is AEAD-sealed, so the *relay* cannot have
 * forged it — but the peer holds the same key, and `decodeControl`
 * (client/protocol.ts) is a bare `JSON.parse(...) as ControlMessage` with no
 * runtime validation at all. Every field below is therefore whatever the
 * other browser felt like putting there, and all of it is rendered as text
 * next to labels the user will read as facts. Same discipline as
 * `Session.#handleResumeFrom`, for the same reason: a TypeScript annotation
 * on a wire type is not a runtime guarantee.
 *
 * Returns undefined for anything without a usable `id`, so a malformed
 * message is dropped whole rather than half-rendered.
 */
export function parseDeviceInfo(value: unknown): DeviceInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;

  const id = cleanText(raw.id);
  if (id === undefined) return undefined;

  return {
    id,
    kind: isDeviceKind(raw.kind) ? raw.kind : 'unknown',
    os: cleanText(raw.os) ?? 'Unknown system',
    browser: cleanText(raw.browser) ?? 'Unknown browser',
    ip: cleanText(raw.ip),
    screen: cleanText(raw.screen),
  };
}

/**
 * Trims the IPv4-mapped IPv6 form Node hands back for a v4 client reaching a
 * dual-stack listener (`::ffff:203.0.113.7`). Purely cosmetic: the address is
 * the same either way, but the prefix is noise to everyone who is not
 * debugging a socket, and it is what a plain `request.ip` produces in the
 * most ordinary deployment there is.
 */
export function formatIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1]! : ip;
}
