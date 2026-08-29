import { defaultRtcConfig } from '../transport/webrtc.js';

/**
 * ICE servers for the MEDIA connection: the build-time STUN list plus
 * whatever `GET /turn` offers.
 *
 * Fetched lazily, per share attempt, rather than at pairing — an idle
 * session makes no request, and a credential is never older than the click
 * that needed it (they are short-lived by design; see server/turn.ts).
 *
 * Every failure degrades to STUN-only instead of failing the share. A
 * deployment with no TURN configured is supported and common — on a LAN the
 * two devices connect over host candidates without needing either — so an
 * unreachable or unconfigured endpoint must not be the thing that stops
 * someone sharing their screen to the laptop next to them. The unconfigured
 * case doesn't even reach the catch block: `/turn` still answers 200 with
 * `{ iceServers: [], ttl: 0 }` (see server/turn.ts's resolveTurnConfig),
 * so it merges in zero servers and this function returns normally.
 *
 * The response is whitelisted rather than cast, like every other value that
 * crosses a trust boundary here: it reaches `new RTCPeerConnection`, and a
 * malformed entry throws synchronously in Chrome and Firefox.
 */
export async function mediaRtcConfig(): Promise<RTCConfiguration> {
  const base = defaultRtcConfig().iceServers ?? [];
  try {
    const res = await fetch('/turn', { headers: { accept: 'application/json' } });
    if (!res.ok) return { iceServers: base };
    const body = (await res.json()) as unknown;
    return { iceServers: [...base, ...parseIceServers(body)] };
  } catch {
    return { iceServers: base };
  }
}

/**
 * Whitelists the `/turn` response body into fresh RTCIceServer objects,
 * dropping anything that doesn't match — never casting, matching the house
 * pattern in shared/signals.ts and webrtc.ts's parseSignal. An entry needs a
 * non-empty array of string `urls` plus string `username` and `credential`;
 * anything else (wrong types, a missing field, extra fields, the whole body
 * not being `{ iceServers: [...] }`) is dropped rather than passed through,
 * so one malformed entry from an attacker-reachable endpoint can't throw
 * inside `new RTCPeerConnection` and take the media path down with it.
 */
function parseIceServers(body: unknown): RTCIceServer[] {
  if (typeof body !== 'object' || body === null) return [];
  const { iceServers } = body as Record<string, unknown>;
  if (!Array.isArray(iceServers)) return [];

  const result: RTCIceServer[] = [];
  for (const entry of iceServers) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { urls, username, credential } = entry as Record<string, unknown>;
    if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u) => typeof u === 'string')) continue;
    if (typeof username !== 'string' || typeof credential !== 'string') continue;
    result.push({ urls: [...urls] as string[], username, credential });
  }
  return result;
}

/**
 * True when `config` carries at least one server beyond the single
 * build-time STUN entry `defaultRtcConfig()` always contributes — i.e.
 * `/turn` actually returned something usable. This is how
 * `MediaPeer.offer()`/`answer()` tell `LiveSession` (via
 * `MediaPeerEvents.onIceConfig`) whether the deployment has TURN, without
 * a second `/turn` request of its own: TransferPanel used to probe `/turn`
 * a second time, on mount, purely to decide this — see this file's own
 * `mediaRtcConfig` doc comment for why that violated the "no request while
 * idle" contract this function's caller now upholds instead. Comparing
 * counts, not duck-typing particular URLs, matches `parseIceServers`' own
 * "shape, not content" whitelisting above.
 */
export function hasTurnServer(config: RTCConfiguration): boolean {
  const base = defaultRtcConfig().iceServers?.length ?? 0;
  return (config.iceServers?.length ?? 0) > base;
}
