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

  it('keeps every hardcoded copy of the canonical site origin in agreement', () => {
    // The origin is written out by hand in four places, because each is read
    // by something that cannot call a function: two static files, a <link>
    // and <meta> block that must be right before any JavaScript runs, and the
    // constant client/App.tsx rewrites them from. Centralising it would mean
    // generating the static files at build time to save four literals, so
    // this test is the trade instead — it catches the failure that actually
    // happens, which is one copy drifting to http://, to a www. host, or to
    // a platform's default subdomain, and thereby splitting the site's
    // ranking across two origins with no visible symptom.
    const ORIGIN = 'https://quikshare.qd.je';

    // Anything in client/public is copied to the origin root by Vite, which
    // is the only place a crawler will look for these two.
    for (const name of ['robots.txt', 'sitemap.xml', 'og.png']) {
      expect(
        existsSync(new URL(`../../client/public/${name}`, import.meta.url)),
        `client/public/${name} must exist to be served from the origin root`,
      ).toBe(true);
    }

    const sources: [string, string][] = [
      ['client/index.html', read('../../client/index.html')],
      ['client/routing.ts', read('../../client/routing.ts')],
      ['client/public/robots.txt', read('../../client/public/robots.txt')],
      ['client/public/sitemap.xml', read('../../client/public/sitemap.xml')],
    ];

    for (const [name, text] of sources) {
      expect(text, `${name} must name the canonical origin`).toContain(ORIGIN);
      const strays = [...text.matchAll(/https?:\/\/[a-z0-9.-]*quikshare[a-z0-9.-]*/gi)]
        .map((match) => match[0]!)
        .filter((url) => url !== ORIGIN);
      expect(strays, `${name} names an origin other than ${ORIGIN}`).toEqual([]);
    }
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
