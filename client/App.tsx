import { useEffect, useState } from 'react';
import { navigateTo, parseRoute, titleFor, type Route } from './routing.js';
import { CreateScreen } from './screens/CreateScreen.js';
import { LandingScreen } from './screens/LandingScreen.js';
import { JoinScreen } from './screens/JoinScreen.js';
import { SessionScreen } from './screens/SessionScreen.js';
import { InvalidScreen } from './screens/InvalidScreen.js';
import { AppHeader } from './ui/AppHeader.js';
import { AppFooter } from './ui/AppFooter.js';

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(new URL(location.href)));
  /**
   * Bumped to remount the create screen, and with it the whole session it
   * owns. CreateScreen renders InvalidScreen inline for a terminal outcome
   * while the route is *already* '/', so its "Start a new session" button
   * cannot recover by routing: pushing '/' re-renders CreateScreen into the
   * same slot, React reconciles rather than remounts, useSession's mount
   * effect never re-runs, and the screen stays dead until a manual reload.
   * A changed key is what makes React tear the old session down (the effect
   * cleanup terminates its worker) and build a genuinely new one.
   */
  const [createGeneration, setCreateGeneration] = useState(0);

  useEffect(() => {
    const onPopState = (): void => setRoute(parseRoute(new URL(location.href)));
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  }, []);

  // AGENTS.md MUST: <title> matches the current context. Screens are still
  // placeholders, so titleFor's strings are placeholders too — but the sync
  // itself is real, so Tasks 8-10 only need to change strings, not add this.
  useEffect(() => {
    document.title = titleFor(route);
  }, [route]);

  // The session screen is the only one wide enough to use several columns
  // (Share and Transfers, side by side); every other screen is a single
  // column of prose — a landing pitch, a QR code, a code input — that reads
  // badly stretched to the same width.
  //
  // Both widths went up a step in the soft-UI pass. At 1600px the old
  // max-w-2xl left a 672px column of content inside a 1600px window: over
  // half the screen was empty, and every raised surface had to compete for
  // attention inside one narrow strip. AppHeader no longer shares this
  // value — it spans the full window (see its own comment), which is what
  // stops the wordmark floating in mid-air on a wide display.
  // The shell no longer picks a width per route, and the reason is a bug it
  // caused: the CREATOR stays on '/new' for the whole session — CreateScreen
  // swaps itself for TransferPanel once a peer joins — so the paired
  // workspace was rendering inside the narrow prose measure '/new' wants
  // while it is still a QR code. Measured at a 1440px window, that gave the
  // creator 340px columns against 345px of Share buttons (they wrapped) while
  // the joiner, on '/s/:code', got 596px for the identical screen. A route
  // cannot know what its screen has since become; the screen can. So <main>
  // now sets one ceiling for the widest thing on the page, and each screen
  // constrains itself to its own measure — prose screens to max-w-3xl,
  // LandingScreen to its hero's width, TransferPanel to the whole shell.
  return (
    // The viewport-height floor moved from <main> to this wrapper when the
    // header arrived: left on <main>, the two elements stacked to 100dvh
    // PLUS the header's height and every page gained a scrollbar it did not
    // need. `flex-1` on <main> below now takes whatever the header does not.
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      <main id="main" className="mx-auto flex w-full max-w-[100rem] flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
        {route.t === 'home' && <LandingScreen />}
        {route.t === 'new' && (
          <CreateScreen
            key={createGeneration}
            onRestart={() => setCreateGeneration((generation) => generation + 1)}
          />
        )}
        {route.t === 'join' && (
          // The code is the whole credential now: whether it was typed,
          // scanned or pasted as a link, what reaches here is six characters
          // and what leaves is the session route for them.
          <JoinScreen onJoin={(code) => navigateTo(`/s/${code}`)} />
        )}
        {route.t === 'session' && <SessionScreen code={route.code} />}
        {route.t === 'invalid' && <InvalidScreen reason={route.reason} />}
      </main>
      {/* Home only, and outside <main> so it is the page's contentinfo
          landmark rather than a footer belonging to the main region. See
          AppFooter's own comment for both halves of that. */}
      {route.t === 'home' && <AppFooter />}
    </div>
  );
}
