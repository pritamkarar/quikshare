// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppHeader, REPO_URL } from '../../client/ui/AppHeader.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AppHeader', () => {
  // `replaceState`, not `pushState`: going home replaces the entry it leaves
  // rather than stacking one on top of it, so Back cannot walk into the
  // session the user just left (see `leaveTo`).
  it('links the product name home without a full page load', async () => {
    const replaceState = vi.spyOn(history, 'replaceState');
    render(<AppHeader />);
    await userEvent.click(screen.getByRole('link', { name: /quik share/i }));
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  /*
   * A real <a href>, not a div with a click handler, is what makes
   * Cmd/Ctrl/middle-click work -- and the router must stay out of the way
   * when the browser is being asked to open a new tab.
   */
  it('leaves a modified click to the browser', () => {
    const replaceState = vi.spyOn(history, 'replaceState');
    render(<AppHeader />);
    // fireEvent rather than userEvent: a held modifier in userEvent's
    // keyboard state does not reach a separately-issued click, so the flag
    // has to be put on the event itself for the handler to see it.
    fireEvent.click(screen.getByRole('link', { name: /quik share/i }), { metaKey: true });
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('points at the repository, in a new tab, and says so', () => {
    render(<AppHeader />);
    const link = screen.getByRole('link', { name: /github/i });
    expect(link).toHaveAttribute('href', REPO_URL);
    expect(link).toHaveAttribute('target', '_blank');
    // noopener is the security half: without it the opened page gets a live
    // `window.opener` handle back to this one.
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link).toHaveAccessibleName(/opens in a new tab/i);
  });

  /*
   * The header must not introduce a second heading above each screen's own
   * <h1>, or every page's heading order starts one level down.
   */
  it('adds no heading of its own', () => {
    render(<AppHeader />);
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
  });
});
