/**
 * What a screen share should protect when the network cannot carry
 * everything, and what the encoder should be told it is looking at.
 *
 * These do not manage bandwidth. WebRTC's own congestion control already
 * measures the path and moves the encoder's bitrate continuously, and a
 * second controller reading the same signals and writing the same knob
 * would fight it — two controllers on one plant, oscillating against each
 * other's corrections. What is missing without this file is not the
 * adaptation; it is any say in HOW it adapts. `degradationPreference`
 * decides what gets sacrificed first, and `contentHint` tells the encoder
 * whether it is compressing text or video. Both steer the browser's loop
 * rather than duplicating it.
 *
 * 'data' is the one preset that also sets hard caps, and that is not a
 * contradiction: a ceiling is a constraint, not a controller. Congestion
 * control goes on working normally underneath one. The other two set no
 * caps at all, because guessing a number for a network this side has not
 * measured is exactly the mistake the paragraph above describes.
 */
export type SharePreset = 'text' | 'motion' | 'data';

export const SHARE_PRESETS: readonly SharePreset[] = ['text', 'motion', 'data'];

export interface ShareQuality {
  /**
   * `MediaStreamTrack.contentHint`. 'detail' tells the encoder to spend its
   * bits on sharpness and accept a lower frame rate — what a slide, a
   * terminal or a code editor needs to stay readable. 'motion' is the
   * opposite trade, for anything that moves.
   */
  contentHint: 'detail' | 'motion';
  /** What the browser's own adaptation gives up first when bandwidth drops. */
  degradation: RTCDegradationPreference;
  /** A ceiling the user asked for, in bits per second. Absent means no ceiling. */
  maxBitrate?: number;
  maxFramerate?: number;
  /** Divides the captured dimensions before encoding. 2 means half width and half height. */
  scaleResolutionDownBy?: number;
}

export const SHARE_QUALITY: Record<SharePreset, ShareQuality> = {
  // Readability first. A caption that has gone soft is unreadable, while the
  // same slide at eight frames a second is merely slightly late.
  text: { contentHint: 'detail', degradation: 'maintain-resolution' },
  // The opposite trade: a video played through a screen share is watchable
  // when it is soft and unwatchable when it stutters.
  motion: { contentHint: 'motion', degradation: 'maintain-framerate' },
  // The only preset with numbers in it, because this is the only one where
  // the user has stated a limit rather than a preference. Roughly 0.6 Mbps
  // at half dimensions and ten frames a second — enough to follow along on
  // a metered connection, and far below what the other two would settle at
  // on a good one.
  data: {
    contentHint: 'detail',
    degradation: 'balanced',
    maxBitrate: 600_000,
    maxFramerate: 10,
    scaleResolutionDownBy: 2,
  },
};

/** What each preset is called, and the trade it makes, in the words the UI uses. */
export const SHARE_PRESET_COPY: Record<SharePreset, { label: string; detail: string }> = {
  text: { label: 'Sharp text', detail: 'Stays readable. Gives up frames first.' },
  motion: { label: 'Smooth motion', detail: 'Stays fluid. Gets softer first.' },
  data: { label: 'Save data', detail: 'Caps the stream well below what the link could carry.' },
};

/**
 * The preset a screen share opens on.
 *
 * 'text' rather than 'motion': the overwhelming majority of screen shares
 * are a document, a slide, an editor or a terminal, and the failure mode
 * this preset avoids — text too soft to read — makes the share worthless,
 * where the one it accepts merely makes it slightly behind.
 */
export const DEFAULT_SHARE_PRESET: SharePreset = 'text';
