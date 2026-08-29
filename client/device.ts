import { type DeviceInfo, type DeviceKind } from '../shared/device.js';

/*
 * What this browser can honestly say about the machine it is running on.
 *
 * Read on the *page*, never in the transfer worker, for two reasons: a
 * worker has no `screen`, and it has no `localStorage` at all — so the id
 * below could not be persisted from in there. `useSession` calls this and
 * threads the result through the worker's 'init' message, the same way it
 * already does for the save tier.
 *
 * Everything here is a guess dressed up as a label. User-agent sniffing is
 * unreliable by construction, and this is the one place in the app where
 * that is acceptable: nothing branches on the answer, no bytes are routed
 * differently because of it, and the worst outcome of getting it wrong is a
 * line of cosmetic text that says "Linux" about a Chromebook. Anything that
 * ever needs to *behave* differently per device must feature-detect instead.
 */

const DEVICE_ID_KEY = 'quik-share.device-id';
const ID_BYTES = 6;

/**
 * Chrome's User-Agent Client Hints, which are not in lib.dom yet. Only the
 * two low-entropy fields are declared: the rest need an async permission
 * dance this feature does not deserve.
 */
interface UserAgentData {
  readonly mobile?: boolean;
  readonly platform?: string;
}

function userAgentData(): UserAgentData | undefined {
  return (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
}

/** `a1b2-c3d4-e5f6` — grouped so it can be read aloud or compared at a glance. */
function mintId(): string {
  const bytes = new Uint8Array(ID_BYTES);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return (hex.match(/.{4}/g) ?? [hex]).join('-');
}

/**
 * The same id every time this browser profile opens the app, so a device is
 * recognisable across sessions rather than looking like a new machine on
 * every transfer.
 *
 * Both halves are wrapped: `localStorage` is not merely empty but *throws on
 * access* in a Safari private window and wherever site data is blocked
 * outright, and a throw here would take down the whole session for a
 * cosmetic label. The fallback is a fresh per-page id, which is wrong in the
 * "stable across sessions" sense and right in every sense the panel actually
 * renders — it still distinguishes this device from the peer.
 */
function deviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY);
    if (stored !== null && stored !== '') return stored;
  } catch {
    return mintId();
  }
  const minted = mintId();
  try {
    localStorage.setItem(DEVICE_ID_KEY, minted);
  } catch {
    // Storage is readable but not writable (quota, or a policy that allows
    // reads of an existing store). The id is still good for this page.
  }
  return minted;
}

/**
 * Order matters more than the individual tests.
 *
 * `userAgentData.mobile` is the only non-sniffed signal available, but it is
 * a boolean: it cannot distinguish a tablet from a phone, so a true answer
 * still falls through to the string tests below to decide which. iPadOS is
 * checked before the desktop default because Safari on an iPad has claimed
 * to be a Macintosh since iPadOS 13 — `maxTouchPoints` is what gives it
 * away, and without that line every iPad in the world reports "desktop".
 */
function detectKind(ua: string): DeviceKind {
  const hinted = userAgentData()?.mobile;
  if (/\biPad\b/.test(ua)) return 'tablet';
  // Android's own convention: a phone carries "Mobile", a tablet does not.
  if (/Android/.test(ua) && !/Mobile/.test(ua)) return 'tablet';
  if (/Tablet|PlayBook|Silk/.test(ua)) return 'tablet';
  if (hinted === true || /Mobi|iPhone|iPod|Windows Phone|BlackBerry/i.test(ua)) return 'mobile';
  // The iPadOS desktop-UA case. Guarded on Macintosh so a touchscreen laptop
  // running Windows is not misread as a tablet.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'tablet';
  if (hinted === false) return 'desktop';
  return /Windows|Macintosh|Linux|CrOS|X11/.test(ua) ? 'desktop' : 'unknown';
}

function detectOs(ua: string): string {
  if (/Windows NT|Windows Phone/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/\biPad\b/.test(ua)) return 'iPadOS';
  if (/iPhone|iPod/.test(ua)) return 'iOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  // Again before macOS: an iPad claiming to be a Mac is still an iPad.
  if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? 'iPadOS' : 'macOS';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return userAgentData()?.platform ?? 'Unknown system';
}

/**
 * Ordered most-specific-first, which is the whole trick: every one of these
 * browsers puts "Safari" in its UA string, most also put "Chrome" there, and
 * a naive `includes('Chrome')` reports Edge, Opera and Samsung Internet as
 * Chrome. Each test below is for a token only that one browser carries.
 */
function detectBrowser(ua: string): string {
  if (/\bEdgi?A?O?S?\//.test(ua)) return 'Edge';
  if (/\bOPR\/|\bOpera\//.test(ua)) return 'Opera';
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'Firefox';
  if (/\bCriOS\//.test(ua)) return 'Chrome';
  // HeadlessChrome is what an automated Chromium reports, and the word
  // boundary before "Chrome" below does not match inside it — leaving every
  // browser-driven test of this app reporting itself as Safari on Linux,
  // which is a confusing thing to see in a screenshot.
  if (/\b(?:Headless)?Chrome\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua)) return 'Safari';
  return 'Unknown browser';
}

/**
 * CSS pixels of the whole display, not of this window: the window can be any
 * size and tells you nothing about the machine, while "1920 × 1080" against
 * "390 × 844" is instantly legible as "laptop" against "phone".
 *
 * A thin space around the multiplication sign, and U+00D7 rather than the
 * letter x, because this is a dimension rather than a word — the same
 * typographic care AGENTS.md asks for elsewhere.
 */
function describeScreen(): string | undefined {
  const { width, height } = screen;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return `${Math.round(width)} × ${Math.round(height)}`;
}

/**
 * `ip` is deliberately absent here: this browser cannot see its own public
 * address, only the relay can. `Session` fills it in from the `created` /
 * `joined` signal before the description ever goes out to the peer.
 */
export function describeThisDevice(): DeviceInfo {
  const ua = navigator.userAgent;
  return {
    id: deviceId(),
    kind: detectKind(ua),
    os: detectOs(ua),
    browser: detectBrowser(ua),
    screen: describeScreen(),
  };
}
