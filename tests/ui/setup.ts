import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// This file runs for every test in the suite regardless of environment (see
// vitest.config.ts), because there is no per-environment setupFiles split.
// `@testing-library/react`'s own auto-cleanup only self-registers against a
// *global* `afterEach`, which does not exist here since `globals: false` —
// so without this, `render()` output from one jsdom test leaks into the
// next test in the same file (e.g. two `<input>`s both matching
// `getByRole('textbox')`). Guarded on `document` so the same hook is a
// no-op for the node-environment tests that make up most of the suite,
// where there is no DOM to clean up and `cleanup()` would throw.
afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
});
