import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePair, confirmVerification, makeFixture, pair } from './helpers.js';

/*
 * This suite exists for two claims that unit and jsdom-component tests
 * cannot check, because neither claim is observable without a real layout
 * engine and a real address bar:
 *
 * 1. The filter is a URL round-trip. `TransferRecord` seeds its filter from
 *    `location.href` and writes it back with `history.replaceState`
 *    (client/routing.ts, `parseFilter`/`setFilterParam`). jsdom's `Location`
 *    exists, but the thing worth proving here is that a *reload* — a fresh
 *    page load parsing a URL Playwright didn't construct, the same path a
 *    scanned QR code takes — reads the filter back correctly, and that a
 *    reload of a session URL rejoins at all, which is invisible to any test
 *    that only inspects `URLSearchParams` in isolation.
 *
 * 2. The two-column session layout and the record's internal scroll are
 *    geometry: a CSS Grid breakpoint (`sm:grid-cols-2`) and a `max-height` +
 *    `overflow-y-auto` box. jsdom performs no layout at all — every
 *    `getBoundingClientRect()` it returns is a zero rect — so "two columns
 *    side by side above 640px, stacked below it" and "the record scrolls
 *    once its content exceeds its fixed height" are both unfalsifiable in a
 *    component test. A real Chromium actually lays the page out, so this is
 *    the only place either claim can be checked, not merely asserted.
 */

/** Bounding boxes for the two `TransferPanel` columns, Share and Transfers. */
async function columnBoxes(page: Page) {
  const columns = page.locator('[data-session-columns] > section');
  await expect(columns).toHaveCount(2);
  const [share, transfers] = await Promise.all([
    columns.nth(0).boundingBox(),
    columns.nth(1).boundingBox(),
  ]);
  if (!share || !transfers) throw new Error('column section has no box — not rendered or not visible');
  return { share, transfers };
}

test.describe('session layout', () => {
  test('a filter write survives a reload of a session URL', async ({ browser }) => {
    const session = await pair(browser, 'relay');
    try {
      // The guest is the peer whose URL is the share link (/s/CODE) — see
      // helpers.ts's `pair()` doc comment. The host's address bar stays on
      // /new, so reloading the host would start a brand-new session and
      // prove nothing about either claim below.
      const { guest } = session;

      // Scoped to the filter group, not matched by text alone: a completed
      // file's status badge renders the literal capitalized "Sent", and a
      // case-insensitive name match would be able to hit either the chip or
      // the badge. The group scope disambiguates structurally instead.
      const filters = guest.page.getByRole('group', { name: /filter transfers/i });
      await filters.getByRole('button', { name: 'sent' }).click();

      // `pair(browser, 'relay')` already put `?forceTransport=relay` on this
      // URL, so the filter is appended with `&`, not `?` — match either
      // separator rather than assuming this is the URL's only param.
      await expect(guest.page).toHaveURL(/[?&]filter=sent(?:&|#|$)/);

      // A reload re-mounts SessionScreen and rejoins from the URL exactly as
      // a scanned QR code would, so this also exercises that ?filter= does
      // not interfere with joining. It is a genuinely new pairing — a fresh
      // key agreement, so a fresh number for BOTH sides to confirm, which is
      // why the host is dragged back through the gate here too. That gate now
      // holds the whole workspace, the record and its filter chips included,
      // so there is nothing to read the filter off until both have passed it.
      await guest.page.reload();
      await expect(guest.page.getByText(/connected/i)).toBeVisible({ timeout: 20_000 });
      await confirmVerification(session.host.page, guest.page);

      // The point of the test: the chip comes back pressed from the URL
      // alone, on a component that has just mounted for the first time in
      // this page's life.
      await expect(filters.getByRole('button', { name: 'sent' })).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await closePair(session);
    }
  });

  /*
   * Three claims that only a real browser can settle, all of them about the
   * session header.
   *
   * The transport explanation is a native [popover]: jsdom hides a closed
   * one but does not implement invoker activation, so "clicking the chip
   * opens it" is unfalsifiable in a component test (see the wiring-only
   * assertion in tests/ui/transport-badge.test.tsx). Escape closing it is
   * likewise the browser's own behaviour, and worth pinning because the
   * whole reason for using [popover] over component state was to get it.
   *
   * And the Share buttons sitting on ONE row is geometry: they wrapped in
   * production because the creator's shell was 340px wide against 345px of
   * buttons, which no zero-rect jsdom layout could have caught.
   */
  test('the transport note opens from the chip and closes on Escape, and the Share buttons stay on one row', async ({ browser }) => {
    const session = await pair(browser, 'relay');
    const { host } = session;

    try {
      await host.page.setViewportSize({ width: 1440, height: 900 });

      const note = host.page.getByRole('note');
      await expect(note).toBeHidden();

      // The chip's accessible name is "<Direct|Relayed> connection: what this
      // means" (client/ui/TransportBadge.tsx). This regex used to spell that
      // colon as an em-dash and so matched nothing, failing the test on every
      // run rather than on any real defect.
      await host.page.getByRole('button', { name: /connection: what this means/i }).click();
      await expect(note).toBeVisible();
      await expect(note).toContainText(/encrypted/i);

      await host.page.keyboard.press('Escape');
      await expect(note).toBeHidden();

      // One row: same top, and the second starts to the right of the first.
      // Measured rather than asserted from the class list — `flex-wrap` is
      // still on the container by design (below ~380px they genuinely must
      // wrap), so only the geometry can say whether they fit.
      const camera = await host.page.getByRole('button', { name: /share camera/i }).boundingBox();
      const screenShare = await host.page.getByRole('button', { name: /share screen/i }).boundingBox();
      if (!camera || !screenShare) throw new Error('a Share button has no box');

      expect(screenShare.y).toBeCloseTo(camera.y, 0);
      expect(screenShare.x).toBeGreaterThan(camera.x + camera.width - 1);
    } finally {
      await closePair(session);
    }
  });

  test('the session screen is two columns above the sm breakpoint and one below it, and the record scrolls once dense', async ({ browser }) => {
    const session = await pair(browser, 'relay');
    const { host, guest } = session;

    try {
      // Populate the record with a handful of files and notes in both
      // directions. The record's non-virtualized branch (below
      // VIRTUALIZE_ABOVE, 50 items) renders each row at its natural CSS
      // height rather than TransferRecord's fixed virtualizer estimates, so
      // there is no formula for "how many rows overflow 22rem/352px" short
      // of measuring — 3 files plus 5 notes comfortably clears it in
      // practice (asserted below, not assumed).
      const fixtures = [makeFixture(16 * 1024), makeFixture(16 * 1024), makeFixture(16 * 1024)];

      for (const fixture of fixtures) {
        const downloadPromise = guest.page.waitForEvent('download', { timeout: 20_000 });
        await host.page.getByRole('button', { name: /choose files/i }).click();
        await host.page.locator('input[type="file"]').setInputFiles(fixture.path);
        await downloadPromise;
      }
      // Exact match: the filter chips render the literal lowercase text
      // "sent" (capitalized only by CSS), which a case-insensitive "Sent"
      // would also match — see the case note on the filter test above.
      await expect(host.page.getByText('Sent', { exact: true }).first()).toBeVisible();

      const notes: Array<{ from: Page; to: Page; text: string }> = [
        { from: guest.page, to: host.page, text: 'first note from the guest' },
        { from: guest.page, to: host.page, text: 'second note from the guest' },
        { from: host.page, to: guest.page, text: 'a reply note from the host' },
        { from: guest.page, to: host.page, text: 'third note from the guest' },
        { from: host.page, to: guest.page, text: 'a second reply from the host' },
      ];
      for (const note of notes) {
        const box = note.from.getByRole('textbox', { name: /text to send/i });
        await box.fill(note.text);
        await box.press('ControlOrMeta+Enter');
        await expect(note.to.getByText(note.text)).toBeVisible({ timeout: 15_000 });
      }

      // --- Desktop width: two columns side by side. ---
      await host.page.setViewportSize({ width: 900, height: 900 });
      const desktop = await columnBoxes(host.page);
      // Same row: tops line up (both start right under the shared heading
      // row), not stacked on top of one another.
      expect(Math.abs(desktop.share.y - desktop.transfers.y)).toBeLessThan(8);
      // Side by side: Share's right edge sits at or left of where Transfers
      // begins — a real, non-overlapping gap, not a coincidence of rounding.
      expect(desktop.share.x + desktop.share.width).toBeLessThanOrEqual(desktop.transfers.x + 1);

      // The record scrolls internally rather than growing the page: its own
      // content is taller than its box, and the box itself is capped near
      // 22rem (352px at the default root font size).
      const recordBox = host.page.locator('.overflow-y-auto');
      await expect(recordBox).toBeVisible();
      const { clientHeight, scrollHeight } = await recordBox.evaluate((el) => (
        { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }
      ));
      expect(clientHeight).toBeLessThanOrEqual(360);
      expect(scrollHeight).toBeGreaterThan(clientHeight);

      // --- Mobile width: one column, Transfers stacked ABOVE Share. ---
      await host.page.setViewportSize({ width: 412, height: 900 });
      const mobile = await columnBoxes(host.page);
      // Stacked, and in the reverse of DOM order: `order-first` on Transfers
      // puts the record above the Share stack, so what arrived is visible
      // without scrolling past the whole send column. columnBoxes still
      // names them by DOM position, which is why this reads share-below.
      expect(mobile.share.y).toBeGreaterThanOrEqual(mobile.transfers.y + mobile.transfers.height - 1);
      // Same column: left edges line up.
      expect(Math.abs(mobile.share.x - mobile.transfers.x)).toBeLessThan(2);
    } finally {
      await closePair(session);
    }
  });
  /*
   * The one long filename that used to scroll the whole page sideways.
   *
   * `truncate` on the name means `white-space: nowrap`, so that paragraph's
   * MIN-CONTENT width is the entire string — `overflow: hidden` caps what is
   * painted, never what is measured. A grid item defaults to
   * `min-width: auto`, which is min-content, so the column refused to shrink
   * below the name and both sections overflowed the grid: measured at 390px
   * wide, `document.documentElement.scrollWidth` was 710. Only a real layout
   * engine can see that, which is why it belongs in this suite and not in a
   * jsdom component test.
   */
  test('a long filename never widens the session columns past the viewport', async ({ browser }) => {
    const name = 'quarterly-report-final-v3-approved-by-everyone-2026-08-28-really-long-name.bin';
    const path = join(mkdtempSync(join(tmpdir(), 'quik-e2e-long-')), name);
    writeFileSync(path, Buffer.alloc(4096, 7));

    const session = await pair(browser, 'relay');
    try {
      const { host, guest } = session;
      await guest.page.setViewportSize({ width: 390, height: 844 });

      const downloaded = guest.page.waitForEvent('download');
      await host.page.getByRole('button', { name: /choose files/i }).click();
      await host.page.locator('input[type="file"]').setInputFiles(path);
      await downloaded;
      await expect(guest.page.locator('[data-file-row]').first()).toBeVisible({ timeout: 15_000 });

      // The page itself does not scroll sideways.
      const { scrollWidth, clientWidth } = await guest.page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      // And neither column grew past the grid that holds them, which is the
      // measurement that actually distinguishes "fits" from "overflows but
      // the body happens to clip it".
      const gridWidth = (await guest.page.locator('[data-session-columns]').boundingBox())?.width ?? 0;
      expect(gridWidth).toBeGreaterThan(0);
      const { share, transfers } = await columnBoxes(guest.page);
      expect(share.width).toBeLessThanOrEqual(gridWidth + 1);
      expect(transfers.width).toBeLessThanOrEqual(gridWidth + 1);
    } finally {
      await closePair(session);
    }
  });
});
