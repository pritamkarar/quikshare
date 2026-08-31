import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  closePair, findSmallTapTargets, focusIsUnobscured, makeFixture, pair, tabUntil, walkFocusRingVisibility,
  walkFocusUnobscured,
} from './helpers.js';

/*
 * Plan 2 deferred four checks to this suite because jsdom does no layout or
 * paint: it cannot compute a real `:focus-visible` outline, cannot answer
 * `elementFromPoint`, cannot open a native file chooser, and cannot lay out a
 * mobile viewport. Each of the four is its own test (or pair of tests) below,
 * named after the gap it closes.
 */

/** A paired transfer screen with a completed file and a received text on the host's side, for a rich, representative set of controls to walk. */
async function richHostScreen(browser: Browser) {
  const fixture = makeFixture(64 * 1024);
  const session = await pair(browser, 'relay');
  const { host, guest } = session;

  const downloadPromise = guest.page.waitForEvent('download');
  await host.page.getByRole('button', { name: /choose files/i }).click();
  await host.page.locator('input[type="file"]').setInputFiles(fixture.path);
  await downloadPromise;
  // Exact, case-sensitive match: the record's filter chips (client/ui/
  // TransferRecord.tsx) render the literal lowercase text "sent", styled
  // capitalized by CSS only, so a case-insensitive "Sent" now matches both
  // the chip and this completed-file badge. Only the badge is exactly "Sent".
  await expect(host.page.getByText('Sent', { exact: true })).toBeVisible();

  await guest.page.getByRole('textbox', { name: /text to send/i }).fill('for the host to copy');
  await guest.page.getByRole('textbox', { name: /text to send/i }).press('ControlOrMeta+Enter');
  // "note 2", not "text 1": TransferRecord.tsx's NoteRow numbers copy
  // buttons by `seq`, the ordinal shared across the whole record (files and
  // notes together), not by a per-kind index into a standalone text list —
  // the file sent above is seq 1, so this received note is seq 2.
  await expect(host.page.getByRole('button', { name: /copy received note 2/i })).toBeVisible();

  return session;
}

test.describe('gap 1: focus-ring visibility', () => {
  test('every keyboard-focusable control on a live transfer screen has a real, visible focus ring', async ({ browser }) => {
    const session = await richHostScreen(browser);
    try {
      const failures = await walkFocusRingVisibility(session.host.page);
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    } finally {
      await closePair(session);
    }
  });

  test('the outline check is not vacuous: it catches a real missing focus ring', async ({ page }) => {
    await page.goto('/');
    // Same rule app.css relies on globally, killed — proves the checker
    // above would fail loudly if this rule ever regressed or got overridden.
    await page.addStyleTag({ content: ':focus-visible { outline: none !important; }' });
    const failures = await walkFocusRingVisibility(page, 5);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]!.reason).toMatch(/outline/);
  });
});

test.describe('gap 2: sticky-overlap', () => {
  test('no focused control on a live transfer screen is ever hidden behind another element', async ({ browser }) => {
    const session = await richHostScreen(browser);
    try {
      const failures = await walkFocusUnobscured(session.host.page);
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    } finally {
      await closePair(session);
    }
  });

  test('the overlap check is not vacuous: it catches a real sticky/fixed element covering focus', async ({ page }) => {
    await page.goto('/');
    // The app ships nothing sticky or fixed today, so this proves the
    // detection mechanism itself is discriminating — not just quiet because
    // there is nothing for it to find — by injecting the exact class of bug
    // AGENTS.md's "sticky/fixed elements never cover focus" rule guards
    // against, and confirming elementFromPoint-based detection catches it.
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.id = 'e2e-fake-sticky-overlay';
      Object.assign(overlay.style, {
        position: 'fixed', inset: '0', zIndex: '999999', background: 'transparent',
      });
      document.body.append(overlay);
    });
    const failures = await walkFocusUnobscured(page, 5);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]!.reason).toMatch(/covered/);
  });

  test('a control straddling the bottom of the viewport is not reported as covered', async ({ page }) => {
    /*
     * The false positive this suite has now been bitten by twice.
     *
     * Focusing a control does not oblige the browser to scroll all of it into
     * view — Chrome brings the nearest edge in and stops — so a tall control
     * whose top is already visible sits half below the fold with the page
     * never scrolling. Its box centre is then outside the viewport, where
     * elementFromPoint answers null, while nothing covers the control at all.
     *
     * Built here rather than waited for on a real screen, because whether the
     * app happens to lay a control across the fold depends on viewport,
     * content and scroll position — the first fix for this was aimed at the
     * note composer, which has since moved. The geometry is the bug, so the
     * geometry is what this pins.
     *
     * `focusIsUnobscured` directly, not through `walkFocusUnobscured`: the
     * walk presses Tab before it measures, which would move focus off the
     * control built below and quietly measure something else. An earlier
     * draft of this test did exactly that and passed against the very bug it
     * was written to catch.
     */
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto('/');
    await page.evaluate(() => {
      const el = document.createElement('button');
      el.id = 'e2e-straddler';
      el.textContent = 'half below the fold';
      // Top edge inside the viewport, bottom edge well outside it, so the box
      // centre lands past the fold while the control stays plainly visible.
      Object.assign(el.style, {
        position: 'fixed', left: '0', top: '560px', width: '200px', height: '200px', zIndex: '1',
      });
      document.body.append(el);
      el.focus();
    });

    expect(await focusIsUnobscured(page)).toBe(true);
  });
});

test.describe('gap 3: a real keyboard walkthrough', () => {
  test('completes a transfer using only the keyboard: file chooser, queue, text box, ⌘/Ctrl+Enter, Copy', async ({ browser }) => {
    const fixture = makeFixture(64 * 1024);
    const session = await pair(browser, 'relay');
    const { host, guest } = session;

    try {
      // Registered before the file is even chosen: a 64 KB transfer over the
      // relay can complete within a second, well before the keyboard has
      // finished typing the note below — waiting for this event only after
      // that would race a download that already happened.
      const downloadPromise = guest.page.waitForEvent('download', { timeout: 20_000 });

      // --- Sender side (host): reach the file chooser and select a file,
      // entirely by tabbing from a neutral starting point (no .click(), no
      // .focus() — only real Tab keystrokes and Enter). ---
      await host.page.bringToFront();
      // Registered BEFORE the tabbing, and the order is the whole fix.
      //
      // Playwright only turns on Chromium's file-chooser interception when a
      // `filechooser` listener is attached, and it sends that CDP command
      // fire-and-forget — there is no promise to await. Registered on the line
      // directly above `keyboard.press('Enter')`, as this used to be, nothing
      // guarantees the command has been processed before the keystroke lands:
      // the input's click then opens a real dialog Playwright never sees, and
      // the wait hangs. That is a race, so it failed roughly one run in five.
      //
      // Hoisting it above `tabUntil` fixes it causally rather than by waiting:
      // commands are serialised over one connection, so every Tab press and
      // every `evaluate` in `tabUntil` is a round-trip that cannot be
      // processed before the interception command ahead of it. No sleep, and
      // no dependence on how loaded the machine happens to be.
      //
      // A separate, deliberate change: this wait carries an explicit timeout.
      // Without one it inherited the test timeout, so the `download` wait
      // registered further up — which has an explicit 20s — always expired
      // first and reported ITSELF as the failure. That masking sent three
      // separate investigations after the wrong component; a wait that fails
      // where it actually broke is worth the extra argument.
      const fileChooserPromise = host.page.waitForEvent('filechooser', { timeout: 15_000 });
      await tabUntil(host.page, (i) => i.tag === 'button' && /choose files/i.test(i.name));
      await host.page.keyboard.press('Enter');
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(fixture.path);

      // --- Reach the text box, right after "Choose files" inside the same
      // Share column (DropZone carries no queue of its own any more — a
      // sending file's progress lives in TransferRecord, in the other
      // column, not here), and send with the required modifier combo, never
      // plain Enter. ---
      await tabUntil(host.page, (i) => i.tag === 'textarea' && /text to send/i.test(i.name));
      await host.page.keyboard.type('sent by keyboard alone');
      await host.page.keyboard.press('ControlOrMeta+Enter');

      // --- Receiver side (guest): the file lands as a real download without
      // any click at all (see transfer.spec.ts's comment on why), and the
      // text arrives; move through the record's filter chips by keyboard to
      // confirm tabbing reaches past them, then reach Copy and activate it
      // with the keyboard. ---
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe('fixture.bin');
      await expect(guest.page.getByText('sent by keyboard alone')).toBeVisible({ timeout: 15_000 });

      // `pair()` already grants both contexts clipboard-read/write, which
      // this readText() below depends on. Chromium's Clipboard API also
      // requires the document to actually be focused — with two pages open
      // in one test, that means bringing this one to the front first.
      // "Copy received note 2" is fixed on purpose (see TransferRecord.tsx's
      // NoteRow: `seq` is the ordinal shared across the whole record, and
      // the file sent above claimed seq 1) so the accessible name never
      // shifts mid-interaction — which means the "Copied" confirmation is a
      // visible-text change, not an accessible-name one, and has to be
      // asserted as such.
      await guest.page.bringToFront();
      const copyButton = guest.page.getByRole('button', { name: /copy received note 2/i });
      await tabUntil(guest.page, (i) => i.tag === 'button' && /copy received note 2/i.test(i.name));
      await guest.page.keyboard.press('Enter');
      await expect(copyButton).toHaveText(/^copied$/i);
      const clipboard = await guest.page.evaluate(() => navigator.clipboard.readText());
      expect(clipboard).toBe('sent by keyboard alone');
    } finally {
      await closePair(session);
    }
  });
});

test.describe('gap 4: real tap-target sizes', () => {
  const DESKTOP_FLOOR = 24;
  const MOBILE_FLOOR = 44;

  async function assertFloor(page: Page, minPx: number): Promise<void> {
    const failures = await findSmallTapTargets(page, minPx);
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  }

  test('landing screen meets the tap-target floor at desktop and mobile widths', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    // `.first()`, because the landing page offers the same two calls to
    // action twice — once in the hero and once in the closing band — so an
    // unscoped locator is a strict-mode violation rather than a wait. It
    // failed as one, which meant the floor below had never actually been
    // measured on this screen. Only a readiness signal: the assertion that
    // follows walks every control on the page regardless.
    await expect(page.getByRole('button', { name: /start a session/i }).first()).toBeVisible();
    await assertFloor(page, DESKTOP_FLOOR);

    await page.setViewportSize({ width: 390, height: 844 });
    await assertFloor(page, MOBILE_FLOOR);
  });

  test('create screen meets the tap-target floor at desktop and mobile widths', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/new');
    await expect(page.getByRole('button', { name: /copy link/i })).toBeVisible();
    await assertFloor(page, DESKTOP_FLOOR);

    await page.setViewportSize({ width: 390, height: 844 });
    await assertFloor(page, MOBILE_FLOOR);
  });

  test('join screen meets the tap-target floor at desktop and mobile widths', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/join');
    await assertFloor(page, DESKTOP_FLOOR);

    await page.setViewportSize({ width: 390, height: 844 });
    await assertFloor(page, MOBILE_FLOOR);
  });

  test('invalid-code screen meets the tap-target floor at desktop and mobile widths', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/s/AB');
    await expect(page.getByRole('button', { name: /start a new session/i })).toBeVisible();
    await assertFloor(page, DESKTOP_FLOOR);

    await page.setViewportSize({ width: 390, height: 844 });
    await assertFloor(page, MOBILE_FLOOR);
  });

  test('a live transfer screen meets the tap-target floor at desktop and mobile widths', async ({ browser }) => {
    const session = await richHostScreen(browser);
    try {
      await session.host.page.setViewportSize({ width: 1280, height: 800 });
      await assertFloor(session.host.page, DESKTOP_FLOOR);

      await session.host.page.setViewportSize({ width: 390, height: 844 });
      await assertFloor(session.host.page, MOBILE_FLOOR);
    } finally {
      await closePair(session);
    }
  });
});
