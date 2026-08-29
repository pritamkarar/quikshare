// tests/unit/share-stats.test.ts
/*
 * `readShareStats` is a pure function of a stats report and the previous
 * sample, with no clock of its own — the timestamps come from the report.
 * That is what lets these tests hand it a plain Map (an RTCStatsReport is
 * Map-like, and Node has no RTCPeerConnection to get a real one from) and
 * assert on arithmetic that would otherwise only be observable against a
 * live connection.
 */
import { describe, expect, it } from 'vitest';
import { hasAnyStat, readShareStats, type StatsSample } from '../../client/media/stats.js';

/** A stats report, built the way a browser lays one out: keyed entries with a `type`. */
function report(entries: Record<string, unknown>[]): RTCStatsReport {
  return new Map(entries.map((e, i) => [`id-${i}`, e])) as unknown as RTCStatsReport;
}

function outbound(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'outbound-rtp',
    kind: 'video',
    bytesSent: 1_000_000,
    timestamp: 10_000,
    frameWidth: 1920,
    frameHeight: 1080,
    framesPerSecond: 29.6,
    ...over,
  };
}

describe('readShareStats', () => {
  it('reads resolution and frame rate without any history', () => {
    const { stats } = readShareStats(report([outbound()]));
    expect(stats.width).toBe(1920);
    expect(stats.height).toBe(1080);
    // Rounded: a browser reports a float, and "29.6 fps" is more precision
    // than the number deserves.
    expect(stats.fps).toBe(30);
    // A rate needs two readings. The first one honestly has none.
    expect(stats.kbps).toBeUndefined();
  });

  it('derives the bitrate from the gap between two readings', () => {
    const first = readShareStats(report([outbound({ bytesSent: 1_000_000, timestamp: 10_000 })]));
    const second = readShareStats(
      report([outbound({ bytesSent: 1_250_000, timestamp: 12_000 })]),
      first.sample,
    );
    // 250_000 bytes in 2s = 1_000_000 bits/s = 1000 kbps.
    expect(second.stats.kbps).toBe(1000);
  });

  it('reports no rate rather than dividing by zero on a repeated timestamp', () => {
    const previous: StatsSample = { bytesSent: 1_000_000, timestamp: 10_000 };
    // Two polls landing inside one stats interval see the same timestamp.
    const { stats } = readShareStats(report([outbound({ bytesSent: 1_000_000, timestamp: 10_000 })]), previous);
    expect(stats.kbps).toBeUndefined();
  });

  it('reports no rate rather than a negative one when the counter restarts', () => {
    const previous: StatsSample = { bytesSent: 5_000_000, timestamp: 10_000 };
    // What a rebuilt connection looks like: the byte total starts again.
    const { stats } = readShareStats(report([outbound({ bytesSent: 1_000, timestamp: 12_000 })]), previous);
    expect(stats.kbps).toBeUndefined();
  });

  it('takes the round trip time from the pair actually carrying traffic', () => {
    const { stats } = readShareStats(report([
      outbound(),
      { type: 'candidate-pair', state: 'failed', currentRoundTripTime: 0.9 },
      { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.041 },
    ]));
    // Seconds on the wire, milliseconds on screen.
    expect(stats.rttMs).toBe(41);
  });

  it('omits every number the browser did not report, rather than showing a zero', () => {
    // A report taken moments after connecting: the entry exists, most of it
    // does not. "0 fps" beside a moving picture is worse than saying nothing.
    const { stats } = readShareStats(report([
      { type: 'outbound-rtp', kind: 'video', bytesSent: 100, timestamp: 1_000 },
    ]));
    expect(stats.fps).toBeUndefined();
    expect(stats.width).toBeUndefined();
    expect(stats.rttMs).toBeUndefined();
  });

  it('ignores audio and inbound entries', () => {
    const { stats, sample } = readShareStats(report([
      { type: 'outbound-rtp', kind: 'audio', bytesSent: 999, timestamp: 5_000, frameWidth: 1 },
      { type: 'inbound-rtp', kind: 'video', frameWidth: 640, frameHeight: 480 },
    ]));
    expect(stats.width).toBeUndefined();
    expect(sample).toBeUndefined();
  });

  it('knows when there is nothing worth putting on screen', () => {
    expect(hasAnyStat({})).toBe(false);
    expect(hasAnyStat({ fps: undefined })).toBe(false);
    expect(hasAnyStat({ fps: 0 })).toBe(true);
    expect(hasAnyStat({ kbps: 1200 })).toBe(true);
  });
});
