# Repository metadata (maintainer checklist)

GitHub's repository description, topics and homepage are set in the repository
settings, not in a file, so they cannot be shipped with a commit. Use this file as
the source of truth when you update them.

## Description

> Open-source, end-to-end encrypted Android ↔ Mac, Windows & Linux file transfer, clipboard sync, screen sharing and phone connectivity.

## Homepage URL

> https://airbridge.fyi

## Topics

```
android  macos  windows  linux  file-transfer  android-file-transfer
android-mac  android-windows  clipboard-sync  screen-sharing  webrtc
e2ee  privacy  open-source  airdrop-alternative  cross-platform  kotlin  typescript
```

## Social preview

Upload `.github/social-preview.png` (1200 × 630) under
**Settings → Social preview**. It is the same image the website uses for Open
Graph and Twitter/X cards, and it is built from a real screenshot of v2.5.0.

## Commands (require repository admin rights)

```bash
gh repo edit DigantaDey/AirBridge \
  --description "Open-source, end-to-end encrypted Android ↔ Mac, Windows & Linux file transfer, clipboard sync, screen sharing and phone connectivity." \
  --homepage "https://airbridge.fyi" \
  --add-topic android --add-topic macos --add-topic windows --add-topic linux \
  --add-topic file-transfer --add-topic android-file-transfer --add-topic android-mac \
  --add-topic android-windows --add-topic clipboard-sync --add-topic screen-sharing \
  --add-topic webrtc --add-topic e2ee --add-topic privacy --add-topic open-source \
  --add-topic airdrop-alternative --add-topic cross-platform --add-topic kotlin \
  --add-topic typescript
```

## Keeping the description honest

The description says “open-source” the way this project uses the term: the source
is public. The licence itself is the AirBridge Fair-Use & Non-Commercial License,
which is not OSI-approved — the README and `website/open-source-airdrop-alternative.html`
state that plainly, and the description should not imply otherwise.

## After the next website deploy

These are one-off actions outside the repository:

1. Open https://airbridge.fyi/sitemap.xml and confirm all twelve pages load.
2. Submit the sitemap in Google Search Console and Bing Webmaster Tools.
3. Request indexing for `/`, `/download.html`, `/guides.html` and the eight guide pages.
4. Validate the homepage and one guide page in the
   [Rich Results Test](https://search.google.com/test/rich-results) — the
   `SoftwareApplication`, `WebSite`, `WebPage`, `BreadcrumbList` and `FAQPage`
   blocks should all be recognised.
5. Re-check the link preview with a card validator (e.g. opengraph.xyz) after
   `og.png` is live.
