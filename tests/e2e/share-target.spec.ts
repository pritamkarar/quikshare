import { expect, test } from '@playwright/test';
import { confirmVerification } from './helpers.js';

/*
 * The manifest's share target is a plain multipart form POST to a path inside
 * the service worker's scope, so submitting exactly that form from the page is
 * byte-for-byte what Chrome's share sheet does. Everything downstream is the
 * real code path — the worker branch, the stash, the 303, the claim, the
 * verification gate, the transfer. Only the OS launch is simulated.
 */
test('a file shared from the OS sends itself once both devices confirm the number', async ({ browser }) => {
  const hostContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  try {
    // The worker has to be *controlling* before it can intercept anything —
    // registration alone is not enough (client/save/swstream.ts).
    await host.goto('/new');
    await host.waitForFunction(async () => {
      await navigator.serviceWorker.ready;
      return navigator.serviceWorker.controller !== null;
    }, undefined, { timeout: 20_000 });

    await host.evaluate(() => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/share-target';
      form.enctype = 'multipart/form-data';
      const files = document.createElement('input');
      files.type = 'file';
      files.name = 'files';
      files.id = 'shared-files';
      form.append(files);
      const url = document.createElement('input');
      url.name = 'url';
      url.value = 'https://example.invalid/holiday';
      form.append(url);
      document.body.append(form);
    });
    await host.setInputFiles('#shared-files', {
      name: 'holiday.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('sent from the share sheet'),
    });
    await Promise.all([
      host.waitForURL(/\/new$/),
      host.evaluate(() => (document.querySelector('form') as HTMLFormElement).submit()),
    ]);

    // Staged, named, and explicitly not sent yet.
    await expect(host.getByText(/1 file and 1 link ready/i)).toBeVisible();

    await host.getByRole('button', { name: /copy link/i }).click();
    const shareUrl = await host.evaluate(() => navigator.clipboard.readText());
    await guest.goto(shareUrl.replace(/^https?:\/\/[^/]+/, ''));

    await expect(host.getByText(/connected/i)).toBeVisible({ timeout: 20_000 });
    await expect(guest.getByText(/connected/i)).toBeVisible({ timeout: 20_000 });

    await confirmVerification(host, guest);

    // Nobody chose a file on either screen. Confirming the number is the only
    // thing that happened, and the share sent itself.
    await expect(guest.getByText('holiday.txt')).toBeVisible({ timeout: 30_000 });
    await expect(guest.getByText('https://example.invalid/holiday')).toBeVisible();
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});
