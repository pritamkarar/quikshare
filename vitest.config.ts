import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // vitest.config.ts is a separate config file from vite.config.ts, so it is
  // not merged with the app's Vite config — Vitest uses this file's plugins
  // exclusively. Without the React plugin here, .tsx test files fall back to
  // esbuild's classic JSX transform, which emits `React.createElement(...)`
  // calls with no `React` in scope (this project's components use the
  // automatic runtime and never import React), failing every test that
  // renders a component with "ReferenceError: React is not defined".
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: false,
    // UI tests opt into jsdom per-file via a `// @vitest-environment jsdom`
    // docblock at the top of the file (environmentMatchGlobs is deprecated
    // in Vitest 3). setupFiles runs for every test file regardless of
    // environment; tests/ui/setup.ts guards its DOM-only work (jest-dom
    // matchers, @testing-library/react cleanup) so it stays a no-op for the
    // node-environment tests that make up most of the suite.
    setupFiles: ['tests/ui/setup.ts'],
  },
});
