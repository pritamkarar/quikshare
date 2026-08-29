/**
 * What the outgoing stream is actually doing right now, read from
 * `RTCPeerConnection.getStats()`.
 *
 * Reporting only. Nothing here feeds back into the encoder — see
 * share-quality.ts for why this app steers WebRTC's own congestion control
 * rather than running a second loop beside it. These numbers exist so a
 * person can see what the network is giving them, which is the one thing
 * the browser's adaptation does not tell anybody.
 *
 * Every field is optional because every field genuinely can be missing: the
 * stats a browser exposes vary by browser, by codec and by how long the
 * connection has been up, and a report taken a moment after connecting
 * often has an outbound-rtp entry with no `framesPerSecond` yet. A missing
 * number must read as "not known yet", never as zero.
 */
export interface ShareStats {
  /** Outgoing video, in kilobits per second, averaged across the last sample gap. */
  kbps?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Round trip time over the selected candidate pair, in milliseconds. */
  rttMs?: number;
}

/**
 * The running total this sample was taken against, kept so the next one can
 * be turned into a rate. Bitrate is a derivative: a single `getStats()` call
 * reports bytes sent since the connection opened, which says nothing at all
 * about what is happening now.
 */
export interface StatsSample {
  bytesSent: number;
  /** `RTCStats.timestamp`, in milliseconds since the epoch. */
  timestamp: number;
}

/** The subset of an outbound-rtp video entry this module reads. */
interface OutboundVideo {
  bytesSent?: number;
  timestamp?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
}

/**
 * Derives one reading, plus the sample the next call should be compared
 * against.
 *
 * `previous` is what makes a rate possible; without it (the very first
 * reading of a connection) everything but `kbps` is still reported, because
 * resolution and frame rate are instantaneous values that need no history.
 *
 * A pure function of a report and a sample, with no clock and no state of
 * its own: the timestamps come from the report itself, which is both what
 * makes this testable against a hand-built Map and what keeps the arithmetic
 * honest when a poll is late.
 */
export function readShareStats(
  report: RTCStatsReport,
  previous?: StatsSample,
): { stats: ShareStats; sample: StatsSample | undefined } {
  let video: OutboundVideo | undefined;
  let rttSeconds: number | undefined;

  report.forEach((entry: Record<string, unknown>) => {
    if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
      video = entry as OutboundVideo;
      return;
    }
    // The pair actually carrying traffic. `succeeded` rather than
    // `nominated`: Chromium reports both, Firefox has historically not set
    // `nominated` at all, and a check on it alone silently yields no RTT
    // there.
    if (entry.type === 'candidate-pair' && entry.state === 'succeeded') {
      const rtt = entry.currentRoundTripTime;
      if (typeof rtt === 'number') rttSeconds = rtt;
    }
  });

  const stats: ShareStats = {
    width: video?.frameWidth,
    height: video?.frameHeight,
    fps: video?.framesPerSecond === undefined ? undefined : Math.round(video.framesPerSecond),
    rttMs: rttSeconds === undefined ? undefined : Math.round(rttSeconds * 1000),
  };

  if (video?.bytesSent === undefined || video.timestamp === undefined) {
    return { stats, sample: undefined };
  }
  const sample: StatsSample = { bytesSent: video.bytesSent, timestamp: video.timestamp };

  if (previous) {
    const seconds = (sample.timestamp - previous.timestamp) / 1000;
    const bytes = sample.bytesSent - previous.bytesSent;
    // Both guards are reachable, not defensive padding. A report can repeat
    // a timestamp (two polls inside one stats interval), which would divide
    // by zero; and the counter restarts from zero when the connection is
    // rebuilt underneath us, which would otherwise render as a large
    // negative rate.
    if (seconds > 0 && bytes >= 0) stats.kbps = Math.round((bytes * 8) / seconds / 1000);
  }

  return { stats, sample };
}

/** True when there is at least one number worth putting on screen. */
export function hasAnyStat(stats: ShareStats): boolean {
  return Object.values(stats).some((value) => value !== undefined);
}
