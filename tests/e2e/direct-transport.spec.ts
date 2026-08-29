import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { closePair, makeFixture, pair } from './helpers.js';

/*
 * The regression test for the bug that made this whole change necessary.
 *
 * Session runs in a dedicated Web Worker. RTCPeerConnection is
 * [Exposed=Window], so the upgrade guard in client/session.ts was always true
 * and the WebRTC data path never ran once in production — every session was
 * permanently relayed and the Direct badge was unreachable.
 *
 * No unit or integration test could catch that: they stub RTCPeerConnection
 * into a realm that has one, which proves the negotiation algorithm and says
 * nothing about availability. Only a real browser, with a real worker realm
 * and no stubs, can. Both contexts here are on loopback, where a host
 * candidate pair is immediate — if this is ever Relayed, the upgrade is
 * broken again.
 */
test('the data path actually upgrades to a direct connection', async ({ browser }) => {
  // No forceTransport: the whole point is the unpinned, default path.
  const session = await pair(browser);
  try {
    await expect(session.host.page.getByText(/^direct$/i)).toBeVisible({ timeout: 20_000 });
    await expect(session.guest.page.getByText(/^direct$/i)).toBeVisible({ timeout: 20_000 });
  } finally {
    await closePair(session);
  }
});

test('a file crosses byte-identically once the path is Direct', async ({ browser }) => {
  const fixture = makeFixture(3 * 1024 * 1024);
  const session = await pair(browser);
  const { host, guest } = session;

  try {
    // Asserted BEFORE the transfer, not after: this is what separates this
    // test from the existing 'auto' case in transfer.spec.ts, which sends the
    // same bytes but deliberately never checks which transport carried them —
    // and therefore passed happily throughout the entire period WebRTC was
    // dead. Checked on both peers, like the first test above: it's the same
    // connection, but there's no reason to assert it asymmetrically.
    await expect(host.page.getByText(/^direct$/i)).toBeVisible({ timeout: 20_000 });
    await expect(guest.page.getByText(/^direct$/i)).toBeVisible({ timeout: 20_000 });

    const downloadPromise = guest.page.waitForEvent('download', { timeout: 45_000 });
    await host.page.getByRole('button', { name: /choose files/i }).click();
    await host.page.locator('input[type="file"]').setInputFiles(fixture.path);

    const download = await downloadPromise;
    const savedPath = await download.path();
    expect(savedPath).not.toBeNull();
    expect(Buffer.compare(readFileSync(savedPath!), fixture.bytes)).toBe(0);

    // The sender's own row, over a real data channel. "Sent" is a claim
    // about the other device now — it waits for the peer's `file-ack`
    // (shared/messages.ts) rather than for this side's last write — so the
    // badge only appears if that frame made the return trip through a real
    // SCTP channel, which is precisely what no in-process test can prove.
    await expect(host.page.getByText('Sent', { exact: true })).toBeVisible({ timeout: 20_000 });
  } finally {
    await closePair(session);
  }
});
