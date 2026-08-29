# Wake Lock and Paste-to-Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a phone's screen sleeping mid-transfer and killing the connection, and let someone paste a screenshot straight into a paired session instead of saving it to disk first.

**Architecture:** Two small, independent additions to the paired-session screen. The wake lock goes inside `useTransferGuards`, which already owns "a transfer is running, protect it" — it holds the `beforeunload` guard and the title progress for exactly the same window, off exactly the same `inFlight` boolean. Paste-to-send is a `document`-level listener owned by `TransferPanel` for as long as the session is verified, routing `clipboardData.files` into the same `session.sendFiles` the drop zone uses.

**Tech Stack:** TypeScript, React 19, Vitest + jsdom, Playwright.

**Spec:** this document, [§Spec](#spec).

## Global Constraints

- Node ≥ 22. **The default `node` on this machine is v18 and the suite will not run on it** — every command below must be run with `export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"` first.
- No new dependencies. `navigator.wakeLock` and `ClipboardEvent` are platform features and are already typed in `lib.dom` under this `tsconfig.json` (`"lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"]`).
- `navigator.wakeLock` is typed as non-optional but is absent on Safari < 16.4 and on any insecure origin. Reach for it through a cast to `| undefined`, the pattern `client/screens/CreateScreen.tsx:78` already uses for `navigator.clipboard`.
- Nothing sends before `session.verifiedByMe && session.verifiedByPeer`. Paste is not an exception.
- AGENTS.md: every gesture needs a click/keyboard alternative. Paste *is* the keyboard path; the drop zone's "Choose files" button remains the guaranteed one.
- Neither feature may surface an error. A denied wake lock and a paste with nothing in it are both non-events.

## Spec

**Wake lock**

1. While any file is still moving, the device holds a screen wake lock.
2. It is released the moment the last file finishes, the panel unmounts, or the transfer is cancelled.
3. If the user switches away and comes back mid-transfer, the lock is re-acquired — the OS drops it on hide and never restores it, and "user backgrounded the app" is precisely the case where the screen was about to sleep.
4. A browser without the API, or a refusal, changes nothing else: the transfer runs exactly as it does today.

**Paste to send**

5. In a verified session, pasting one or more files sends them immediately, exactly as dropping them would.
6. A paste aimed at a field is never intercepted — the note composer on that same screen is a textarea, and stealing its ⌘V would make it impossible to paste a link into the thing built for sending links.
7. A paste carrying no files does nothing at all and is not prevented.
8. The drop zone says paste is available, since nothing else on screen would suggest it.

**Non-goals (deliberate)**

- Holding a wake lock during a live camera/screen share. Real (a sleeping phone kills that stream too), but it hangs off `LiveSession`'s slot state rather than `inFlight`, and belongs with the media work rather than here.
- Pasting *text* into an unfocused page to send it as a note. The composer is already on screen and one tab away; intercepting bare text paste risks swallowing a paste the user meant for it.

## File Structure

| File | Responsibility |
|---|---|
| `client/hooks/useTransferGuards.ts` *(modify)* | Gains the wake-lock effect, beside the two guards it already holds for the same window. |
| `client/screens/TransferPanel.tsx` *(modify)* | Owns the paste listener for as long as the session is verified. |
| `client/ui/DropZone.tsx` *(modify)* | One string: the zone now names paste as a way in. |
| `tests/ui/transfer-guards.test.tsx` *(modify)* | Lock taken, released, re-acquired; absent API is a non-event. |
| `tests/ui/paste-to-send.test.tsx` *(create)* | Files sent, fields not hijacked, empty paste ignored, gate respected. |
| `tests/e2e/transfer.spec.ts` *(modify)* | A real transfer really asks for a wake lock. |

---

### Task 1: Hold the screen awake while bytes are moving

**Files:**
- Modify: `client/hooks/useTransferGuards.ts` (add one effect after the `beforeunload` effect)
- Test: `tests/ui/transfer-guards.test.tsx`

**Interfaces:**
- Consumes: the existing `inFlight` boolean already computed at the top of `useTransferGuards`.
- Produces: no signature change. `useTransferGuards(files: TrackedFile[]): void` stays exactly as it is, and every existing caller is untouched.

- [ ] **Step 1: Write the failing test**

Add to `tests/ui/transfer-guards.test.tsx`. Put this fake and its `beforeEach` beside the existing helpers at the top of the file:

```tsx
import { afterEach, vi } from 'vitest';

interface FakeSentinel { released: boolean; release: () => Promise<void> }

/** Every lock `request('screen')` has handed out in the current test. */
let sentinels: FakeSentinel[] = [];
let requestScreenLock: ReturnType<typeof vi.fn>;

function installWakeLock(): void {
  sentinels = [];
  requestScreenLock = vi.fn(async () => {
    const sentinel: FakeSentinel = {
      released: false,
      release: async () => { sentinel.released = true; },
    };
    sentinels.push(sentinel);
    return sentinel;
  });
  vi.stubGlobal('navigator', Object.create(navigator, {
    wakeLock: { value: { request: requestScreenLock }, configurable: true },
  }));
}

/** Drives the visibility transition the OS uses to drop a lock. */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setVisibility('visible');
});
```

Then the tests:

```tsx
describe('the screen wake lock', () => {
  beforeEach(installWakeLock);

  it('is taken while a transfer is in flight', async () => {
    renderHook(() => useTransferGuards([tracked()]));

    // A phone that sleeps mid-transfer does not pause it — it drops the
    // connection, and there is no resume.
    await vi.waitFor(() => expect(requestScreenLock).toHaveBeenCalledWith('screen'));
  });

  it('is not taken when nothing is moving', () => {
    renderHook(() => useTransferGuards([tracked({ done: true })]));
    expect(requestScreenLock).not.toHaveBeenCalled();
  });

  it('is released once the last file finishes', async () => {
    const { rerender } = renderHook(({ files }: { files: TrackedFile[] }) => useTransferGuards(files), {
      initialProps: { files: [tracked()] },
    });
    await vi.waitFor(() => expect(sentinels).toHaveLength(1));

    rerender({ files: [tracked({ done: true })] });

    // Holding it past the transfer would keep a phone awake indefinitely on
    // a screen nobody is looking at.
    await vi.waitFor(() => expect(sentinels[0]!.released).toBe(true));
  });

  it('is released when the screen goes away mid-transfer', async () => {
    const { unmount } = renderHook(() => useTransferGuards([tracked()]));
    await vi.waitFor(() => expect(sentinels).toHaveLength(1));

    unmount();

    await vi.waitFor(() => expect(sentinels[0]!.released).toBe(true));
  });

  it('is taken again after the user switches away and comes back', async () => {
    renderHook(() => useTransferGuards([tracked()]));
    await vi.waitFor(() => expect(requestScreenLock).toHaveBeenCalledTimes(1));

    // The OS releases the lock on hide and never restores it — and someone
    // who just came back to a still-running transfer is exactly the person
    // whose screen was about to sleep.
    setVisibility('hidden');
    setVisibility('visible');

    await vi.waitFor(() => expect(requestScreenLock).toHaveBeenCalledTimes(2));
  });

  it('does not re-take it after the transfer has finished', async () => {
    const { rerender } = renderHook(({ files }: { files: TrackedFile[] }) => useTransferGuards(files), {
      initialProps: { files: [tracked()] },
    });
    await vi.waitFor(() => expect(requestScreenLock).toHaveBeenCalledTimes(1));

    rerender({ files: [tracked({ done: true })] });
    setVisibility('hidden');
    setVisibility('visible');

    expect(requestScreenLock).toHaveBeenCalledTimes(1);
  });

  it('changes nothing on a browser without the API', () => {
    // Safari below 16.4, and any insecure origin. The transfer must run
    // exactly as it does today rather than throw on a missing property.
    vi.stubGlobal('navigator', Object.create(navigator, {
      wakeLock: { value: undefined, configurable: true },
    }));

    expect(() => renderHook(() => useTransferGuards([tracked()]))).not.toThrow();
  });

  it('survives a refusal without disturbing the transfer', async () => {
    requestScreenLock.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));

    const { unmount } = renderHook(() => useTransferGuards([tracked()]));
    await vi.waitFor(() => expect(requestScreenLock).toHaveBeenCalled());

    // Nothing to tell the user: the transfer still works, the screen just
    // may sleep, and there is nothing they could do about it from here.
    expect(() => unmount()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/ui/transfer-guards.test.tsx
```

Expected: FAIL — `requestScreenLock` never called.

- [ ] **Step 3: Write the implementation**

In `client/hooks/useTransferGuards.ts`, add this effect immediately after the existing `beforeunload` effect and before the `document.title` effect:

```ts
  /**
   * Keeps the screen awake for as long as bytes are moving.
   *
   * On a phone this is not a comfort feature. There is no resume: a screen
   * that sleeps mid-transfer suspends the page, drops the connection, and
   * the transfer is simply gone — the same loss the `beforeunload` guard
   * above exists to prevent, arriving through the one door that guard
   * cannot cover, because the user never navigated anywhere.
   *
   * Lives in this hook rather than in a hook of its own because it is the
   * same window, off the same `inFlight`, for the same reason: everything
   * here is "a transfer is running, protect it".
   */
  useEffect(() => {
    if (!inFlight) return;
    // Typed non-optional by lib.dom, absent on Safari below 16.4 and on any
    // insecure origin — a LAN address served over plain http is one, which
    // is a normal way to reach this app.
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock;
    if (wakeLock === undefined) return;

    let sentinel: WakeLockSentinel | undefined;
    let done = false;

    const acquire = (): void => {
      // A request while the document is hidden rejects by spec, and the
      // visibility listener below is what covers coming back.
      if (done || sentinel !== undefined || document.visibilityState !== 'visible') return;
      void wakeLock.request('screen').then(
        (granted) => {
          // The effect can have been cleaned up while this was in flight;
          // an unreleased sentinel would keep the screen lit for good.
          if (done) { void granted.release(); return; }
          sentinel = granted;
        },
        // Refused, or the document went hidden between the check and the
        // call. Nothing to report: the transfer is unaffected and the user
        // could do nothing about it from here anyway.
        () => {},
      );
    };

    /*
     * The OS drops the lock whenever the document is hidden and never gives
     * it back. Without this, switching to another app for two seconds
     * mid-transfer silently removes the very protection this effect exists
     * for — and the user who just switched back is precisely the one whose
     * screen was seconds from sleeping.
     */
    const onVisibilityChange = (): void => {
      sentinel = undefined;
      acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      done = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release();
    };
  }, [inFlight]);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/ui/transfer-guards.test.tsx && npm run typecheck
```

Expected: PASS (8 new tests plus the file's existing ones), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add client/hooks/useTransferGuards.ts tests/ui/transfer-guards.test.tsx
git commit -m "feat(transfer): keep the screen awake while a transfer is still moving"
```

---

### Task 2: Paste a screenshot into a session

**Files:**
- Modify: `client/screens/TransferPanel.tsx` (one effect, beside the existing session effects)
- Modify: `client/ui/DropZone.tsx:72` (the prompt string)
- Test: `tests/ui/paste-to-send.test.tsx`

**Interfaces:**
- Consumes: `session.sendFiles(files: File[])` and `session.verifiedByMe` / `verifiedByPeer` from `SessionHandle`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `tests/ui/paste-to-send.test.tsx`. Copy the `LiveSession` mock and the `stubSession(overrides)` factory from `tests/ui/transfer-panel.test.tsx` verbatim — `TransferPanel` builds a real `LiveSession`, which jsdom cannot host, and every `TransferPanel` suite in this repo mocks it the same way.

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TransferPanel } from '../../client/screens/TransferPanel.js';

// … LiveSession mock and `stubSession(overrides)` factory, copied from
// tests/ui/transfer-panel.test.tsx …

const shot = (name = 'screenshot.png'): File => new File([new Uint8Array([1, 2])], name, { type: 'image/png' });

/**
 * A paste carrying files, dispatched at a real element.
 *
 * jsdom's ClipboardEvent has no usable DataTransfer, so `clipboardData` is
 * defined onto the event directly — which is all the handler reads.
 */
function paste(target: EventTarget, files: File[]): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files } });
  target.dispatchEvent(event);
  return event;
}

describe('pasting into a paired session', () => {
  it('sends a pasted file the way dropping it would', () => {
    const session = stubSession({ verifiedByMe: true, verifiedByPeer: true });
    render(<TransferPanel session={session} />);

    const event = paste(document.body, [shot()]);

    expect(session.sendFiles).toHaveBeenCalledTimes(1);
    expect(session.sendFiles.mock.calls[0]![0].map((f: File) => f.name)).toEqual(['screenshot.png']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('sends every file in one paste', () => {
    const session = stubSession({ verifiedByMe: true, verifiedByPeer: true });
    render(<TransferPanel session={session} />);

    paste(document.body, [shot('one.png'), shot('two.png')]);

    expect(session.sendFiles.mock.calls[0]![0]).toHaveLength(2);
  });

  it('never steals a paste aimed at the note composer', () => {
    const session = stubSession({ verifiedByMe: true, verifiedByPeer: true });
    render(<TransferPanel session={session} />);
    const composer = screen.getByRole('textbox');

    const event = paste(composer, [shot()]);

    // Hijacking this would make it impossible to paste a link into the one
    // control built for sending links.
    expect(session.sendFiles).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores a paste that carries no files', () => {
    const session = stubSession({ verifiedByMe: true, verifiedByPeer: true });
    render(<TransferPanel session={session} />);

    const event = paste(document.body, []);

    expect(session.sendFiles).not.toHaveBeenCalled();
    // Not prevented: an ordinary text paste must go on behaving ordinarily.
    expect(event.defaultPrevented).toBe(false);
  });

  it('sends nothing before both users have confirmed the number', () => {
    const session = stubSession({ verifiedByMe: true, verifiedByPeer: false });
    render(<TransferPanel session={session} />);

    paste(document.body, [shot()]);

    expect(session.sendFiles).not.toHaveBeenCalled();
  });

  it('stops listening once the panel is gone', () => {
    const session = stubSession({ verifiedByMe: true, verifiedByPeer: true });
    const { unmount } = render(<TransferPanel session={session} />);

    unmount();
    paste(document.body, [shot()]);

    // A document-level listener that outlives its component would send into
    // a session that no longer exists.
    expect(session.sendFiles).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/ui/paste-to-send.test.tsx
```

Expected: FAIL — `sendFiles` never called.

- [ ] **Step 3: Write the implementation**

In `client/screens/TransferPanel.tsx`, add this effect after the `verified` constant:

```tsx
  /**
   * ⌘/Ctrl+V sends whatever files are on the clipboard.
   *
   * The gap this closes is the screenshot: taking one puts it on the
   * clipboard and nowhere else, so sending it through the drop zone means
   * saving it to disk first, finding it in a picker, and deleting it after.
   *
   * On `document` rather than a container, because a paste with nothing
   * focused targets `body` — requiring a click into a zone first would put
   * the gesture behind exactly the step it exists to remove.
   */
  useEffect(() => {
    if (!verified) return;
    const onPaste = (event: ClipboardEvent): void => {
      // Never intercept a paste aimed at a field. The note composer on this
      // very screen is a textarea, and swallowing its ⌘V would make it
      // impossible to paste a link into the control built for sending links.
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable]')) return;

      const files = [...(event.clipboardData?.files ?? [])];
      // An ordinary text paste is not this handler's business, and must not
      // be prevented on its way to whatever else would have handled it.
      if (files.length === 0) return;

      event.preventDefault();
      session.sendFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [verified, session.sendFiles]);
```

- [ ] **Step 4: Say so in the drop zone**

In `client/ui/DropZone.tsx`, change the prompt — nothing else on screen would suggest paste is available, and an invisible feature is not a feature:

```tsx
      <p className="text-[var(--color-text-muted)]">Drop files here, paste them, or choose them below</p>
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/ui/paste-to-send.test.tsx tests/ui/transfer-panel.test.tsx tests/ui/a11y.test.tsx
npm run typecheck
```

Expected: PASS across all three, typecheck clean. (`transfer-panel.test.tsx` and `a11y.test.tsx` both render the drop zone; run them because the prompt string changed.)

- [ ] **Step 6: Commit**

```bash
git add client/screens/TransferPanel.tsx client/ui/DropZone.tsx tests/ui/paste-to-send.test.tsx
git commit -m "feat(transfer): send what is on the clipboard, so a screenshot never has to touch disk"
```

---

### Task 3: Prove the lock is really asked for during a real transfer

**Files:**
- Modify: `tests/e2e/transfer.spec.ts`

**Interfaces:**
- Consumes: the `pair` and `makeFixture` helpers in `tests/e2e/helpers.ts`.
- Produces: nothing.

**Why:** the unit tests drive a fake `navigator.wakeLock`. What they cannot show is that `inFlight` is ever true long enough, in a real browser, for the effect to run at all — which is the only thing that makes the feature real.

- [ ] **Step 1: Write the failing test**

Add to `tests/e2e/transfer.spec.ts`:

```ts
test('a real transfer asks the browser to keep the screen awake', async ({ browser }) => {
  const { host, guest } = await pair(browser);

  // Recorded rather than observed: headless Chromium grants no screen lock,
  // and the assertion that matters is that the app asked at the moment it
  // had something to protect. Installed before any app code runs.
  await host.page.addInitScript(() => {
    (window as unknown as { wakeLockRequests: string[] }).wakeLockRequests = [];
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async (type: string) => {
          (window as unknown as { wakeLockRequests: string[] }).wakeLockRequests.push(type);
          return { release: async () => {} };
        },
      },
    });
  });
  await host.page.reload();

  const { path } = makeFixture(4 * 1024 * 1024);
  await host.page.setInputFiles('input[type=file]', path);

  await expect(guest.page.getByText(/received/i)).toBeVisible({ timeout: 30_000 });
  expect(await host.page.evaluate(() => (window as unknown as { wakeLockRequests: string[] }).wakeLockRequests))
    .toContain('screen');

  await host.context.close();
  await guest.context.close();
});
```

**Note for the implementer:** `addInitScript` only applies to loads after it is installed, hence the `reload()` — but reloading the host tears down its session. If the reload drops the pairing, restructure instead: install the init script on a fresh context *before* pairing, by adding an optional `beforePair` hook to `pair()` in `tests/e2e/helpers.ts` rather than reloading. Take whichever of the two the suite actually goes green with, and delete the other.

- [ ] **Step 2: Run it to verify it fails without the feature**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
git stash && npm run build && npx playwright test tests/e2e/transfer.spec.ts; git stash pop
```

Expected: FAIL — `wakeLockRequests` is empty.

- [ ] **Step 3: Run it against the implementation**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run build && npx playwright test tests/e2e/transfer.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Run everything**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npx vitest run && npx playwright test
```

Expected: unit suite fully green; e2e green except the two pre-existing failures in `tests/e2e/accessibility.spec.ts` (`:64` sticky-overlap, `:190` tap-target floor), which fail on a clean checkout of `master` too and are not this plan's to fix.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/transfer.spec.ts tests/e2e/helpers.ts
git commit -m "test(transfer): check the wake lock is asked for when a real transfer starts"
```

---

## Self-Review

**Spec coverage:** §1 Task 1 (`acquire` on `inFlight`). §2 Task 1 (cleanup releases; `inFlight` falls on done/cancelled/unmount). §3 Task 1 (`visibilitychange`). §4 Task 1 (`wakeLock === undefined` return, rejection swallowed). §5 Task 2 (paste effect). §6 Task 2 (`closest` guard). §7 Task 2 (empty-files early return, no `preventDefault`). §8 Task 2 Step 4 (drop zone string). Non-goals: recorded, no tasks — correct.

**Placeholders:** Task 2 Step 1's mock block points at `tests/ui/transfer-panel.test.tsx` rather than restating ~60 lines of `FakeLiveSession` — a pointer to real code at a named path, not a TODO. Task 3 Step 1 carries a genuine fork (reload vs. `beforePair`) with both branches spelled out and a rule for choosing; it is a decision the run resolves, not a detail left blank.

**Type consistency:** `useTransferGuards(files: TrackedFile[]): void` is unchanged, so no caller moves. `WakeLock` / `WakeLockSentinel` / `WakeLockType` come from `lib.dom` (verified present in this repo's TypeScript 5.6). `session.sendFiles(files: File[])` matches `SessionHandle` at `client/hooks/useSession.ts:152`, the same call `DropZone` already makes.
