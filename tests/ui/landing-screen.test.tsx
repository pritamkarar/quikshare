// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LandingScreen } from '../../client/screens/LandingScreen.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LandingScreen', () => {
  /*
   * Twice each, and that is the point: the hero offers both actions to
   * someone who arrived already convinced, and the band closing the page
   * offers them again to someone who read the whole thing. Same two labels
   * both times — one label per intent, so "Start transfer/receive" is never
   * competing with a "Start sharing" that means the same thing.
   */
  it('offers both ways in, in the hero and again at the foot', () => {
    render(<LandingScreen />);
    expect(screen.getAllByRole('button', { name: /start transfer/i })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /join a device/i })).toHaveLength(2);
  });

  /*
   * The card row is the only place the landing page makes a claim about what
   * the product does, so a silent regression there is a page that undersells
   * or — worse — misdescribes itself. Live camera and screen sharing shipped
   * without ever reaching this list, which is the failure this pins: a
   * headline capability the front page did not mention at all.
   */
  it('names every capability it claims, including live media', () => {
    render(<LandingScreen />);
    // Scoped to the named list: the page has a second one (the three-step
    // rail), so a bare getAllByRole('listitem') now counts nine items and
    // would fail for a reason that has nothing to do with what this asserts.
    const grid = screen.getByRole('list', { name: /what quik share does/i });
    const cards = within(grid).getAllByRole('listitem');
    expect(cards).toHaveLength(6);

    // h3, not h2: each section on this page owns the one h2 its own heading
    // provides, and a card inside it sits a level below that.
    const titles = cards.map((card) => card.querySelector('h3')?.textContent);
    // Order is the grid's reading order, which is also its visual order: the
    // filled, double-height cell carrying the encryption claim comes first.
    expect(titles).toEqual([
      'Encrypted end to end',
      'Camera and screen, live',
      'No account, no install',
      'No size limit',
      'Direct when it can be',
      'Know both devices',
    ]);
  });

  /*
   * Claims the page can no longer honestly make. Dropping a folder does
   * nothing — DropZone reads `dataTransfer.files` and its input carries no
   * `webkitdirectory` — and the device cards stopped rendering an address.
   * Both sentences survived the features that invalidated them, which is
   * exactly the drift a list of nice words about a product accumulates.
   */
  it('does not claim what the app cannot do', () => {
    const { container } = render(<LandingScreen />);
    expect(container.textContent).not.toMatch(/folders/i);
    expect(container.textContent).not.toMatch(/connecting address/i);
  });

  /*
   * The whole reason this screen exists. CreateScreen allocates a room on the
   * relay as it mounts, so '/' used to consume a room code and a create
   * rate-limit slot on every page load. Rendering this screen must reach the
   * network not at all.
   */
  it('starts no session merely by being shown', () => {
    const socket = vi.fn();
    vi.stubGlobal('WebSocket', socket);
    vi.stubGlobal('Worker', vi.fn());
    render(<LandingScreen />);
    expect(socket).not.toHaveBeenCalled();
  });

  it('routes to /new rather than creating in place', async () => {
    const pushState = vi.spyOn(history, 'pushState');
    render(<LandingScreen />);
    await userEvent.click(screen.getAllByRole('button', { name: /start transfer/i })[0]!);
    expect(pushState).toHaveBeenCalledWith(null, '', '/new');
  });

  it('routes to /join', async () => {
    const pushState = vi.spyOn(history, 'pushState');
    render(<LandingScreen />);
    await userEvent.click(screen.getAllByRole('button', { name: /join a device/i })[0]!);
    expect(pushState).toHaveBeenCalledWith(null, '', '/join');
  });

  it('has exactly one h1, so the page has a single document title', () => {
    render(<LandingScreen />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  /*
   * getAllByText, not getByText: both claims are deliberately made twice, in
   * the hero and again in the section that substantiates them, which is this
   * page's house style — the closing band restates "No account, no install"
   * as "No sign-in" the same way. A singular query here was asserting the
   * claim is on the page while quietly also asserting it is made exactly
   * once, and only the first of those is something this test means.
   */
  it('says what the product does without requiring a session first', () => {
    render(<LandingScreen />);
    expect(screen.getAllByText(/no account|no sign-in/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/encrypted end to end/i).length).toBeGreaterThan(0);
  });
});
