// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeThisDevice } from '../../client/device.js';

/*
 * User-agent sniffing is unreliable by construction, which is exactly why it
 * is pinned by tests: nothing in the transfer path branches on these answers,
 * so a regression here is silent -- a card that quietly says "Linux" about an
 * iPad and nothing else going wrong.
 *
 * The cases below are the ones that a naive implementation gets wrong, not a
 * survey of every browser: every one of these strings contains a token that
 * a simpler test would match first.
 */

/** jsdom's navigator properties are read-only, so each is redefined in place. */
function pretendToBe(ua: string, maxTouchPoints = 0): void {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
}

/**
 * An in-memory stand-in. Neither jsdom nor Node supplies a usable
 * `localStorage` under this runner -- Node's own global throws unless the
 * process was started with `--localstorage-file` -- so the persistence
 * behaviour has to be tested against a store the test provides itself. That
 * this environment lands on the throwing path by default is convenient: it
 * means every other test in this file also exercises the fallback.
 */
function workingStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const MACBOOK = IPAD_DESKTOP_UA;
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const WINDOWS_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';

describe('describeThisDevice', () => {
  it('reads an iPhone as a phone running iOS, not a Mac', () => {
    pretendToBe(IPHONE, 5);
    const device = describeThisDevice();
    expect(device.kind).toBe('mobile');
    expect(device.os).toBe('iOS');
    expect(device.browser).toBe('Safari');
  });

  /*
   * Safari on an iPad has claimed to be a Macintosh since iPadOS 13. Without
   * the maxTouchPoints check, every iPad in the world reports "desktop" --
   * and the string alone genuinely cannot tell the two apart.
   */
  it('tells an iPad apart from a MacBook by touch points alone', () => {
    pretendToBe(IPAD_DESKTOP_UA, 5);
    expect(describeThisDevice()).toMatchObject({ kind: 'tablet', os: 'iPadOS' });

    pretendToBe(MACBOOK, 0);
    expect(describeThisDevice()).toMatchObject({ kind: 'desktop', os: 'macOS' });
  });

  /** Android's own convention: a phone carries "Mobile", a tablet does not. */
  it('separates an Android phone from an Android tablet', () => {
    pretendToBe(ANDROID_PHONE, 5);
    expect(describeThisDevice()).toMatchObject({ kind: 'mobile', os: 'Android', browser: 'Chrome' });

    pretendToBe(ANDROID_TABLET, 5);
    expect(describeThisDevice()).toMatchObject({ kind: 'tablet', os: 'Android' });
  });

  /*
   * Edge puts both "Chrome" and "Safari" in its UA, so the order the browser
   * tests run in is the whole of the logic here.
   */
  it('does not report Edge as Chrome', () => {
    pretendToBe(WINDOWS_EDGE);
    expect(describeThisDevice()).toMatchObject({ kind: 'desktop', os: 'Windows', browser: 'Edge' });
  });

  it('never claims to know this device address -- only the relay can', () => {
    pretendToBe(WINDOWS_EDGE);
    expect(describeThisDevice().ip).toBeUndefined();
  });

  it('keeps the same id across calls, so a device stays recognisable', () => {
    pretendToBe(WINDOWS_EDGE);
    workingStorage();
    expect(describeThisDevice().id).toBe(describeThisDevice().id);
  });

  it('mints a fresh id per page when storage is unavailable, rather than throwing', () => {
    pretendToBe(WINDOWS_EDGE);
    // What Safari does in a private window, and what a blocked-site-data
    // policy does everywhere: not an empty store, an access that throws.
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    });
    expect(() => describeThisDevice()).not.toThrow();
    expect(describeThisDevice().id).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){2}$/);
  });
});
