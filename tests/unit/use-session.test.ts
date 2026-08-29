// tests/unit/use-session.test.ts
import { describe, expect, it } from 'vitest';
import { forceTransportFromUrl } from '../../client/hooks/useSession.js';

/**
 * `Session` runs inside a Web Worker, whose own `location.href` is the
 * worker SCRIPT's URL, not the page's — so this parsing has to happen on the
 * page and be threaded through the worker's 'init' message. Tested as a pure
 * function of a URL string rather than by rendering the hook, since that's
 * the entire piece of logic this file owns for Ruling C's escape hatch; the
 * suppression behaviour itself is proven at the Session and worker layers
 * (tests/integration/upgrade-fallback.test.ts, tests/unit/transfer-worker.test.ts).
 */
describe('forceTransportFromUrl', () => {
  it('returns relay when the query string asks for it', () => {
    expect(forceTransportFromUrl('https://quik.share/s/K7M3QP?forceTransport=relay')).toBe('relay');
  });

  it('returns undefined with no query string at all', () => {
    expect(forceTransportFromUrl('https://quik.share/s/K7M3QP')).toBeUndefined();
  });

  it('returns undefined for an unrelated or misspelled value, rather than silently forcing relay', () => {
    expect(forceTransportFromUrl('https://quik.share/s/K7M3QP?forceTransport=webrtc')).toBeUndefined();
    expect(forceTransportFromUrl('https://quik.share/s/K7M3QP?forcetransport=relay')).toBeUndefined();
  });
});
