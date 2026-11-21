# AirBridge website

This directory is the standalone static marketing site served at
[airbridge.fyi](https://airbridge.fyi). It is separate from the Node service and
React client; GitHub Pages can host the site, but cannot run the AirBridge
service or its WebSocket backend.

## Pages

| File | Purpose |
| :--- | :--- |
| `index.html` | Landing page: capabilities, screenshots, comparison, security, install, FAQ. Hand-written. |
| `download.html` | Per-platform download table, install commands, verification steps. Generated. |
| `compare.html` | Honest comparison with LocalSend, KDE Connect, AirDroid, LinkMyMac, Quick Share and AirDrop. Generated. |
| `guides.html` | Hub for the search-intent guides. Generated. |
| `android-to-mac-file-transfer.html` | Android → macOS file transfer. Generated. |
| `android-to-windows-file-transfer.html` | Android → Windows file transfer. Generated. |
| `android-to-linux-file-transfer.html` | Android → Linux file transfer. Generated. |
| `android-airdrop-alternative.html` | What an AirDrop replacement for Android can and cannot do. Generated. |
| `android-clipboard-sync.html` | Clipboard sync, including Android’s background-clipboard limits. Generated. |
| `android-screen-sharing.html` | Consent-based H.264 screen viewing. Generated. |
| `open-source-airdrop-alternative.html` | Source availability, licence reality, self-hosted relay. Generated. |
| `private-file-transfer.html` | Privacy model, threat model and disclosures. Generated. |
| `privacy.html` | Privacy policy. Hand-written. |
| `404.html` | Not-found page (`noindex`). Hand-written. |
| `sitemap.xml` | Generated from the same page list. |
| `robots.txt` | Allows crawling and points at the sitemap. Hand-written. |
| `og.png` | 1200×630 Open Graph / Twitter card image built from a real screenshot. |

## Editing the generated pages

Guide content lives in `scripts/site-pages/` — one module per topic area — and is
rendered by `scripts/build-site-pages.mjs` into plain static HTML. Do not edit the
generated `.html` files directly; CI fails if `website/` is stale after a push.

```bash
npm run website:pages   # regenerate every page in the table above plus sitemap.xml
```

Each page carries its own `<title>`, meta description, canonical URL, Open Graph
and Twitter card metadata, and `WebPage` / `BreadcrumbList` / `FAQPage` structured
data. All links and asset paths stay relative so the site works from a Pages
subpath.

### Rules for new pages

- Every claim must be backed by the repository (README, `docs/`, source). If a
  feature has a platform limit, state it on the page.
- No fabricated ratings, download counts, testimonials or “unhackable” claims.
- Keep one `<h1>` per page and a logical `h2`/`h3` order.
- Give every image real `alt` text; no absolute asset paths.
- Add the page to `PAGES` in `scripts/site-pages/index.mjs` so the sitemap and
  navigation stay consistent.

## Preview locally

From the repository root:

```bash
python3 -m http.server 8000 --directory website
```

Then open `http://localhost:8000`. Check a narrow window too: the layout must not
scroll horizontally, and tables must stay inside their wrapper.

## Publish on GitHub Pages

`workflow_dispatch` also works: Actions → **Deploy website to GitHub Pages** →
*Run workflow*.

> **Only `pages.yml` may deploy Pages.** Never upload the repository root from
> a Pages workflow. `static.yml` used to do exactly that; the root `index.html`
> is the Vite dev shell (`<div id="root">` + `/src/client/main.tsx`), so the
> custom domain served a blank page. `pages.yml` publishes `website/` only and
> fails the build if a dev shell, an absolute asset path, a missing canonical URL
> or stale generated pages appear.

1. Merge the website and `.github/workflows/pages.yml` into `main`.
2. In the GitHub repository, open **Settings → Pages → Build and deployment** and
   select **GitHub Actions** as the source. The workflow runs when website files
   (or the generator scripts) change on `main`; it can also be started from
   Actions using **Run workflow**.
3. For the custom domain, set `airbridge.fyi` in **Settings → Pages → Custom
   domain**. `website/CNAME` preserves that domain in the deployed artifact.
4. At Cloudflare, configure the apex domain's DNS according to GitHub's current
   [custom domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
   Follow GitHub's domain verification guidance, wait for the DNS check and enable
   **Enforce HTTPS** once available. Do not remove or replace the existing email
   routing MX/TXT records; website DNS and email routing are separate.
5. After the first deploy of the new pages, confirm `https://airbridge.fyi/sitemap.xml`
   loads, then submit the sitemap in Google Search Console and Bing Webmaster Tools.

If you want to use the default `github.io` address instead, remove
`website/CNAME` and any custom domain setting before deploying. All site asset
paths are relative, so the site works under a repository subpath as well.
