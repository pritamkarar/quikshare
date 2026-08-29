// tests/unit/entry-point-guard.test.ts
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, isDirectEntry, resolvePort, resolveTrustProxy } from '../../server/index.js';

describe('isDirectEntry (Ruling J)', () => {
  it('is true when argv[1] resolves to exactly this module\'s own file', () => {
    // Simulates `node dist/server/index.js`: a real file on disk (so
    // realpathSync succeeds) whose resolved URL matches moduleUrl exactly.
    const dir = mkdtempSync(join(tmpdir(), 'entry-guard-'));
    const file = join(dir, 'index.js');
    writeFileSync(file, '');
    const moduleUrl = pathToFileURL(realpathSync(file)).href;

    expect(isDirectEntry(file, moduleUrl)).toBe(true);
  });

  it('is false for a different file that merely shares the basename "index.js" — the exact case a suffix match gets wrong', () => {
    // Two distinct files in different directories, both named index.js: one
    // stands in for this module (moduleUrl), the other for some unrelated
    // process's own entry point (argv1) — e.g. a test runner. A *suffix*
    // match (`moduleUrl.endsWith(basename(argv1))`) is true here purely
    // because both happen to end in "index.js", which is exactly Ruling J's
    // bug: this module would bind a real port merely because whatever
    // imported it was itself invoked as some other index.js.
    const realDir = mkdtempSync(join(tmpdir(), 'entry-guard-real-'));
    const otherDir = mkdtempSync(join(tmpdir(), 'entry-guard-other-'));
    const realFile = join(realDir, 'index.js');
    const otherFile = join(otherDir, 'index.js');
    writeFileSync(realFile, '');
    writeFileSync(otherFile, '');
    const moduleUrl = pathToFileURL(realpathSync(realFile)).href;

    expect(isDirectEntry(otherFile, moduleUrl)).toBe(false);

    // Not a strawman: confirm the brief's original `endsWith` form really
    // would have fired on these exact inputs.
    const suffixMatchWouldFire = moduleUrl.endsWith(otherFile.split('/').pop()!);
    expect(suffixMatchWouldFire).toBe(true);
  });

  it('is false when there is no argv[1] at all', () => {
    expect(isDirectEntry(undefined, 'file:///anywhere/index.js')).toBe(false);
  });

  it('is false, rather than throwing at module load, for an argv[1] that is not a real path', () => {
    // realpathSync throws on a path that does not exist — a bare command
    // name resolved from PATH, a deleted file, a runner that puts something
    // other than a path in argv[1]. Unguarded, that took down the whole
    // process (or an importing test suite) at import time.
    expect(isDirectEntry(join(tmpdir(), 'definitely-not-here-9f3a', 'index.js'), 'file:///anywhere/index.js'))
      .toBe(false);
  });
});

describe('resolvePort', () => {
  it('defaults to 8787 when PORT is unset', () => {
    expect(resolvePort(undefined)).toBe(8787);
  });

  it('accepts a plain port number', () => {
    expect(resolvePort('3000')).toBe(3000);
  });

  it('fails loudly on an empty or zero PORT rather than binding an arbitrary ephemeral port', () => {
    // Number('') is 0 — an integer, and in range — which listen() happily
    // accepts and turns into a random free port nothing is proxying to.
    expect(() => resolvePort('')).toThrow(/PORT must be an integer/);
    expect(() => resolvePort('   ')).toThrow(/PORT must be an integer/);
    expect(() => resolvePort('0')).toThrow(/PORT must be an integer/);
  });

  it('fails loudly on a typo rather than treating NaN as port 0', () => {
    expect(() => resolvePort('87 87')).toThrow(/PORT must be an integer/);
    expect(() => resolvePort('8787.5')).toThrow(/PORT must be an integer/);
    expect(() => resolvePort('70000')).toThrow(/PORT must be an integer/);
  });
});

describe('resolveTrustProxy', () => {
  it('trusts nobody unless asked', () => {
    expect(resolveTrustProxy(undefined)).toBe(false);
    expect(resolveTrustProxy('')).toBe(false);
    expect(resolveTrustProxy('false')).toBe(false);
  });

  it('maps true to the loopback address, not to Fastify\'s trust-every-hop', () => {
    // Fastify's `true` returns the LEFTMOST X-Forwarded-For entry and trusts
    // every hop, which is spoofable behind any proxy that appends (Caddy's
    // reverse_proxy and nginx's $proxy_add_x_forwarded_for both do).
    expect(resolveTrustProxy('true')).toBe('loopback');
  });

  it('passes an address list through for a proxy that is not on this host', () => {
    expect(resolveTrustProxy('10.0.0.0/8,192.168.1.1')).toBe('10.0.0.0/8,192.168.1.1');
  });

  it('rejects a hop count outright, since ipaddr.js would silently read it as an address', () => {
    // The one wrong value an operator is most likely to type: every other
    // framework's `trust proxy` takes a hop count, and so did the fix this
    // setting replaced. Passed through, "1" parses as 0.0.0.1/32 — trusting
    // nobody, merging every client behind the proxy into one rate-limit
    // bucket, with no error and no log. Silently the exact outage this
    // setting exists to prevent, which is why it has to fail loudly.
    expect(() => resolveTrustProxy('1')).toThrow(/hop count/);
    expect(() => resolveTrustProxy('0')).toThrow(/hop count/);
    expect(() => resolveTrustProxy('2')).toThrow(/hop count/);
    // And it says what to do instead, rather than only what is wrong.
    expect(() => resolveTrustProxy('1')).toThrow(/Use true .*, false, or an IP\/CIDR list/);
  });

  it('tolerates the ordinary ways a boolean gets written into an environment', () => {
    // TRUE/False from a shell script, a trailing newline out of a heredoc or
    // an env file. None of these is a reason to refuse to boot, and all of
    // them used to hard-fail with `TypeError: invalid IP address: TRUE`.
    for (const yes of ['TRUE', 'True', 'true ', ' true', 'true\n']) {
      expect(resolveTrustProxy(yes), yes).toBe('loopback');
    }
    for (const no of ['FALSE', 'False', 'false ', '  ', '\n']) {
      expect(resolveTrustProxy(no), no).toBe(false);
    }
  });
});

describe('buildServer trust-proxy diagnostics', () => {
  const ORIGINAL = process.env.TRUST_PROXY;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = ORIGINAL;
  });

  it('names TRUST_PROXY when the address list is unparseable', async () => {
    // Fastify's own failure is a bare `TypeError: invalid IP address: nope`
    // with no mention of the setting that produced it.
    process.env.TRUST_PROXY = 'nope';
    await expect(buildServer()).rejects.toThrow(/TRUST_PROXY.*not a valid setting.*invalid IP address/s);
  });
});
