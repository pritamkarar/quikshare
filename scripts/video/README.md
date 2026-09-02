# Product video

Builds `out/quikshare.mp4` — a ~60s silent, captioned product video for
Product Hunt and social posts.

```sh
npm run build
npm start &                       # or any host: QUIK_VIDEO_URL=https://…
npm run video
```

## What it actually records

The middle of the video is not a mockup or a screen recording someone made
once. It is `dist/` running for real: two browser contexts pair over the
relay, agree a key, compare the six digits, and move an actual 64MB file
between them. It is the flow `tests/e2e/transfer.spec.ts` asserts on, paced
so a human can read it, and it reuses the same locators — so a rename that
breaks the suite breaks the video too, loudly, rather than leaving a demo
quietly showing a product that no longer exists.

Two contexts rather than two iframes because the device id lives in
`localStorage` (`client/device.ts`), and one origin means one device talking
to itself.

If the numbers on the two screens ever disagree, the capture throws instead of
publishing footage of a broken security property.

## The three pieces

| | |
|---|---|
| `scenes.html` | Opening card, closing card, and the chrome around the footage. Seekable — `seek(ms)` sets every animation's `currentTime`, so frames are rendered deterministically rather than screen-recorded. |
| `make-video.mjs` | Drives the capture, renders the cards frame by frame, assembles with ffmpeg. |
| `out/work/` | Intermediates. `timeline.json` holds every beat's real timestamp. |

Captions are not hand-timed. `capture()` stamps each beat as it happens and
`assemble()` derives the `enable='between(t,…)'` window for every caption from
those stamps, so re-recording re-times the captions on its own.

`GEO` in `make-video.mjs` is the single source of frame geometry: `scenes.html`
cuts its windows from it and ffmpeg places the panes with it, so the holes in
the chrome cannot drift from the video underneath.

## Requirements

`ffmpeg` on `PATH`, and Playwright's Chromium (`npx playwright install
chromium`). Roughly four minutes end to end.

## Editing it

- **Wording** — `SEGMENTS` in `make-video.mjs`. One `*starred phrase*` per
  caption takes the accent colour; two and neither reads as emphasis.
- **Pacing** — the `waitForTimeout` calls between beats in `capture()`.
- **How long the progress bar is on screen** — the fixture size in
  `fixture()`. It is the one knob that decides how much of the video is spent
  watching a file move.
- **Length/format** — `HOOK_MS`, `OUTRO_MS`, and `GEO`. A 9:16 cut means
  stacking the panes rather than sitting them side by side: change `GEO`, the
  `overlay` positions follow, and `scenes.html` re-cuts its own windows.

No audio track: there is no licensed music to ship in the repo, and every
platform that matters autoplays muted. The captions carry the whole story on
purpose.
