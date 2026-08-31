# Off-page playbook

The on-page work is done and lives in the repo: `client/index.html` (title,
description, Open Graph, Twitter card, `SoftwareApplication` JSON-LD),
`client/public/robots.txt` and `sitemap.xml`, the `X-Robots-Tag: noindex` on
`/s/:code` in `server/index.ts`, and the social card at `client/public/og.png`
drawn by `scripts/make-icons.py`.

None of what follows can be done from here — it needs accounts, and it needs
to be you posting rather than a tool posting as you. It is ordered by effect
per hour spent, and the copy is written to be pasted.

## 0. Before anything else

Nothing below is worth doing until these two are true, because both submission
and search reward a link that unfurls.

1. **Verify the social card renders.** Paste `https://quikshare.qd.je` into
   the [Facebook sharing debugger](https://developers.facebook.com/tools/debug/)
   and [X's card validator](https://cards-dev.twitter.com/validator). Both
   cache aggressively — scrape once now so the first real share is not the
   thing that populates the cache.
2. **Register the site in Google Search Console** (`search.google.com/search-console`),
   verify by DNS TXT on `qd.je`, and submit `https://quikshare.qd.je/sitemap.xml`.
   Do the same at Bing Webmaster Tools, which will import the Google
   verification. Without this you are guessing at what indexed and what did
   not. Repeat the sitemap submission after any change to the route list.

## 1. The GitHub repository

The repo is likely to outrank the app itself for a while — it has the domain
authority the new site does not — so treat it as a second landing page.

- **Description** (the field at the top right of the repo page, which is what
  Google shows for the repo in search results):

  > Send files between two devices with a link or a QR code. End-to-end
  > encrypted, peer-to-peer over WebRTC, no account, no upload, no size limit.

- **Topics.** These are how people browsing GitHub by tag find it, and they
  are matched exactly, so use the terms people search rather than the terms
  the code uses:

  `file-transfer` `file-sharing` `p2p` `webrtc` `peer-to-peer`
  `end-to-end-encryption` `qr-code` `send-files` `airdrop-alternative`
  `no-upload` `self-hostable` `pwa` `typescript` `react` `fastify`

- **Website field**: `https://quikshare.qd.je`. It becomes a followed link
  from a high-authority domain, which is the single easiest backlink available.
- Add the social card to the repo too: Settings → Social preview → upload
  `client/public/og.png`.

## 2. Directory and aggregator submissions

Ranked. The first four are worth doing this week; the rest are a long tail you
can work through whenever.

| Where | Why it is worth it | Notes |
|---|---|---|
| **AlternativeTo** | Ranks for "WeTransfer alternative", "Snapdrop alternative" — the queries with actual intent | List it *as* an alternative to WeTransfer, Snapdrop, PairDrop, Send Anywhere, Firefox Send |
| **Product Hunt** | One day of traffic, a permanent do-follow link, and it gets scraped by a dozen other directories | Launch Tue–Thu; have the GIF ready first (see §4) |
| **Hacker News (Show HN)** | The highest-variance item here; the crypto design is the story | Post the *repo*, not the site. Title: `Show HN: Quik Share – encrypted browser-to-browser file transfer, no upload` |
| **r/selfhosted, r/privacy, r/webdev** | Durable, and these threads rank | Read each rule page first; a self-promo post that gets removed costs you the subreddit permanently |
| Awesome lists | Long-lived backlinks | PR into `awesome-selfhosted`, `awesome-privacy`, `awesome-webrtc` |
| Slant, SaaSHub, Openbase, Libhunt | Low effort, mild authority | Copy from the repo description |
| Lobste.rs | Smaller than HN, better signal | Needs an invite |
| Indie Hackers, DevHunt, Uneed, Peerlist | Small but free | Batch them into one sitting |

**Submission copy** (fits every field limit above):

> **Short (60 chars):** Encrypted file transfer between two devices, no upload.
>
> **Medium (160 chars):** Open one page on both devices. A six-character code
> or a QR pairs them, the browsers agree a key directly, and the file goes
> straight across — encrypted, no account, no size limit.
>
> **Long:** Quik Share moves a file from one device to another with a link and
> a QR code. There is no account, no install and no upload: the two browsers
> agree an encryption key between themselves and send the file directly over
> WebRTC where the network allows it, falling back to a relay that only ever
> carries ciphertext where it does not. Both screens show the same six-digit
> number derived from the shared secret, so you can confirm nothing sat in the
> middle. Files stream to disk as they arrive, so size is bounded by the disk
> and not by memory. It also carries a live camera or screen share. Nothing is
> stored anywhere, and closing the tab ends it.

## 3. The queries worth owning

Aim the copy above at these. They are long-tail on purpose — the head terms
("file transfer") are owned by companies with budgets, and these are where the
intent is anyway:

- send large file from phone to laptop *(no account / without email)*
- transfer files between two devices without cloud
- WeTransfer alternative no signup / no upload
- Snapdrop alternative that works over the internet
- encrypted file transfer browser to browser
- share screen between two devices without an app

Right now the landing page has no copy answering these directly. That is the
next on-page increment when you want it: an FAQ section on `/` with a
`FAQPage` JSON-LD block, which is also the cheapest route to a rich result.

## 4. Assets to make once

- **A 15-second silent GIF or MP4** of the real flow: phone scans the QR, file
  lands on the laptop. Product Hunt, the README and every Reddit post all want
  it and it is the single asset that converts. Put it at the top of the README.
- A one-paragraph "how the encryption works" write-up, lifted from the README,
  to paste into the HN thread when someone asks — and someone will.

## 5. What not to do

Paid directory listings, link exchanges, and any "submit to 500 sites"
service. They are ignored at best, and at worst they are the one thing that
can actively hurt a clean new domain.
