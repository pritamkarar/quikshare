import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A plain string/regex read of the shipped file, not jsdom: the point of
// Correction 2 is that these EXACT values (copied from client/dev.html, not
// retyped) must have survived the swap to client/index.html. Parsing this
// into a DOM would let a matcher pass on the right values in the wrong
// place; a literal substring match pins the tag itself.
const html = readFileSync(
  fileURLToPath(new URL('../../client/index.html', import.meta.url)),
  'utf8',
);

const tokensCss = readFileSync(
  fileURLToPath(new URL('../../client/styles/tokens.css', import.meta.url)),
  'utf8',
);

/**
 * The `--color-bg` a given theme block actually declares.
 *
 * This test used to hardcode the two hex values, with a comment saying they
 * "must track --color-bg in client/styles/tokens.css". They then silently
 * stopped tracking it: the soft-UI palette changed both backgrounds and this
 * file kept asserting the old pair, so it passed while the browser chrome sat
 * a shade apart from the page on every device. A test that restates a
 * constant cannot notice the constant moving — so it now reads the source of
 * truth and compares, which is the assertion the comment always described.
 */
function backgroundOf(selector: string): string {
  const start = tokensCss.indexOf(selector);
  const body = tokensCss.slice(tokensCss.indexOf('{', start), tokensCss.indexOf('}', start));
  const value = /--color-bg:\s*([^;]+);/.exec(body)?.[1]?.trim();
  if (!value) throw new Error(`no --color-bg declared in ${selector}`);
  return value;
}

describe('client/index.html', () => {
  it('matches the browser chrome to the page background in both themes', () => {
    // Read from tokens.css rather than restated here, so a palette change
    // that forgets these two tags fails instead of passing quietly.
    expect(html).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${backgroundOf(':root {')}" />`,
    );
    expect(html).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${backgroundOf(':root[data-theme="dark"]')}" />`,
    );
  });

  it('offers a skip-to-content link targeting the main landmark', () => {
    expect(html).toMatch(/<a href="#main"[^>]*>Skip to content<\/a>/);
  });

  it('never disables pinch-to-zoom', () => {
    // Matched on the tag itself, not the whole document: a comment
    // documenting the ban (as this file has) would otherwise trip a raw
    // substring search on the banned strings.
    const viewportTag = /<meta name="viewport"[^>]*>/.exec(html)?.[0];
    expect(viewportTag).toBeDefined();
    expect(viewportTag).not.toMatch(/user-scalable=no/);
    expect(viewportTag).not.toMatch(/maximum-scale=1/);
  });

  it('points its module script at the new client entry', () => {
    expect(html).toContain('src="./main.tsx"');
  });
});
