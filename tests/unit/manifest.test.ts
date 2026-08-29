import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRoute } from '../../client/routing.js';
import { SHARE_TARGET_PATH } from '../../client/share/inbox.js';

const publicUrl = (name: string): URL => new URL(`../../client/public/${name}`, import.meta.url);

const html = readFileSync(fileURLToPath(new URL('../../client/index.html', import.meta.url)), 'utf8');

interface Manifest {
  id: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
  shortcuts: { name: string; url: string }[];
  share_target: {
    action: string;
    method: string;
    enctype: string;
    params: {
      title: string;
      text: string;
      url: string;
      files: { name: string; accept: string[] }[];
    };
  };
}

const manifest = JSON.parse(
  readFileSync(publicUrl('manifest.webmanifest'), 'utf8'),
) as Manifest;

/**
 * A PNG's real pixel dimensions, straight out of its IHDR chunk.
 *
 * The manifest declares a `sizes` for each icon and browsers believe it: an
 * icon that is not the size it claims is rejected for install (or, worse,
 * accepted and rescaled). Since scripts/make-icons.py draws these, the way
 * that goes wrong is an edit to its output table — so this reads the bytes
 * rather than trusting the filename.
 */
function pngSize(name: string): string {
  const header = readFileSync(publicUrl(name)).subarray(16, 24);
  return `${header.readUInt32BE(0)}x${header.readUInt32BE(4)}`;
}

/** The `--color-bg` a given theme block in tokens.css declares. */
function backgroundOf(selector: string): string {
  const css = readFileSync(fileURLToPath(new URL('../../client/styles/tokens.css', import.meta.url)), 'utf8');
  const start = css.indexOf(selector);
  const body = css.slice(css.indexOf('{', start), css.indexOf('}', start));
  const value = /--color-bg:\s*([^;]+);/.exec(body)?.[1]?.trim();
  if (!value) throw new Error(`no --color-bg declared in ${selector}`);
  return value;
}

describe('web app manifest', () => {
  it('is linked from the page that has to be installable', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it('ships every icon it declares, at the size it declares', () => {
    for (const icon of manifest.icons) {
      // Served from client/public, so the manifest's root-relative src is the
      // file's own name at the origin root.
      expect(pngSize(icon.src.slice(1))).toBe(icon.sizes);
      expect(icon.type).toBe('image/png');
    }
  });

  it('meets the install criteria: 192 and 512 any, plus a maskable', () => {
    const any = manifest.icons.filter((icon) => icon.purpose === 'any').map((icon) => icon.sizes);
    expect(any).toContain('192x192');
    expect(any).toContain('512x512');
    // Without one, Android crops the standard tile — whose mark runs to the
    // corners on the diagonal, exactly where a circular mask cuts.
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
    expect(manifest.display).toBe('standalone');
  });

  it('paints its splash and title bar the same colour as the page', () => {
    // A manifest has no media queries, so this is the light background for
    // everyone — but it must at least still BE the light background, rather
    // than a hex left behind by a palette change.
    expect(manifest.theme_color).toBe(backgroundOf(':root {'));
    expect(manifest.background_color).toBe(backgroundOf(':root {'));
  });

  it('only launches routes the app actually has', () => {
    // An installed shortcut to a path that fell through to `home` would look
    // like the app ignoring the launcher.
    const urls = [manifest.start_url, ...manifest.shortcuts.map((shortcut) => shortcut.url)];
    const routes = urls.map((url) => parseRoute(new URL(url, 'https://quik.example')).t);
    expect(routes).toEqual(['home', 'new', 'join']);
  });

  it('keeps its scope and id over the whole app', () => {
    // `scope` narrower than '/' would push /s/CODE out of the installed
    // window and into a browser tab, which is the one link that matters.
    expect(manifest.scope).toBe('/');
    expect(manifest.id).toBe('/');
  });
});

describe('the share target', () => {
  it('posts to the path the service worker actually answers', () => {
    // The manifest and client/sw.ts are edited in different files by
    // different people; a mismatch here is a share that silently reaches the
    // network with its files already gone.
    expect(manifest.share_target.action).toBe(SHARE_TARGET_PATH);
  });

  it('is posted as multipart, which is the only way files can ride along', () => {
    // A GET share target cannot carry files at all, and a POST that is not
    // multipart/form-data drops them — for a file-sending app that is the
    // whole feature, quietly missing.
    expect(manifest.share_target.method).toBe('POST');
    expect(manifest.share_target.enctype).toBe('multipart/form-data');
  });

  it('names its file field what the worker reads, and accepts any type', () => {
    const [files] = manifest.share_target.params.files;
    expect(files?.name).toBe('files');
    expect(files?.accept).toContain('*/*');
  });

  it('keeps its target inside the worker scope that has to intercept it', () => {
    // Outside scope, no worker sees the POST however well it is declared.
    expect(manifest.share_target.action.startsWith(manifest.scope)).toBe(true);
  });
});
