// tests/integration/production-build.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(relPath: string): string {
  return readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

describe('production artifacts', () => {
  it("has a Dockerfile whose CMD entry matches the start script's entry", () => {
    expect(existsSync(new URL('../../Dockerfile', import.meta.url))).toBe(true);

    const dockerfile = read('../../Dockerfile');
    const cmdMatch = dockerfile.match(/CMD\s*\[\s*"node"\s*,\s*"([^"]+)"\s*]/);
    expect(cmdMatch, 'Dockerfile must run the server with CMD ["node", "<entry>"]').not.toBeNull();
    const cmdEntry = cmdMatch![1]!;

    const pkg = JSON.parse(read('../../package.json')) as { scripts?: Record<string, string> };
    const start = pkg.scripts?.start;
    expect(start, 'package.json must define a "start" script').toBeTruthy();
    // If either the Dockerfile's CMD or the start script's entry file changes
    // without the other, this fails — a plain existsSync check would not
    // notice the two had drifted apart.
    expect(start).toContain(cmdEntry);
  });

  it('documents every environment variable the server and client actually read', () => {
    expect(existsSync(new URL('../../docs/deployment.md', import.meta.url))).toBe(true);
    const doc = read('../../docs/deployment.md');

    // Variables the running server reads from process.env — derived from the
    // real source, not hand-copied, so a newly-added or removed env var
    // forces this test (and thus the docs) to keep up.
    const serverSource = read('../../server/index.ts');
    const serverVars = [...serverSource.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]!);
    expect(new Set(serverVars)).toEqual(new Set(['PORT', 'HOST', 'NODE_ENV', 'TRUST_PROXY']));
    for (const name of serverVars) {
      expect(doc, `docs/deployment.md must document ${name}`).toContain(name);
    }

    // The one build-time client variable an operator must set before
    // building the client bundle.
    const clientSource = read('../../client/transport/webrtc.ts');
    const clientVars = [...clientSource.matchAll(/import\.meta\.env\.([A-Z_]+)/g)].map((m) => m[1]!);
    expect(clientVars).toContain('VITE_STUN_URLS');
    for (const name of clientVars) {
      expect(doc, `docs/deployment.md must document ${name}`).toContain(name);
    }
  });
});
