/**
 * Every way `getUserMedia`/`getDisplayMedia` can fail to hand back a
 * `MediaStream`, collapsed into one small set the UI can phrase without
 * knowing anything about `DOMException` names or browser quirks. Kept as a
 * plain discriminated union — like `MediaControl` in shared/messages.ts —
 * rather than an enum, so a caller narrowing on `.reason` gets the
 * `detail` field typed in only where it exists.
 */
export type CaptureFailure =
  | { reason: 'denied' } // the user said no, or policy said no for them
  | { reason: 'no-device' } // there is no camera to permit
  | { reason: 'unsupported' } // insecure context, or a browser that doesn't do this
  | { reason: 'failed'; detail: string };

/**
 * The only error captureCamera()/captureScreen() ever reject with. A live
 * media capture is never a transfer error (Global Constraints, plan 04) —
 * this type has no connection to `session.error`, and nothing here throws
 * into the transfer path — so it is its own small class rather than reusing
 * whatever error shape the transfer code already has.
 */
export class CaptureError extends Error {
  constructor(readonly failure: CaptureFailure) {
    super(failure.reason);
  }
}

/** Which way a camera points. The two values `facingMode` actually reports. */
export type Facing = 'user' | 'environment';

/**
 * Camera carries the microphone (spec §3): a silent video call is a
 * surprise, and asking for both in one prompt is one interruption, not two.
 *
 * `facing` is a preference, not a demand — `ideal`, not `exact`. The first
 * capture of a session must succeed on a laptop with one webcam that
 * reports no facingMode at all, and an `exact` constraint there fails with
 * OverconstrainedError rather than handing back the only camera present.
 * The flip below is the opposite case and uses `exact` for the opposite
 * reason.
 */
export async function captureCamera(facing?: Facing): Promise<MediaStream> {
  const video: boolean | MediaTrackConstraints = facing ? { facingMode: { ideal: facing } } : true;
  return request('getUserMedia', () => navigator.mediaDevices.getUserMedia({ video, audio: true }));
}

/**
 * A replacement video track pointing the other way, with no audio.
 *
 * Video only, deliberately: the microphone track already in the call keeps
 * running across a flip, so re-requesting audio would hand back a second
 * one, drop whatever mute state the user had set on the first, and — on
 * some browsers — briefly light the recording indicator a second time.
 *
 * `exact` here, where `captureCamera` uses `ideal`: a flip that silently
 * returns the same camera is a button that does nothing, which is worse
 * than one that reports it could not. The caller only offers the control
 * when `countCameras()` found more than one, so the constraint has
 * somewhere to land.
 */
export async function captureCameraVideo(facing: Facing): Promise<MediaStream> {
  return request('getUserMedia', () => navigator.mediaDevices.getUserMedia({
    video: { facingMode: { exact: facing } },
    audio: false,
  }));
}

/**
 * How many cameras this device has, or 0 if it cannot say.
 *
 * Only meaningful once permission has been granted — before that, browsers
 * report a single placeholder entry with no label to avoid fingerprinting.
 * Every caller here asks while a capture is already running, which is
 * exactly when the answer is real.
 */
export async function countCameras(): Promise<number> {
  if (!navigator.mediaDevices?.enumerateDevices) return 0;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput').length;
  } catch {
    // enumerateDevices can reject under a restrictive permissions policy.
    // Not knowing is not a failure worth reporting — it just means no flip
    // control, which is the same outcome as a device with one camera.
    return 0;
  }
}

/** Which way the live track says it points, or undefined where it does not say. */
export function facingOf(track: MediaStreamTrack | undefined): Facing | undefined {
  const mode = track?.getSettings().facingMode;
  return mode === 'user' || mode === 'environment' ? mode : undefined;
}

/**
 * Whether this track can drive the lamp.
 *
 * `torch` is not in TypeScript's DOM lib — it is an optional extension to
 * MediaTrackCapabilities, implemented by Chromium on Android and essentially
 * nowhere else — so it is read dynamically rather than as a typed field, the
 * same way `showSaveFilePicker` is in client/save/fsaccess.ts.
 *
 * Capability is a property of the live track, not of the device: the same
 * phone reports a torch on its rear camera and none on its front one, so
 * this must be re-asked after every flip rather than cached per session.
 */
export function hasTorch(track: MediaStreamTrack | undefined): boolean {
  if (!track?.getCapabilities) return false;
  try {
    return Reflect.get(track.getCapabilities(), 'torch') === true;
  } catch {
    return false;
  }
}

/**
 * Turns the lamp on or off on a live track.
 *
 * `advanced`, not a plain constraint: torch is an optional capability, and a
 * basic constraint naming an unsupported one makes the whole
 * `applyConstraints` call reject — which would take the rest of the track's
 * settings down with it. Rejections are the caller's to handle; a lamp that
 * refuses to light is worth saying out loud rather than leaving a button
 * that looks like it worked.
 */
export async function setTorch(track: MediaStreamTrack, on: boolean): Promise<void> {
  // Cast through `unknown`: `torch` is absent from lib.dom's
  // MediaTrackConstraintSet for the same reason it is absent from
  // MediaTrackCapabilities above — it is an optional extension the type
  // definitions do not carry.
  await track.applyConstraints({ advanced: [{ torch: on }] } as unknown as MediaTrackConstraints);
}

/**
 * Video only. Chromium can capture tab audio; Firefox and Safari cannot,
 * and neither can capture system audio on a whole-screen share. Requesting
 * it would mean the feature works on one browser and silently does nothing
 * on the others — worse than not offering it, because the user cannot tell
 * which they are getting.
 */
export async function captureScreen(): Promise<MediaStream> {
  return request('getDisplayMedia', () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }));
}

/**
 * Whether this browser can capture a screen at all — false on essentially
 * every mobile browser, where `getDisplayMedia` simply does not exist (see
 * `request` below, which is the same check one layer down).
 *
 * Offered so the UI can leave the control out rather than present a button
 * whose only possible outcome on that device is "your browser doesn't
 * support this". The guard in `request` stays regardless: it is what catches
 * the Chromium-on-Android case where the method IS defined and fails anyway,
 * and it is the only thing standing between a caller and a raw TypeError.
 */
export function supportsScreenCapture(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/**
 * `capability` names the one `mediaDevices` method the caller is about to
 * invoke, and the guard checks exactly that method — not just "does
 * `mediaDevices` exist" — because the two calls have different support
 * footprints. `navigator.mediaDevices` itself is undefined outside a secure
 * context, which covers `getUserMedia`; but plenty of browsers that support
 * `getUserMedia` (most mobile browsers, notably) have no `getDisplayMedia`
 * at all. Checking only `getUserMedia`, as a single shared guard naturally
 * would, lets a screen-capture call on such a browser fall through to
 * `fn()`, where `getDisplayMedia` doesn't exist and calling it throws a
 * plain TypeError — which `classify` cannot recognise as anything but
 * `'failed'`. That reads to the user as "something went wrong" instead of
 * the more honest and actionable "your browser doesn't support this",
 * exactly the confusion this guard exists to prevent.
 */
async function request(capability: 'getUserMedia' | 'getDisplayMedia', fn: () => Promise<MediaStream>): Promise<MediaStream> {
  if (!navigator.mediaDevices?.[capability]) throw new CaptureError({ reason: 'unsupported' });
  try {
    return await fn();
  } catch (err) {
    throw new CaptureError(classify(err));
  }
}

function classify(err: unknown): CaptureFailure {
  const name = err instanceof DOMException ? err.name : '';
  // NotAllowedError also covers the user dismissing the screen-picker, which
  // is a normal cancellation and must not be phrased as a permission problem.
  if (name === 'NotAllowedError' || name === 'SecurityError') return { reason: 'denied' };
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { reason: 'no-device' };
  return { reason: 'failed', detail: err instanceof Error ? err.message : String(err) };
}

/**
 * Fires when the stream ends without us ending it — overwhelmingly, the user
 * clicking the browser's own "Stop sharing" bar, which no amount of UI state
 * tracking would otherwise notice. Without this the app keeps claiming to
 * share a screen the browser stopped feeding it.
 */
export function onStreamEnded(stream: MediaStream, cb: () => void): () => void {
  const track = stream.getVideoTracks()[0];
  if (!track) return () => {};
  track.addEventListener('ended', cb);
  return () => track.removeEventListener('ended', cb);
}
