// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigateTo, parseFilter, parseRoute, setFilterParam, titleFor, type Route } from '../../client/routing.js';

const KEY = 'a'.repeat(43);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseRoute', () => {
  it('treats the root as home', () => {
    expect(parseRoute(new URL('https://x.dev/'))).toEqual({ t: 'home' });
  });

  it('parses /new as its own route', () => {
    expect(parseRoute(new URL('https://x.dev/new'))).toEqual({ t: 'new' });
    expect(parseRoute(new URL('https://x.dev/new/'))).toEqual({ t: 'new' });
  });

  /*
   * The root must NOT be the create route. Mounting CreateScreen there
   * allocated a room on the relay on every page load — including reloads and
   * crawlers — for a session nobody asked for. An unknown path falling back
   * to the landing page is harmless; falling back to session creation is not.
   */
  it('does not treat the root or an unknown path as session creation', () => {
    expect(parseRoute(new URL('https://x.dev/'))).not.toEqual({ t: 'new' });
    expect(parseRoute(new URL('https://x.dev/whatever'))).toEqual({ t: 'home' });
  });

  it('parses a session URL that is nothing but a code', () => {
    expect(parseRoute(new URL('https://x.dev/s/K7M3QP')))
      .toEqual({ t: 'session', code: 'K7M3QP' });
  });

  it('normalizes a lowercase code in the path', () => {
    const route = parseRoute(new URL('https://x.dev/s/k7m3qp'));
    expect(route).toMatchObject({ t: 'session', code: 'K7M3QP' });
  });

  /*
   * The key used to ride after the '#', so a link a chat app truncated there
   * — or a code someone read aloud — landed on a dead 'missing-key' screen.
   * The key is agreed between the two devices now, so anything after the
   * fragment is leftover noise from an older link and must not stop a join
   * that is otherwise perfectly good.
   */
  it('ignores a leftover fragment from an older link', () => {
    expect(parseRoute(new URL(`https://x.dev/s/K7M3QP#${KEY}`)))
      .toEqual({ t: 'session', code: 'K7M3QP' });
    expect(parseRoute(new URL('https://x.dev/s/K7M3QP#short')))
      .toEqual({ t: 'session', code: 'K7M3QP' });
  });

  it('rejects a malformed code', () => {
    expect(parseRoute(new URL('https://x.dev/s/TOOLONG9')))
      .toEqual({ t: 'invalid', reason: 'bad-code' });
  });

  // Correction 3: a user who has a code read aloud to them but no QR to scan
  // needs somewhere to type it, so /join must be its own route.
  it('treats /join as its own route', () => {
    expect(parseRoute(new URL('https://x.dev/join'))).toEqual({ t: 'join' });
  });

  it('tolerates a trailing slash on /join', () => {
    expect(parseRoute(new URL('https://x.dev/join/'))).toEqual({ t: 'join' });
  });
});

describe('navigateTo', () => {
  it('navigates to exactly the path it was given', () => {
    const pushState = vi.spyOn(history, 'pushState');
    navigateTo('/s/K7M3QP');
    expect(pushState).toHaveBeenCalledWith(null, '', '/s/K7M3QP');
  });

  it('appends nothing of its own to a path', () => {
    const pushState = vi.spyOn(history, 'pushState');
    navigateTo('/join');
    expect(pushState).toHaveBeenCalledWith(null, '', '/join');
  });

  /*
   * The one behaviour that keeps Back out of a session that is over: '/'
   * overwrites the entry it is leaving instead of stacking on top of it, so
   * there is no '/s/:code' behind the landing page to walk back into.
   */
  it('replaces the current entry when going home, rather than stacking one', () => {
    const pushState = vi.spyOn(history, 'pushState');
    const replaceState = vi.spyOn(history, 'replaceState');
    history.pushState(null, '', '/s/K7M3QP');
    pushState.mockClear();

    navigateTo('/');

    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(pushState).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/');
  });

  it('dispatches a popstate event so a listening App re-renders on the new route', () => {
    const onPopState = vi.fn();
    addEventListener('popstate', onPopState);
    try {
      navigateTo('/s/K7M3QP');
      expect(onPopState).toHaveBeenCalledTimes(1);
    } finally {
      removeEventListener('popstate', onPopState);
    }
  });
});

describe('titleFor', () => {
  it('gives the home route a title that says what the product is', () => {
    expect(titleFor({ t: 'home' })).toContain('Quik Share');
  });

  it('names the create route', () => {
    expect(titleFor({ t: 'new' })).toContain('New session');
  });

  it('names the join route', () => {
    expect(titleFor({ t: 'join' })).toContain('Join');
  });

  it('names the session route by its code', () => {
    expect(titleFor({ t: 'session', code: 'K7M3QP' })).toContain('K7M3QP');
  });

  it('gives every route a distinct title, so the tab reliably shows context', () => {
    const routes: Route[] = [
      { t: 'home' },
      { t: 'new' },
      { t: 'join' },
      { t: 'session', code: 'K7M3QP' },
      { t: 'invalid', reason: 'bad-code' },
    ];
    const titles = routes.map(titleFor);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe('record filter in the URL', () => {
  it('reads a valid filter', () => {
    expect(parseFilter(new URL('https://x.dev/s/ABC123?filter=sent#key'))).toBe('sent');
    expect(parseFilter(new URL('https://x.dev/s/ABC123?filter=received#key'))).toBe('received');
  });

  /*
   * A URL is user-editable and shared by hand. Anything unrecognised — a
   * typo, an old link from before a filter was renamed — falls back to
   * showing everything rather than an empty list the user cannot explain.
   */
  it('falls back to "all" for anything unrecognised', () => {
    expect(parseFilter(new URL('https://x.dev/s/ABC123#key'))).toBe('all');
    expect(parseFilter(new URL('https://x.dev/s/ABC123?filter=nonsense#key'))).toBe('all');
    expect(parseFilter(new URL('https://x.dev/s/ABC123?filter=#key'))).toBe('all');
  });

  it('writes the filter without disturbing anything else in the URL', () => {
    history.replaceState(null, '', '/s/ABC123#thekey');
    setFilterParam('received');
    expect(location.search).toBe('?filter=received');
    // Nothing secret lives here any more, but a URL this function was asked
    // to add one parameter to should come back with one parameter added.
    expect(location.hash).toBe('#thekey');
  });

  it('drops the parameter entirely for the default rather than writing ?filter=all', () => {
    history.replaceState(null, '', '/s/ABC123?filter=sent#thekey');
    setFilterParam('all');
    expect(location.search).toBe('');
    expect(location.hash).toBe('#thekey');
  });

  /*
   * replaceState, not pushState: a filter is a view preference, and pushing
   * one history entry per chip click turns Back into a filter-undo button
   * instead of the way out of the session.
   */
  it('does not add a history entry', () => {
    history.replaceState(null, '', '/s/ABC123#thekey');
    const pushState = vi.spyOn(history, 'pushState');
    setFilterParam('sent');
    expect(pushState).not.toHaveBeenCalled();
    pushState.mockRestore();
  });
});
