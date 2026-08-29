// tests/unit/tokens.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../client/styles/tokens.css', import.meta.url), 'utf8');

const TOKENS = [
  '--color-bg', '--color-surface', '--color-surface-2', '--color-border',
  '--color-text', '--color-text-muted', '--color-accent', '--color-accent-fg',
  '--color-success', '--color-warning', '--color-danger',
];

// Extracts the `{ ... }` body of the first rule whose selector text contains
// `selector`, so tests can assert on what a block actually redefines rather
// than merely that its selector string appears somewhere in the file. None
// of tokens.css's theme blocks nest braces, so "next `}` after the opening
// brace" is always that block's own close.
function blockAfter(selector: string): string {
  const start = css.indexOf(selector);
  const braceStart = css.indexOf('{', start);
  const braceEnd = css.indexOf('}', braceStart);
  return css.slice(braceStart, braceEnd);
}

describe('design tokens', () => {
  it('defines every token on bare :root so light mode never depends on a media query', () => {
    const root = blockAfter(':root {');
    for (const token of TOKENS) expect(root).toContain(token);
  });

  it('redefines tokens for system dark mode, guarded against an explicit light choice', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(':root:not([data-theme="light"])');
    // Not just present as a selector: the guarded block must actually
    // redefine a token, or an empty block would pass this test for free.
    const guardBlock = blockAfter(':root:not([data-theme="light"])');
    expect(guardBlock).toContain('--color-bg');
  });

  it('redefines tokens for an explicit dark choice so a toggle wins both ways', () => {
    expect(css).toContain(':root[data-theme="dark"]');
    const explicitDarkBlock = blockAfter(':root[data-theme="dark"]');
    expect(explicitDarkBlock).toContain('--color-bg');
  });

  // The four token categories AGENTS.md's APCA bar actually governs — body
  // text, muted/large text, and every status color — must be redefined in
  // BOTH dark branches, not just present on bare :root (light). The two
  // tests above only ever probed those blocks for --color-bg, so a dark
  // theme silently falling back to a light --color-text (or any status
  // color) would have passed unnoticed.
  it('redefines every APCA-governed token (text, muted, accent, status colors) in both dark themes', () => {
    const APCA_TOKENS = [
      '--color-text', '--color-text-muted', '--color-accent',
      '--color-success', '--color-warning', '--color-danger',
    ];
    const guardBlock = blockAfter(':root:not([data-theme="light"])');
    const explicitDarkBlock = blockAfter(':root[data-theme="dark"]');
    for (const token of APCA_TOKENS) {
      expect(guardBlock).toContain(token);
      expect(explicitDarkBlock).toContain(token);
    }
  });

  it('sets color-scheme in all three theme branches so native chrome always matches', () => {
    // Checked per-branch, not just "somewhere in the file": color-scheme set
    // on :root but silently dropped from one of the dark branches would
    // leave a dark page with light scrollbars/autofill in that branch.
    expect(blockAfter(':root {')).toContain('color-scheme:');
    expect(blockAfter(':root:not([data-theme="light"])')).toContain('color-scheme:');
    expect(blockAfter(':root[data-theme="dark"]')).toContain('color-scheme:');
  });

  it('honors prefers-reduced-motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('never animates a layout property, in shorthand or longhand transition-property', () => {
    expect(css).not.toMatch(
      /transition(-property)?:[^;]*\b(width|height|top|left|right|bottom|margin|padding)\b/,
    );
  });

  it('never uses transition: all', () => {
    expect(css).not.toMatch(/transition:\s*all/);
  });
});
