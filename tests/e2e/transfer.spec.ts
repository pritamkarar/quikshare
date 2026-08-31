import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { closePair, makeFixture, pair } from './helpers.js';

const SIZE = 3 * 1024 * 1024;

/*
 * `?forceSave=blob` from the original task brief cannot be implemented here:
 * this task is explicitly barred from touching anything under `client/`
 * (useSession.ts included), so there is no escape hatch to force the
 * in-memory sink. That turns out not to matter — real headless Chromium's
 * own `detectSaveCapability()` resolves to 'sw-stream' at http://127.0.0.1
 * (a potentially-trustworthy origin, so service workers register fine over
 * plain HTTP), never 'blob'. That tier has no "Save" link to click at all: a
 * received file streams straight into a real browser download the moment the
 * receiver opens the sink, via a hidden iframe navigating to a
 * service-worker-intercepted URL (see client/save/swstream.ts). So instead of
 * the brief's click-a-Save-link flow, these tests wait on Playwright's real
 * `download` event directly — which is arguably the better test: it is
 * exactly "the Service Worker streaming save tier triggers a real browser
 * download" the task's own brief calls out as the thing only a real browser
 * can exercise, exercised for real rather than routed around it.
 */

/*
 * 'relay' pins the deterministic path (see the task context: forceTransport
 * is threaded from the page through the worker into Session, so this
 * actually suppresses the WebRTC upgrade rather than merely hoping the
 * network fails). 'auto' (no override) exercises the real
 * attempt-then-fall-back code path — whether it lands on 'webrtc' or falls
 * back to 'relay' depends on real ICE/STUN reachability on whatever network
 * runs this suite, so the assertion below only checks the bytes, never which
 * transport carried them.
 */
for (const forced of ['relay', 'auto'] as const) {
  test(`transfers a file byte-identically over the ${forced} transport`, async ({ browser }) => {
    const fixture = makeFixture(SIZE);
    const session = await pair(browser, forced === 'relay' ? 'relay' : undefined);
    const { host, guest } = session;

    try {
      const downloadPromise = guest.page.waitForEvent('download', { timeout: 45_000 });

      await host.page.getByRole('button', { name: /choose files/i }).click();
      await host.page.locator('input[type="file"]').setInputFiles(fixture.path);

      const download = await downloadPromise;
      const savedPath = await download.path();
      expect(savedPath).not.toBeNull();
      expect(Buffer.compare(readFileSync(savedPath!), fixture.bytes)).toBe(0);
    } finally {
      await closePair(session);
    }
  });
}

test('a text snippet crosses in both directions', async ({ browser }) => {
  const session = await pair(browser, 'relay');
  const { host, guest } = session;

  try {
    await guest.page.getByRole('textbox', { name: /text to send/i }).fill('crossing over');
    await guest.page.getByRole('textbox', { name: /text to send/i }).press('ControlOrMeta+Enter');
    await expect(host.page.getByText('crossing over')).toBeVisible({ timeout: 15_000 });

    await host.page.getByRole('textbox', { name: /text to send/i }).fill('and back again');
    await host.page.getByRole('textbox', { name: /text to send/i }).press('ControlOrMeta+Enter');
    await expect(guest.page.getByText('and back again')).toBeVisible({ timeout: 15_000 });
  } finally {
    await closePair(session);
  }
});

test('an expired code lands on a recoverable screen, not a 404', async ({ page }) => {
  await page.goto('/s/ZZZZZZ');
  await expect(page.getByRole('button', { name: /start a new session/i })).toBeVisible({ timeout: 15_000 });
});

test('a real transfer asks the browser to keep the screen awake', async ({ browser }) => {
  const fixture = makeFixture(SIZE);
  const session = await pair(browser, 'relay');
  const { host, guest } = session;

  try {
    /*
     * Recorded rather than observed: headless Chromium grants no screen wake
     * lock, so what can be checked here is that the app *asked* at the moment
     * it had something to protect — which is the half the unit tests
     * (tests/ui/transfer-guards.test.tsx) cannot show, since they drive a
     * fake `inFlight` rather than a real transfer.
     *
     * Patched into the live page rather than installed with addInitScript,
     * which would need a reload — and reloading the host at /new allocates a
     * fresh room and abandons the guest that just paired with it. Patching
     * late is sound because useTransferGuards reads `navigator.wakeLock` when
     * `inFlight` first turns true, which is when the file below is chosen,
     * not when the panel mounted.
     */
    await host.page.evaluate(() => {
      const requests: string[] = [];
      (window as unknown as { wakeLockRequests: string[] }).wakeLockRequests = requests;
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          request: async (type: string) => {
            requests.push(type);
            return { release: async () => {} };
          },
        },
      });
    });

    const downloadPromise = guest.page.waitForEvent('download', { timeout: 45_000 });

    await host.page.getByRole('button', { name: /choose files/i }).click();
    await host.page.locator('input[type="file"]').setInputFiles(fixture.path);

    await expect
      .poll(
        () => host.page.evaluate(() => (window as unknown as { wakeLockRequests: string[] }).wakeLockRequests),
        { timeout: 20_000 },
      )
      .toContain('screen');

    // Seen through to the end, so this cannot pass on a transfer that never
    // actually started moving.
    await downloadPromise;
  } finally {
    await closePair(session);
  }
});

test('ending the session sends the other device home, not to a rejoin screen', async ({ browser }) => {
  const session = await pair(browser, 'relay');
  const { host, guest } = session;

  try {
    await host.page.getByRole('button', { name: /end session/i }).click();

    // The joiner leaves the session link on its own. Before the end-session
    // frame existed this was indistinguishable from the host's tab crashing,
    // so the guest sat on "The other device disconnected" with a QR offering
    // to rejoin a room that had gone with the host.
    await expect(guest.page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(guest.page.getByRole('button', { name: /start transfer/i }).first()).toBeVisible();
    await expect(guest.page.getByText(/the other device disconnected/i)).toBeHidden();
  } finally {
    await closePair(session);
  }
});
