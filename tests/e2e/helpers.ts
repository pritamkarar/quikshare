import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A deterministic, non-repeating byte fixture — never accidentally all-zero. */
export function makeFixture(size: number): { path: string; bytes: Buffer } {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31) % 256;
  const path = join(mkdtempSync(join(tmpdir(), 'quik-e2e-')), 'fixture.bin');
  writeFileSync(path, bytes);
  return { path, bytes };
}

export interface Peer {
  context: BrowserContext;
  page: Page;
}

export interface PairResult {
  host: Peer;
  guest: Peer;
}

/**
 * Pairs a fresh host (creator) and guest (joiner) against the running app,
 * including the verification step both users have to complete before the
 * session will move a single byte (client/ui/VerifyPanel.tsx).
 *
 * The link is recovered through the "Copy link" button and the clipboard
 * rather than read off `location`, because that is what a real user does and
 * because CreateScreen stays on `/new` rather than navigating to the share
 * URL. That requires the host context to hold clipboard permissions.
 *
 * `extraPermissions` defaults to none, so every existing caller is
 * unaffected — tests/e2e/live-media.spec.ts is the one caller that passes
 * `['camera', 'microphone']`, granted up front (rather than relying on
 * Chromium's fake-UI launch flag alone) because that flag auto-accepts the
 * *prompt*, not the underlying Permissions API grant a headless context
 * otherwise still has to resolve.
 */
export async function pair(browser: Browser, forceTransport?: 'relay', extraPermissions: string[] = []): Promise<PairResult> {
  const qs = forceTransport ? `?forceTransport=${forceTransport}` : '';
  const permissions = ['clipboard-read', 'clipboard-write', ...extraPermissions];

  const hostContext = await browser.newContext({ permissions });
  const guestContext = await browser.newContext({ permissions });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  // '/new', not '/': the root is the landing page and deliberately starts no
  // session — see client/screens/LandingScreen.tsx.
  await host.goto(`/new${qs}`);
  await host.getByRole('button', { name: /copy link/i }).click();
  const shareUrl = await host.evaluate(() => navigator.clipboard.readText());
  const sharePath = shareUrl.replace(/^https?:\/\/[^/]+/, '');

  await guest.goto(`${sharePath}${qs}`);

  await expect(host.getByText(/connected/i)).toBeVisible({ timeout: 20_000 });
  await expect(guest.getByText(/connected/i)).toBeVisible({ timeout: 20_000 });

  await confirmVerification(host, guest);

  return { host: { context: hostContext, page: host }, guest: { context: guestContext, page: guest } };
}

/**
 * Takes both screens through the verification gate, and checks the two
 * numbers agree on the way through rather than just clicking past them: two
 * devices that agreed a key with each other, rather than with something in
 * the middle, are the only two that can reach the same six digits.
 *
 * Its own exported step because `pair()` is not the only place that needs
 * it. A reload re-agrees the key, which clears both confirmations
 * (useSession's 'verification' case), and the whole workspace — Share and
 * Transfers — is behind this gate now
 * (client/screens/TransferPanel.tsx), so any test that reloads and then
 * expects to see the session again has to come back through here.
 */
export async function confirmVerification(host: Page, guest: Page): Promise<void> {
  const digitsOf = async (page: Page): Promise<string> => (
    (await page.getByTestId('verification-number').innerText()).replace(/\s/g, '')
  );
  await expect(host.getByTestId('verification-number')).toBeVisible({ timeout: 20_000 });
  await expect(guest.getByTestId('verification-number')).toBeVisible({ timeout: 20_000 });
  expect(await digitsOf(host)).toBe(await digitsOf(guest));

  await host.getByRole('button', { name: /numbers match/i }).click();
  await guest.getByRole('button', { name: /numbers match/i }).click();

  // Gone from both screens once both have confirmed, which is also how the
  // send controls appear.
  await expect(host.getByTestId('verification-number')).toBeHidden({ timeout: 20_000 });
  await expect(guest.getByTestId('verification-number')).toBeHidden({ timeout: 20_000 });
}

export async function closePair(result: PairResult): Promise<void> {
  await result.host.context.close();
  await result.guest.context.close();
}

/** A stable-enough fingerprint of the focused element to detect a repeated tab cycle. */
async function focusKey(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return '';
    return [
      el.tagName,
      el.getAttribute('aria-label') ?? '',
      (el.textContent ?? '').trim().slice(0, 60),
      el.getAttribute('href') ?? '',
    ].join('|');
  });
}

/**
 * Presses Tab, one keystroke at a time — a real key event, not `element.focus()`
 * — until `isMatch` accepts the newly focused element, or gives up. This is
 * deliberately slow and literal: the point of a "keyboard walkthrough" is to
 * prove the real tab order reaches a control, not to jump there.
 */
export async function tabUntil(
  page: Page,
  isMatch: (info: { tag: string; role: string; name: string }) => boolean,
  max = 40,
): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return { tag: '', role: '', name: '' };
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? '',
        name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
      };
    });
    if (isMatch(info)) return;
  }
  throw new Error(`tabUntil: no matching element found within ${max} Tab presses`);
}

export interface FocusFailure {
  label: string;
  reason: string;
}

async function describeFocused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return '(nothing focused)';
    const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
    return `${el.tagName.toLowerCase()} "${name}"`;
  });
}

/**
 * AGENTS.md: "Visible, unobscured focus rings (:focus-visible ...)". Checked
 * against the real computed style, which only a real browser produces —
 * jsdom has no `:focus-visible` matching heuristics at all.
 */
async function outlineIsVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const style = getComputedStyle(el);
    const width = parseFloat(style.outlineWidth);
    return style.outlineStyle !== 'none'
      && Number.isFinite(width) && width > 0
      && style.outlineColor !== 'transparent'
      && !/rgba?\([^)]*,\s*0\s*\)$/.test(style.outlineColor);
  });
}

/**
 * AGENTS.md: "sticky/fixed elements never cover focus". `elementFromPoint`
 * at the focused element's own center is the real-paint check jsdom cannot
 * perform: it returns whatever is actually topmost after layout, so a sticky
 * header or a toast painted on top is caught exactly as a user would hit it.
 */
export async function focusIsUnobscured(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    /*
     * The centre of the part of the control that is actually ON SCREEN — not
     * the centre of its box.
     *
     * Focusing a control does not oblige the browser to scroll the whole of
     * it into view. Chrome brings the nearest edge in and stops, so a tall
     * control whose top edge is already visible keeps straddling the viewport
     * edge and the page never scrolls at all. Its box centre is then outside
     * the viewport, `elementFromPoint` answers null for any point out there,
     * and a control nothing covers is reported as covered.
     *
     * Measured on the note composer at 1280x720: rect top 673, height 100, so
     * a box centre of 723 against a 720px viewport — three pixels out. 47px
     * of the control visible, the page scrollable, scrollY 0, and nothing
     * whatsoever on top of it.
     *
     * This is the second time this class of false positive has been fixed
     * here. The first fix (waiting two frames for the browser to scroll)
     * treated the symptom: the browser is under no obligation to scroll at
     * all, so waiting longer cannot help. Sampling the visible portion also
     * makes the check what it claims to be — the point a user could actually
     * hit is inside the viewport by definition.
     *
     * Exported so it can be tested on geometry directly: `walkFocusUnobscured`
     * presses Tab before it measures, so a test that builds a straddling
     * control and focuses it would have focus moved off it before this ran.
     */
    const left = Math.max(rect.left, 0);
    const top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, innerWidth);
    const bottom = Math.min(rect.bottom, innerHeight);
    // None of it on screen is a different fault from being covered, but it is
    // still one, and the walk has a single reason string to report under.
    if (right <= left || bottom <= top) return false;

    const topmost = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return topmost !== null && (topmost === el || el.contains(topmost) || topmost.contains(el));
  });
}

/**
 * Tabs through every reachable control on the current page (stopping once the
 * tab order repeats or runs out), applying `check` to each and collecting
 * whatever it flags. Shared by the focus-ring and sticky-overlap suites so
 * both walk the same real tab order instead of two hand-picked lists that can
 * drift from each other and from the app.
 */
export async function walkFocusables(
  page: Page,
  check: (page: Page) => Promise<boolean>,
  reason: string,
  max = 60,
): Promise<FocusFailure[]> {
  const failures: FocusFailure[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    // Two frames, because focusing a control off the bottom of the viewport
    // scrolls it into view a frame LATER than the focus itself. Without this
    // wait, `focusIsUnobscured` measures the pre-scroll layout: a control
    // whose box straddles the viewport edge has its own centre outside the
    // viewport, `elementFromPoint` returns null there, and the walk reports a
    // control the user can see perfectly well as covered. Caught on the note
    // composer, which sat 3px past a 720px viewport at one particular scroll
    // position — i.e. the bug was a scroll offset away from firing on any of
    // these controls, and had nothing to do with the one it named.
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const key = await focusKey(page);
    if (key === '') break;
    if (seen.has(key)) break;
    seen.add(key);
    if (!(await check(page))) {
      failures.push({ label: await describeFocused(page), reason });
    }
  }
  return failures;
}

export async function walkFocusRingVisibility(page: Page, max = 60): Promise<FocusFailure[]> {
  return walkFocusables(page, outlineIsVisible, 'no visible :focus-visible outline', max);
}

export async function walkFocusUnobscured(page: Page, max = 60): Promise<FocusFailure[]> {
  return walkFocusables(page, focusIsUnobscured, 'covered by another element at its own center point', max);
}

export interface TapTargetFailure {
  label: string;
  width: number;
  height: number;
}

/**
 * AGENTS.md: "Hit target >=24px (mobile >=44px)". Reads real
 * `getBoundingClientRect()` boxes after layout — a Tailwind class string
 * (e.g. `min-h-11`) says nothing about the box a browser actually paints once
 * padding, borders, and content are all resolved, which is exactly why Plan
 * 2's static class-string check was a poor substitute and axe has no
 * tap-target rule at all.
 */
export async function findSmallTapTargets(page: Page, minPx: number): Promise<TapTargetFailure[]> {
  return page.evaluate((min) => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [role="button"]'),
    );
    const failures: TapTargetFailure[] = [];
    for (const el of nodes) {
      if (el.getAttribute('aria-hidden') === 'true') continue;
      if (el.tabIndex < 0) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      // A visually-hidden-until-focused control (the "sr-only
      // focus:not-sr-only" skip link) rests at a clipped 1x1px box by
      // design — it is not a pointer target at all until keyboard focus
      // reveals it at full size, which the focus-ring/sticky-overlap walks
      // already verify. A real tap target, even a small icon button, is
      // still visually present as more than a 1px clip box.
      if (rect.width <= 1 && rect.height <= 1) continue;
      // Rounded to a hundredth of a pixel before comparing. A control
      // declared `min-h-11` (44px) lays out at 43.99998474121094 whenever the
      // fractional width of its container divides that way — which the wide
      // session shell does. That is the layout engine's rounding, not a
      // 44px floor being missed, and comparing the raw float reports it as a
      // failure with no fix available in the component.
      const minDim = Math.round(Math.min(rect.width, rect.height) * 100) / 100;
      if (minDim < min) {
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
        failures.push({ label: `${el.tagName.toLowerCase()} "${name}"`, width: rect.width, height: rect.height });
      }
    }
    return failures;
  }, minPx);
}
