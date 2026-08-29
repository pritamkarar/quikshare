import { describe, expect, it } from 'vitest';
import { parseMediaAnswer, parseMediaIce, parseMediaOffer } from '../../shared/media-signal.js';

const SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n';

describe('parseMediaOffer', () => {
  it('keeps a well-formed offer', () => {
    expect(parseMediaOffer({ sdp: SDP, kind: 'camera' })).toEqual({ sdp: SDP, kind: 'camera' });
    expect(parseMediaOffer({ sdp: SDP, kind: 'screen' })?.kind).toBe('screen');
  });

  /*
   * The peer holds the same session key, so a sealed frame proves only that
   * the OTHER BROWSER sent it — not that its contents are sane. Everything
   * here reaches setRemoteDescription, and `decodeControl` is a bare
   * JSON.parse cast with no runtime validation at all.
   */
  it('rejects anything that is not an object with a string sdp', () => {
    for (const bad of [null, undefined, 'sdp', 42, [], {}, { sdp: 42, kind: 'camera' }]) {
      expect(parseMediaOffer(bad)).toBeUndefined();
    }
  });

  it('rejects an unrecognised kind rather than defaulting one', () => {
    // A default would mean a peer could make the UI say "camera" while
    // sending a screen — a small lie, but one the user reads as a fact.
    expect(parseMediaOffer({ sdp: SDP, kind: 'microphone' })).toBeUndefined();
    expect(parseMediaOffer({ sdp: SDP })).toBeUndefined();
  });

  it('drops unexpected fields rather than passing them through', () => {
    const parsed = parseMediaOffer({ sdp: SDP, kind: 'camera', evil: true }) as unknown as Record<string, unknown>;
    expect(parsed).toEqual({ sdp: SDP, kind: 'camera' });
    expect('evil' in parsed).toBe(false);
  });

  /*
   * An SDP is bounded in practice by what a browser generates — a few
   * kilobytes. A peer that sends megabytes is not negotiating.
   */
  it('rejects an implausibly large sdp', () => {
    expect(parseMediaOffer({ sdp: 'v=0\r\n'.repeat(100_000), kind: 'camera' })).toBeUndefined();
  });
});

describe('parseMediaIce', () => {
  it('keeps the four fields addIceCandidate reads', () => {
    const parsed = parseMediaIce({
      candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host',
      sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abc123',
    });
    expect(parsed).toEqual({
      candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abc123',
    });
  });

  it('tolerates the optional fields being absent', () => {
    expect(parseMediaIce({ candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host' }))
      .toEqual({ candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host' });
  });

  it('rejects a non-string candidate or wrong-typed optionals', () => {
    expect(parseMediaIce({ candidate: 42 })).toBeUndefined();
    expect(parseMediaIce({ candidate: 'c', sdpMid: 42 })).toBeUndefined();
    expect(parseMediaIce({ candidate: 'c', sdpMLineIndex: 'x' })).toBeUndefined();
    expect(parseMediaIce({ candidate: 'c', usernameFragment: 42 })).toBeUndefined();
  });

  it('rejects an implausibly long usernameFragment', () => {
    expect(parseMediaIce({ candidate: 'c', usernameFragment: 'x'.repeat(1000) })).toBeUndefined();
  });
});

describe('parseMediaAnswer', () => {
  it('keeps a string sdp and nothing else', () => {
    expect(parseMediaAnswer({ sdp: SDP, kind: 'camera' })).toEqual({ sdp: SDP });
  });
  it('rejects a missing or non-string sdp', () => {
    expect(parseMediaAnswer({})).toBeUndefined();
    expect(parseMediaAnswer({ sdp: 42 })).toBeUndefined();
  });
});
