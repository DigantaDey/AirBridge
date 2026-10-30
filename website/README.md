# AirBridge website

This directory is the standalone static marketing site. It is separate from the
Node service and React client; GitHub Pages can host the site, but cannot run the
AirBridge service or its WebSocket backend.

## Preview locally

From the repository root, run `python3 -m http.server 8000 --directory website`
and open `http://localhost:8000`.

## Publish on GitHub Pages

`workflow_dispatch` also works: Actions → **Deploy website to GitHub Pages** →
*Run workflow*.

> **Only `pages.yml` may deploy Pages.** Never upload the repository root from
> a Pages workflow. `static.yml` used to do exactly that; the root `index.html`
> is the Vite dev shell (`<div id="root">` + `/src/client/main.tsx`), so the
> custom domain served a blank page. `pages.yml` publishes `website/` only and
> fails the build if a dev shell or absolute asset path appears.

1. Merge the website and `.github/workflows/pages.yml` into `main`.
2. In the GitHub repository, open **Settings → Pages → Build and deployment** and
   select **GitHub Actions** as the source. The workflow runs when website files
   change on `main`; it can also be started from Actions using **Run workflow**.
3. For the custom domain, set `airbridge.fyi` in **Settings → Pages → Custom
   domain**. `website/CNAME` preserves that domain in the deployed artifact.
4. At Cloudflare, configure the apex domain's DNS according to GitHub's current
   [custom domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
   Follow GitHub's domain verification guidance, wait for the DNS check and enable
   **Enforce HTTPS** once available. Do not remove or replace the existing email
   routing MX/TXT records; website DNS and email routing are separate.

If you want to use the default `github.io` address instead, remove
`website/CNAME` and any custom domain setting before deploying. All site asset
paths are relative, so the site works under a repository subpath as well.
