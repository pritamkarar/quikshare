import { chromium, expect, test, type Browser } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { closePair, makeFixture, pair } from './helpers.js';

/*
 * The one thing no unit or jsdom-component test can prove: that a real
 * `RTCPeerConnection` actually negotiates a live camera stream between two
 * browser contexts, and that doing so leaves the separate file-transfer
 * connection alone (spec §6 / plan 04's whole reason for keeping the two
 * connections apart — client/media/media-peer.ts's own class doc comment).
 *
 * Chromium's fake camera (`--use-fake-device-for-media-stream`) and
 * fake-UI (`--use-fake-ui-for-media-stream`) launch flags are what make this
 * runnable headlessly at all: without them, `getUserMedia` would hang on a
 * permission prompt nothing here can click, or fail outright with no camera
 * hardware in CI. Both are launch-time Chromium flags, not per-context
 * options, so this suite launches its own `chromium` instance rather than
 * using the shared `browser` fixture the rest of tests/e2e/ relies on — the
 * shared instance is already running by the time a test file sees it, with
 * no way to retroactively add launch args.
 *
 * Screen sharing is deliberately NOT covered here. `getDisplayMedia`
 * headlessly needs `--auto-select-desktop-capture-source`, which picks a
 * real desktop capture source — but a headless Linux CI runner has no
 * desktop to capture, so the picker has nothing to select and the capture
 * fails with no window/screen source available, confirmed while writing
 * this suite. That is an environment gap, not a code path this app leaves
 * unproven: capture.ts's `captureScreen()`, LiveSession's kind-switching,
 * and LiveSection's screen-share rendering (no Mute control, since a screen
 * share carries no audio track) are all exercised without a browser in
 * tests/unit/capture.test.ts, tests/unit/live-session.test.ts, and
 * tests/ui/live-section.test.tsx. Only "does a real RTCPeerConnection carry
 * real video end to end" needs a real browser, and camera proves that
 * exactly as well as screen would.
 */

let browser: Browser;

test.beforeAll(async () => {
  browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
});

test.afterAll(async () => {
  await browser.close();
});

/** The sharer's own `<video>`, inside Live's promoted card. */
function localPreview(page: import('@playwright/test').Page) {
  return page.getByRole('region', { name: /^live$/i }).locator('video');
}

/**
 * Polls the watcher's `<video>` for a frame that has actually decoded —
 * `readyState` reaching `HAVE_CURRENT_DATA` (2) and a non-zero
 * `videoWidth` — rather than asserting the element merely exists. An
 * element existing proves LiveSection rendered the Watching branch; it says
 * nothing about whether MediaPeer ever actually received a track, which is
 * the one thing this suite exists to prove a component test cannot.
 */
async function waitForRealFrame(page: import('@playwright/test').Page) {
  const video = page.getByRole('region', { name: /^live$/i }).locator('video');
  await expect(video).toBeVisible({ timeout: 20_000 });
  await expect.poll(
    () => video.evaluate((el: HTMLVideoElement) => el.readyState >= 2 && el.videoWidth > 0),
    { timeout: 20_000, message: 'watcher video never decoded a real frame (readyState/videoWidth stayed 0)' },
  ).toBe(true);
}

test.describe('live camera sharing', () => {
  test('a real camera track reaches the watcher, and the sharer\'s own preview is muted', async () => {
    const session = await pair(browser, 'relay', ['camera', 'microphone']);
    const { host, guest } = session;

    try {
      await host.page.getByRole('button', { name: /share camera/i }).click();

      // The sharer's own local preview: visible immediately on capture
      // (LiveSection's 'offering' state), and always muted locally — an
      // unmuted preview would feed this device's own mic back through its
      // own speakers a few feet from where it's picked up (LiveSection.tsx's
      // Sharing component doc comment).
      const preview = localPreview(host.page);
      await expect(preview).toBeVisible({ timeout: 15_000 });
      await expect(preview).toHaveJSProperty('muted', true);

      // The watcher: a real track, not just an element. Chromium's fake
      // device paints a moving test pattern, so a decoded frame with
      // non-zero dimensions is a genuine negotiated stream, not a stale
      // placeholder.
      await waitForRealFrame(guest.page);

      // Requirement 3 (spec §6's "Watching" row): the note that starting a
      // reply replaces what's being watched. Scoped to the Live region —
      // Share's own always-present one-stream note ("starting one replaces
      // whatever is already running") matches the same loose /replace/i
      // and would otherwise make this an ambiguous, two-element match.
      await expect(guest.page.getByRole('region', { name: /^live$/i }).getByText(/replace/i)).toBeVisible();
    } finally {
      await closePair(session);
    }
  });

  test('a file transfer still completes while a camera stream is live', async () => {
    const session = await pair(browser, 'relay', ['camera', 'microphone']);
    const { host, guest } = session;
    const fixture = makeFixture(256 * 1024);

    try {
      await host.page.getByRole('button', { name: /share camera/i }).click();
      await waitForRealFrame(guest.page);

      // The data path and the media path are two separate connections on
      // purpose (client/media/media-peer.ts's class doc comment) — this is
      // the assertion that actually proves it: a file sent while a stream
      // is live must arrive byte-identical, same as with no stream running
      // at all (tests/e2e/transfer.spec.ts).
      const downloadPromise = guest.page.waitForEvent('download', { timeout: 45_000 });
      await host.page.getByRole('button', { name: /choose files/i }).click();
      await host.page.locator('input[type="file"]').setInputFiles(fixture.path);

      const download = await downloadPromise;
      const savedPath = await download.path();
      expect(savedPath).not.toBeNull();
      expect(Buffer.compare(readFileSync(savedPath!), fixture.bytes)).toBe(0);

      // And the stream itself was never disturbed by the transfer.
      await expect(localPreview(host.page)).toBeVisible();
    } finally {
      await closePair(session);
    }
  });

  test('stopping the share removes the remote video on both sides', async () => {
    const session = await pair(browser, 'relay', ['camera', 'microphone']);
    const { host, guest } = session;

    try {
      await host.page.getByRole('button', { name: /share camera/i }).click();
      await waitForRealFrame(guest.page);

      await host.page.getByRole('button', { name: /stop sharing/i }).click();

      // Live collapses back out of the DOM entirely on both sides (spec
      // §6) — not merely hidden, and not merely "no video element" while
      // some other Live chrome lingers.
      await expect(host.page.getByRole('region', { name: /^live$/i })).toHaveCount(0);
      await expect(guest.page.getByRole('region', { name: /^live$/i })).toHaveCount(0);

      // The Share buttons stay put on both sides — spec §6's placement is
      // unconditional on Live's state, not something Stop sharing removes.
      await expect(host.page.getByRole('button', { name: /share camera/i })).toBeVisible();
      await expect(guest.page.getByRole('button', { name: /share camera/i })).toBeVisible();
    } finally {
      await closePair(session);
    }
  });
});
