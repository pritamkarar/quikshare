/*
 * Builds the Quik Share product video, end to end:
 *
 *   1. drives two real browsers through a real session, recording both
 *   2. renders the opening/closing cards and the caption chrome
 *   3. assembles the lot with ffmpeg
 *
 * The middle of this video is not a mockup. It is the app in
 * dist/, paired over the real relay, agreeing a real key, moving a real file
 * — the same flow tests/e2e/transfer.spec.ts asserts on, slowed to a pace a
 * human can read. Which is the point: a demo that can go stale silently is
 * worth less than one that fails loudly when the product changes.
 *
 * Usage:  node scripts/video/make-video.mjs [--keep]
 * Output: scripts/video/out/quikshare.mp4
 */

import { chromium } from '@playwright/test';
import { execFile as execFileCb } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'out');
const WORK = join(OUT, 'work');
const BASE_URL = process.env.QUIK_VIDEO_URL ?? 'http://127.0.0.1:8787';
const KEEP = process.argv.includes('--keep');

/*
 * The one place frame geometry is defined. scenes.html is handed this and
 * cuts its windows from it, ffmpeg is handed this and places the panes with
 * it — so the holes in the chrome cannot drift from the video underneath.
 *
 * 860x900 is not arbitrary: it is the narrowest viewport at which
 * TransferPanel still lays Share and Transfers out side by side, so a single
 * pane shows the whole workspace without a scroll. Two of them plus the
 * gutters come to exactly 1920.
 */
const GEO = {
  paneW: 860, paneH: 900,
  leftX: 80, rightX: 980,
  paneY: 48,
  radius: 20,
};
const FPS = 30;
const HOOK_MS = 5500;
const OUTRO_MS = 7000;

const log = (...a) => console.log('•', ...a);

/* ---------------------------------------------------------------- capture */

/**
 * A visible pointer. Headless Chromium paints no cursor into the recording,
 * so without this every click in the video happens to nobody: controls just
 * change state on their own and the footage reads as a screen glitch rather
 * than as someone using the product.
 *
 * Injected with addInitScript so it survives the guest's navigation from the
 * landing page into the session. pointer-events stays none throughout — this
 * draws where Playwright is about to click, it never does the clicking.
 */
const CURSOR_SCRIPT = () => {
  const install = () => {
    if (document.getElementById('__vidcur')) return;
    const el = document.createElement('div');
    el.id = '__vidcur';
    el.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:26px', 'height:26px',
      'z-index:2147483647', 'pointer-events:none',
      'transition:transform 600ms cubic-bezier(.3,.7,.2,1)',
      'transform:translate(-100px,-100px)',
      'will-change:transform',
    ].join(';');
    el.innerHTML = `
      <svg viewBox="0 0 24 24" width="26" height="26">
        <path d="M4 2 L4 19 L9 14.5 L12.2 21.5 L15.4 20 L12.2 13.2 L18.6 13 Z"
              fill="#1c1a17" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
      </svg>
      <div id="__vidcur_p" style="position:absolute;left:-9px;top:-9px;width:44px;height:44px;
           border-radius:50%;background:rgba(43,80,226,.35);opacity:0;transform:scale(.4)"></div>`;
    document.documentElement.appendChild(el);

    window.__cursor = {
      moveTo(x, y, ms) {
        el.style.transitionDuration = `${ms}ms`;
        el.style.transform = `translate(${x}px, ${y}px)`;
      },
      pulse() {
        const p = document.getElementById('__vidcur_p');
        p.animate(
          [{ opacity: 0.9, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(1.25)' }],
          { duration: 480, easing: 'cubic-bezier(.2,.7,.3,1)' },
        );
      },
    };
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
};

async function moveTo(page, x, y, ms = 600) {
  await page.evaluate(([px, py, pms]) => window.__cursor?.moveTo(px, py, pms), [x, y, ms]);
}

/** Walks the pointer to a control, pulses on it, then actually clicks it. */
async function clickLike(page, locator, { settle = 260 } = {}) {
  const box = await locator.boundingBox();
  if (box) {
    await moveTo(page, box.x + box.width / 2, box.y + box.height / 2, 620);
    await page.waitForTimeout(700);
    await page.evaluate(() => window.__cursor?.pulse());
    await page.waitForTimeout(160);
  }
  await locator.click();
  await page.waitForTimeout(settle);
}

/**
 * A file worth watching cross. Small enough to build in a second, large
 * enough that the progress bar is a shot rather than a single frame — on
 * loopback WebRTC a few megabytes are gone before the bar has drawn. Tune
 * this if the send segment runs long: it is the one knob that sets how much
 * of the video is spent watching a progress bar.
 */
function fixture() {
  const size = 128 * 1024 * 1024;
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) bytes[i] = (i * 31) % 256;
  const dir = join(WORK, 'fixture');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'holiday-photos.zip');
  writeFileSync(path, bytes);
  return path;
}

async function capture() {
  log('recording a real session…');
  const browser = await chromium.launch();
  const beats = [];
  const filePath = fixture();

  const ctxOpts = (dir) => ({
    viewport: { width: GEO.paneW, height: GEO.paneH },
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
    recordVideo: { dir, size: { width: GEO.paneW, height: GEO.paneH } },
    colorScheme: 'light',
  });

  const hostCtx = await browser.newContext(ctxOpts(join(WORK, 'vid-host')));
  const guestCtx = await browser.newContext(ctxOpts(join(WORK, 'vid-guest')));
  await hostCtx.addInitScript(CURSOR_SCRIPT);
  await guestCtx.addInitScript(CURSOR_SCRIPT);

  /*
   * Both pages are created back to back and each start is stamped, because
   * Playwright begins a recording at page creation — so these two stamps are
   * what lets the assembler line the panes up again later. The gap is a few
   * milliseconds; it is corrected rather than assumed away.
   */
  const host = await hostCtx.newPage();
  const hostT0 = Date.now();
  const guest = await guestCtx.newPage();
  const guestT0 = Date.now();

  const beat = (name) => { beats.push({ name, at: Date.now() }); log(`  beat: ${name}`); };

  // Both devices open the app. The host goes straight to a new session; the
  // guest sits on the landing page, which is what the second device actually
  // looks like before anyone has sent it anything.
  await Promise.all([host.goto(`${BASE_URL}/new`), guest.goto(`${BASE_URL}/`)]);
  await host.getByText(/scan to connect/i).waitFor({ timeout: 20_000 });
  await host.waitForTimeout(700);
  beat('open');
  await moveTo(host, GEO.paneW / 2, 340, 900);
  await host.waitForTimeout(4200);

  beat('code');
  await host.waitForTimeout(4000);

  // The link comes off the Copy button and the clipboard rather than off
  // location, for the same reason tests/e2e/helpers.ts does it: CreateScreen
  // stays on /new, so the share URL is not in the address bar to read.
  await clickLike(host, host.getByRole('button', { name: /copy link/i }));
  const shareUrl = await host.evaluate(() => navigator.clipboard.readText());
  const sharePath = shareUrl.replace(/^https?:\/\/[^/]+/, '');

  beat('join');
  await guest.goto(`${BASE_URL}${sharePath}`);
  await host.getByText(/connected/i).first().waitFor({ timeout: 20_000 });
  await guest.getByText(/connected/i).first().waitFor({ timeout: 20_000 });
  await host.waitForTimeout(2000);

  beat('verify');
  await host.getByTestId('verification-number').waitFor({ timeout: 20_000 });
  await guest.getByTestId('verification-number').waitFor({ timeout: 20_000 });
  // Recorded, not decorative: if these ever differ the video is showing a
  // broken security property and should not be published.
  const digits = async (p) => (await p.getByTestId('verification-number').innerText()).replace(/\s/g, '');
  const [hd, gd] = [await digits(host), await digits(guest)];
  if (hd !== gd) throw new Error(`verification numbers differ: ${hd} vs ${gd}`);
  await host.waitForTimeout(6000);

  beat('confirm');
  await Promise.all([
    clickLike(host, host.getByRole('button', { name: /numbers match/i })),
    clickLike(guest, guest.getByRole('button', { name: /numbers match/i })),
  ]);
  await host.getByTestId('verification-number').waitFor({ state: 'hidden', timeout: 20_000 });
  await guest.getByTestId('verification-number').waitFor({ state: 'hidden', timeout: 20_000 });
  await host.waitForTimeout(3400);

  beat('send');
  await clickLike(host, host.getByRole('button', { name: /choose files/i }), { settle: 0 });
  await host.locator('input[type="file"]').setInputFiles(filePath);
  // Progress appearing is the transfer actually moving, not merely accepted.
  await guest.getByRole('progressbar').first().waitFor({ timeout: 30_000 });

  /*
   * Completion is the receiver's progress bar going away, not Playwright's
   * `download` event: with the service-worker streaming save tier the
   * download fires when the stream OPENS (client/save/swstream.ts), which is
   * the start of the transfer. Cutting the "it landed" caption in on that
   * would caption the first byte as the last one.
   */
  await guest.getByRole('progressbar').waitFor({ state: 'hidden', timeout: 180_000 });
  beat('arrive');
  await host.waitForTimeout(5500);

  beat('note');
  const composer = guest.getByRole('textbox', { name: /text to send/i });
  await clickLike(guest, composer, { settle: 0 });
  await composer.pressSequentially('maps.app.goo.gl/venue-friday-8pm', { delay: 55 });
  await guest.waitForTimeout(500);
  await composer.press('ControlOrMeta+Enter');
  await host.getByText(/venue-friday-8pm/).first().waitFor({ timeout: 20_000 });
  await host.waitForTimeout(5200);

  beat('end');
  await Promise.all([hostCtx.close(), guestCtx.close()]);
  const hostVideo = await host.video().path();
  const guestVideo = await guest.video().path();
  await browser.close();

  const timeline = { hostT0, guestT0, beats, hostVideo, guestVideo };
  writeFileSync(join(WORK, 'timeline.json'), JSON.stringify(timeline, null, 2));
  return timeline;
}

/* ----------------------------------------------------------------- render */

const sceneUrl = (params) => {
  const u = pathToFileURL(join(HERE, 'scenes.html'));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.href;
};

async function withScenePage(fn) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  try {
    await fn(page);
  } finally {
    await browser.close();
  }
}

/** Frame-by-frame rather than a screen recording: the cards are mostly type,
 *  and a dropped frame in a screen recording shows up as smeared text. */
async function renderCard(page, scene, durationMs, dir) {
  mkdirSync(dir, { recursive: true });
  await page.goto(sceneUrl({ scene, geo: JSON.stringify(GEO) }));
  await page.waitForFunction(() => window.__ready === true);
  const frames = Math.round((durationMs / 1000) * FPS);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((ms) => window.seek(ms), (i / FPS) * 1000);
    await page.screenshot({ path: join(dir, `${String(i).padStart(4, '0')}.png`) });
  }
  log(`  rendered ${frames} frames of ${scene}`);
}

async function renderChrome(page, segments, dir) {
  mkdirSync(dir, { recursive: true });
  for (const [i, seg] of segments.entries()) {
    await page.goto(sceneUrl({
      scene: 'chrome',
      geo: JSON.stringify(GEO),
      title: seg.title,
      sub: seg.sub,
      // Honest labels. Both panes are the same headless Chromium on the same
      // Linux box, and the app says so on screen ("Linux", both sides) — so
      // calling them Laptop and Phone would be contradicted by the footage.
      left: 'Device A',
      right: 'Device B',
    }));
    await page.waitForFunction(() => window.__ready === true);
    await page.screenshot({ path: join(dir, `cap-${i}.png`), omitBackground: true });
  }
  log(`  rendered ${segments.length} caption frames`);
}

/* --------------------------------------------------------------- assemble */

const ff = async (args) => {
  try {
    await execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      maxBuffer: 1 << 26,
    });
  } catch (e) {
    throw new Error(`ffmpeg failed:\n${e.stderr ?? e.message}`);
  }
};

/**
 * One pane, normalised. Playwright writes variable-frame-rate WebM that only
 * encodes when something changed, so every downstream assumption about time
 * needs a constant frame rate first — and the per-pane `-ss` is the recording
 * offset from `capture()` being paid back.
 */
async function pane(src, skipSec, durSec, dst) {
  await ff([
    '-i', src,
    '-ss', skipSec.toFixed(3), '-t', durSec.toFixed(3),
    '-vf', `fps=${FPS},scale=${GEO.paneW}:${GEO.paneH}:flags=lanczos`,
    '-an', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    dst,
  ]);
}

async function assemble(timeline, segments) {
  const { hostT0, guestT0, beats } = timeline;
  const at = (name) => beats.find((b) => b.name === name).at;

  // The composite starts at the first beat and ends at the last, in absolute
  // time; each pane is then trimmed by its own distance from that instant.
  const startAbs = at('open') - 400;
  const endAbs = at('end');
  const durSec = (endAbs - startAbs) / 1000;

  log(`compositing ${durSec.toFixed(1)}s of footage…`);
  await pane(timeline.hostVideo, (startAbs - hostT0) / 1000, durSec, join(WORK, 'pane-host.mp4'));
  await pane(timeline.guestVideo, (startAbs - guestT0) / 1000, durSec, join(WORK, 'pane-guest.mp4'));

  // Caption i runs from its own beat until the next one begins, so the ranges
  // tile the footage exactly and precisely one overlay is enabled at any t.
  const ranges = segments.map((seg, i) => {
    const from = (at(seg.from) - startAbs) / 1000;
    const next = segments[i + 1];
    return { i, from: Math.max(0, from), to: next ? (at(next.from) - startAbs) / 1000 : durSec + 1 };
  });

  const inputs = [
    '-f', 'lavfi', '-i', `color=c=0xebe9e4:s=1920x1080:r=${FPS}:d=${durSec.toFixed(3)}`,
    '-i', join(WORK, 'pane-host.mp4'),
    '-i', join(WORK, 'pane-guest.mp4'),
    ...ranges.flatMap((r) => ['-i', join(WORK, 'chrome', `cap-${r.i}.png`)]),
  ];

  const chain = [
    `[0][1]overlay=${GEO.leftX}:${GEO.paneY}[a]`,
    `[a][2]overlay=${GEO.rightX}:${GEO.paneY}[b0]`,
    ...ranges.map((r, n) => (
      `[b${n}][${n + 3}]overlay=0:0:enable='between(t,${r.from.toFixed(3)},${r.to.toFixed(3)})'[b${n + 1}]`
    )),
  ];
  chain[chain.length - 1] = chain.at(-1).replace(/\[b\d+\]$/, '[v]');

  await ff([
    ...inputs,
    '-filter_complex', chain.join(';'),
    '-map', '[v]', '-t', durSec.toFixed(3),
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    join(WORK, 'body.mp4'),
  ]);

  const card = async (dir, dst) => ff([
    '-framerate', String(FPS), '-i', join(dir, '%04d.png'),
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    dst,
  ]);
  await card(join(WORK, 'hook'), join(WORK, 'hook.mp4'));
  await card(join(WORK, 'outro'), join(WORK, 'outro.mp4'));

  // Cross-dissolved rather than cut, because both cards and the footage share
  // the same porcelain ground: a hard cut between two near-identical
  // backgrounds reads as a glitch, a half-second dissolve reads as intent.
  const X = 0.5;
  const hookSec = HOOK_MS / 1000;
  const outroSec = OUTRO_MS / 1000;
  const final = join(OUT, 'quikshare.mp4');
  await ff([
    '-i', join(WORK, 'hook.mp4'),
    '-i', join(WORK, 'body.mp4'),
    '-i', join(WORK, 'outro.mp4'),
    '-filter_complex', [
      `[0][1]xfade=transition=fade:duration=${X}:offset=${(hookSec - X).toFixed(3)}[hb]`,
      `[hb][2]xfade=transition=fade:duration=${X}:offset=${(hookSec + durSec - 2 * X).toFixed(3)}[v]`,
    ].join(';'),
    '-map', '[v]',
    '-c:v', 'libx264', '-crf', '19', '-preset', 'slow', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-r', String(FPS),
    final,
  ]);
  return { final, total: hookSec + durSec + outroSec - 2 * X };
}

/* ------------------------------------------------------------------- main */

const SEGMENTS = [
  { from: 'open', title: 'Open it on *both devices*', sub: 'No account, no install, nothing to download.' },
  { from: 'code', title: 'One device *starts a session*', sub: 'A QR code and a six-character code. Use whichever is easier.' },
  { from: 'join', title: 'The other one *joins*', sub: 'Scan it, or open the link. They find each other in seconds.' },
  { from: 'verify', title: 'Both screens show the *same six digits*', sub: 'If they match, nothing is sitting in the middle.' },
  { from: 'confirm', title: 'Confirm on both — *only then* can anything move', sub: 'Sending stays switched off until you have each checked.' },
  { from: 'send', title: 'Drop in a file. It goes *straight across*.', sub: 'Directly between the two devices over WebRTC.' },
  { from: 'arrive', title: 'It lands on the other device', sub: 'Streamed to disk as it arrives — no size limit, no upload.' },
  { from: 'note', title: 'Links and notes too, *both directions*', sub: 'Paste on one, read it on the other.' },
];

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'server', 'index.js'))) {
    throw new Error('dist/ not built — run `npm run build` first.');
  }
  const res = await fetch(BASE_URL).catch(() => null);
  if (!res?.ok) throw new Error(`no app at ${BASE_URL} — start it with \`npm start\`.`);

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const timeline = await capture();

  log('rendering cards and captions…');
  await withScenePage(async (page) => {
    await renderCard(page, 'hook', HOOK_MS, join(WORK, 'hook'));
    await renderCard(page, 'outro', OUTRO_MS, join(WORK, 'outro'));
    await renderChrome(page, SEGMENTS, join(WORK, 'chrome'));
  });

  const { final, total } = await assemble(timeline, SEGMENTS);
  if (!KEEP) rmSync(join(WORK, 'fixture'), { recursive: true, force: true });
  log(`done — ${final} (${total.toFixed(1)}s)`);
}

await main();
