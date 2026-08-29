import { useEffect, useState } from 'react';
import { IconMoon, IconSun } from './icons.js';

/**
 * Where an explicit theme choice is kept. Read by the inline script in
 * client/index.html before first paint, which is what stops a stored dark
 * choice flashing light on load; written only here.
 */
export const THEME_KEY = 'quik-share-theme';

export type Theme = 'light' | 'dark';

/**
 * The theme with no choice made — which is the state this app ships in, and
 * the one client/styles/tokens.css treats as the default (see its header on
 * why "system" is a third state rather than a synonym for light).
 *
 * Guarded rather than called directly: `matchMedia` is absent in jsdom and in
 * any non-browser environment, and this runs during render.
 */
function systemTheme(): Theme {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/**
 * Wrapped in try/catch, and not defensively: `localStorage` *throws* on
 * access — not returns null — in a Safari private window and wherever site
 * data is blocked. An uncaught throw here happens during the first render of
 * every screen, so it would take the whole app down for exactly the
 * privacy-conscious viewers this product is for.
 */
function storedTheme(): Theme | undefined {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Applies a theme to the document, and keeps the browser's own chrome in
 * step with it.
 *
 * The `content` of BOTH `theme-color` tags is set, which looks redundant and
 * is not: client/index.html declares one per `prefers-color-scheme` so the
 * no-choice case is correct with no JS at all, and only one of the two ever
 * matches. Writing the same value to both means whichever one the OS is
 * matching now reports the theme the *user* picked, however those two
 * disagree.
 *
 * The color is read back from the cascade rather than written as a literal,
 * so the browser chrome cannot drift from --color-bg the way a hardcoded pair
 * of hexes in the HTML would.
 */
function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  const background = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim();
  if (background === '') return;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', background);
  }
}

/**
 * Light and dark, as a single button.
 *
 * Deliberately two states rather than three. A light/dark/system cycle is the
 * more complete control and it is also one nobody reads on first sight: the
 * third press lands on a state whose *name* is the only thing distinguishing
 * it from one of the other two. So the first press makes a choice, and from
 * then on this device has one. Until then the page follows the OS, which
 * tokens.css already handles without JavaScript.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme());

  /*
   * Only while no explicit choice exists: someone who has picked a theme has
   * said what they want, and an OS-level sunset should not overrule them.
   * The listener is what makes the button's own icon correct after the OS
   * flips, since nothing else re-renders this component.
   */
  useEffect(() => {
    if (storedTheme() !== undefined) return;
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => setTheme(event.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  function handleClick(): void {
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Blocked storage: the choice still applies to this page, it just does
      // not survive a reload. Failing the click outright would be worse.
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      // The button is icon-only, so the label is the whole accessible name —
      // and it names the OUTCOME rather than the current state, since that is
      // what a person is deciding when they reach for it.
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="neo-press inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[color-mix(in_oklab,var(--color-surface)_92%,var(--color-text)_8%)] hover:text-[var(--color-text)]"
    >
      {/* Shows the theme it switches TO, matching the label. */}
      <span className="text-lg">{next === 'dark' ? <IconMoon /> : <IconSun />}</span>
    </button>
  );
}
