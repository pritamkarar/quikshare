import { normalizeCode } from '../shared/codes.js';
import { RECORD_FILTERS, type RecordFilter } from './ui/record.js';

export type Route =
  | { t: 'home' }
  | { t: 'new' }
  | { t: 'join' }
  | { t: 'session'; code: string }
  | { t: 'invalid'; reason: 'bad-code' };

export function parseRoute(url: URL): Route {
  // A user with a code read aloud to them but nothing to scan needs
  // somewhere to type it (see CreateScreen's link), so /join is its own
  // route rather than falling through to `home`.
  if (/^\/join\/?$/.test(url.pathname)) return { t: 'join' };

  // Creating a session is its own route, not what '/' does.
  //
  // '/' used to mount CreateScreen directly, which allocates a room on the
  // relay the instant the page loads — so every visit, every refresh, and
  // every crawler burned a room code and a slot in the create rate limit for
  // a session nobody had asked for. Splitting it also makes "create" a real
  // destination: it survives a reload, the back button returns to the
  // landing page, and the fallback for an unknown path can be somewhere
  // harmless instead of somewhere with a side effect.
  if (/^\/new\/?$/.test(url.pathname)) return { t: 'new' };

  const match = /^\/s\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return { t: 'home' };

  const code = normalizeCode(decodeURIComponent(match[1]!));
  if (!code) return { t: 'invalid', reason: 'bad-code' };

  // Nothing else to check: the six-character code is the whole credential.
  // It used to need a 43-character key fragment alongside it — a link
  // truncated at the `#` by a chat app landed on its own 'missing-key'
  // failure — but the key is agreed between the two devices now, so a code
  // that parses is a code that can join.
  return { t: 'session', code };
}

/**
 * Asked before any in-app navigation, and able to veto it by returning false.
 *
 * `beforeunload` covers closing or reloading the tab, but it does not fire
 * for `history.pushState` — and this app's only route out of a live transfer
 * is an in-app link, so that half of AGENTS.md's "warn on unsaved changes
 * before navigation" was the half that was missing. Installed by
 * `useTransferGuards`, which owns both halves.
 *
 * One slot, not a list: exactly one screen at a time owns work that
 * navigation would destroy, and a stack would be a lie about that.
 */
let navigationGuard: (() => boolean) | undefined;

export function setNavigationGuard(guard: (() => boolean) | undefined): void {
  navigationGuard = guard;
}

/**
 * The one way in and out of every screen. Was also responsible for carrying
 * the key fragment across a navigation — the key does not live in the URL
 * any more, so a path is now the whole story.
 */
export function navigateTo(path: string, before?: () => Promise<void>): void {
  // Checked here rather than in each link: every in-app navigation in the app
  // — JoinLink on three screens, InvalidScreen's retry, both "Start a new
  // session" buttons — routes through this function, so one guard covers all
  // of them and a new call site inherits it for free.
  if (navigationGuard && !navigationGuard()) return;
  /*
   * `before` runs after the guard and before the navigation, and that order
   * is the whole reason it exists.
   *
   * "End session" has to tell the peer it is leaving on purpose, and the
   * frame that says so dies with the worker the moment this navigates (see
   * `SessionHandle.endSession`). Sending it from the call site instead would
   * mean either asking the guard twice — one confirm to decide, another to
   * navigate — or telling the peer the session is over and then leaving the
   * user on it when they decline.
   */
  if (before) { void before().then(() => leaveTo(path)); return; }
  leaveTo(path);
}

/**
 * Navigates without consulting the guard.
 *
 * Only for a session that is already over: the guard exists to warn that
 * leaving cancels a transfer, and once the other device has gone there is no
 * transfer left to cancel. Asking anyway would put "a transfer is still
 * running" in front of someone whose transfer has already stopped.
 */
export function leaveTo(path: string): void {
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * One session's tab title, for the two owners that write one: this module,
 * from the route, and CreateScreen, from the live session code. They had
 * drifted into two spellings of the same thing ("Session ABC123 — Quik Share"
 * against "ABC123 — Quik Share"); the shorter wins because
 * `useTransferGuards` prefixes a progress percentage onto it, and a truncated
 * tab should show the number and the code rather than the word "Session".
 */
export function sessionTitle(code: string): string {
  return `${code} · Quik Share`;
}

/**
 * `<title>` matching the current context is an AGENTS.md MUST. The hook that
 * keeps `document.title` in sync with the route lives in App.
 */
export function titleFor(route: Route): string {
  switch (route.t) {
    case 'home':
      return 'Quik Share · Send files between devices';
    case 'new':
      return 'New session · Quik Share';
    case 'join':
      return 'Join a session · Quik Share';
    case 'session':
      return sessionTitle(route.code);
    case 'invalid':
      return 'Invalid code · Quik Share';
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
  }
}

/**
 * The one origin every canonical URL is written against.
 *
 * Hardcoded rather than read from `location.origin`, and that is the whole
 * point of the tag: a site reachable at more than one hostname (apex and
 * `www`, a preview deployment, the render.com default subdomain) would
 * otherwise declare each copy canonical to itself and split its own ranking
 * across all of them. One literal here means every copy points at the same
 * place.
 */
const CANONICAL_ORIGIN = 'https://quikshare.qd.je';

/**
 * The canonical URL for a path.
 *
 * Takes the pathname rather than a `Route` because normalising is the job:
 * `/join` and `/join/` are the same screen and `?filter=images` is a view
 * preference, so query, fragment and a trailing slash all come off. A `Route`
 * has already lost the distinctions this exists to collapse.
 */
export function canonicalFor(pathname: string): string {
  const path = pathname.replace(/\/+$/, '');
  return `${CANONICAL_ORIGIN}${path || '/'}`;
}

/**
 * The record's active filter, read from `?filter=`.
 *
 * A query parameter rather than part of the path: the path identifies the
 * room and nothing else belongs in it. Anything unrecognised reads as 'all'
 * — this URL is
 * user-editable and gets pasted between devices, and an unknown value
 * should show everything rather than an empty list with no explanation.
 */
export function parseFilter(url: URL): RecordFilter {
  const raw = url.searchParams.get('filter');
  return RECORD_FILTERS.find((known) => known === raw) ?? 'all';
}

/**
 * Writes the filter back, preserving everything else about the URL.
 *
 * `replaceState`, never `pushState`: a filter is a view preference, and one
 * history entry per chip click would turn Back into a filter-undo button
 * rather than the way out of the session — which AGENTS.md's "no dead ends"
 * and the user's own expectation both depend on.
 *
 * The default drops the parameter instead of writing `?filter=all`, so the
 * URL someone copies out of the address bar is the same clean share link
 * they started with.
 */
export function setFilterParam(filter: RecordFilter): void {
  const url = new URL(location.href);
  if (filter === 'all') url.searchParams.delete('filter');
  else url.searchParams.set('filter', filter);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
