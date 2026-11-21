/**
 * Renders the static search-intent pages of the airbridge.fyi website.
 *
 * The marketing site in `website/` is hand-written HTML published by GitHub
 * Pages (see `.github/workflows/pages.yml`). Guide pages share the same shell,
 * so they are generated from `scripts/site-pages/` instead of being copy-pasted
 * eleven times. Everything is emitted as plain static HTML — the deployed site
 * keeps its existing no-JavaScript, CSP-locked behaviour.
 *
 * Usage: npm run website:pages
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, SITE } from './site-pages/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEBSITE = join(ROOT, 'website');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

const bySlug = new Map(PAGES.map((page) => [page.slug, page]));

export function urlFor(slug) {
  return slug === 'index' ? `${SITE.baseUrl}/` : `${SITE.baseUrl}/${slug}.html`;
}

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function jsonLdScript(data) {
  // JSON inside a <script> block: escape the two sequences that could end it.
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `  <script type="application/ld+json">\n  ${json}\n  </script>`;
}

function iconLibrary() {
  return `<svg class="icon-library" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <symbol id="arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
  <symbol id="lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2"/></symbol>
  <symbol id="devices" viewBox="0 0 24 24"><rect x="3" y="4" width="13" height="11" rx="1.5"/><path d="M2 18h15"/><rect x="17" y="9" width="5" height="10" rx="1"/></symbol>
</svg>`;
}

function header() {
  return `<header class="header">
  <nav class="nav wrap" aria-label="Main navigation">
    <div class="brand-group">
      <a class="brand" href="index.html" aria-label="AirBridge home"><img src="icon.svg" alt=""><span>AirBridge<span class="brand-dot">.</span></span></a>
      <span class="version-pill">v${esc(VERSION)}</span>
    </div>
    <div class="nav-links">
      <a href="index.html#features">Capabilities</a>
      <a href="guides.html">Guides</a>
      <a href="compare.html">Compare</a>
      <a href="index.html#security">Security</a>
      <a href="download.html">Download</a>
      <a href="index.html#faq">FAQ</a>
    </div>
    <a class="nav-cta" href="${SITE.repoUrl}">GitHub <svg class="icon" aria-hidden="true"><use href="#arrow"/></svg></a>
  </nav>
</header>`;
}

function footer() {
  const links = SITE.footerGuides
    .map((slug) => {
      const page = bySlug.get(slug);
      return `      <a href="${slug}.html">${esc(page ? page.shortTitle : slug)}</a>`;
    })
    .join('\n');
  return `<footer class="legal-footer"><div class="wrap">
    <p class="footer-guide-links"><strong>Guides</strong></p>
    <div class="footer-guide-grid">
${links}
      <a href="download.html">Download &amp; install</a>
      <a href="compare.html">Honest comparison</a>
      <a href="privacy.html">Privacy policy</a>
    </div>
    <p>© AirBridge · <a href="index.html">Home</a> · <a href="${SITE.repoUrl}">Source code on GitHub</a> · <a href="${SITE.repoUrl}#readme">README</a></p>
  </div></footer>`;
}

function breadcrumbs(items) {
  const list = items
    .map((item, index) => {
      const isLast = index === items.length - 1;
      const label = isLast
        ? `<span aria-current="page">${esc(item.name)}</span>`
        : `<a href="${item.href}">${esc(item.name)}</a>`;
      return `      <li>${label}</li>`;
    })
    .join('\n');
  return `<nav class="breadcrumb" aria-label="Breadcrumb">
    <ol>
${list}
    </ol>
  </nav>`;
}

function faqBlock(faqs) {
  if (!faqs || faqs.length === 0) return '';
  const items = faqs
    .map(
      (faq) => `      <details>
        <summary>${faq.q}<span aria-hidden="true">＋</span></summary>
        <p>${faq.a}</p>
      </details>`,
    )
    .join('\n');
  return `<section class="faq-block" aria-labelledby="questions">
      <h2 id="questions">Questions about this guide</h2>
      <div class="faq-list">
${items}
      </div>
    </section>`;
}

function relatedBlock(slugs) {
  const cards = (slugs || [])
    .map((slug) => bySlug.get(slug))
    .filter(Boolean)
    .map(
      (page) => `        <li><a href="${page.slug}.html"><strong>${esc(page.shortTitle)}</strong><span>${esc(page.cardBlurb)}</span></a></li>`,
    )
    .join('\n');
  if (!cards) return '';
  return `<section class="related-block" aria-labelledby="related">
      <h2 id="related">Related AirBridge guides</h2>
      <ul class="related-list">
${cards}
      </ul>
    </section>`;
}

function downloadCta() {
  return `<aside class="guide-cta" aria-label="Download AirBridge">
      <div>
        <p class="section-label"><span>GET AIRBRIDGE</span> FREE FOR PERSONAL USE</p>
        <h2>Install on your computer, then pair your phone.</h2>
        <p>Official builds for macOS, Windows and Linux live on the GitHub releases page, next to the Android APK and the <code>SHA256SUMS.txt</code> checksums. Nothing needs an account.</p>
      </div>
      <div class="guide-cta-actions">
        <a class="button button-dark" href="${SITE.releasesUrl}">Download v${esc(VERSION)} <svg class="icon" aria-hidden="true"><use href="#arrow"/></svg></a>
        <a class="button button-secondary" href="download.html">All platforms</a>
      </div>
    </aside>`;
}

function sectionHtml(sections) {
  return sections
    .map(
      (section) => `      <h2${section.id ? ` id="${section.id}"` : ''}>${section.h2}</h2>
${section.html}`,
    )
    .join('\n\n');
}

function renderPage(page) {
  const canonical = urlFor(page.slug);
  const breadcrumbItems = [
    { name: 'AirBridge', href: 'index.html' },
    { name: 'Guides', href: 'guides.html' },
    { name: page.shortTitle, href: `${page.slug}.html` },
  ];
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: page.title,
      description: page.description,
      url: canonical,
      inLanguage: 'en',
      isPartOf: { '@type': 'WebSite', name: 'AirBridge', url: `${SITE.baseUrl}/` },
      about: {
        '@type': 'SoftwareApplication',
        name: 'AirBridge',
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Android, macOS, Windows, Linux',
        url: `${SITE.baseUrl}/`,
        downloadUrl: SITE.releasesUrl,
      },
      primaryImageOfPage: page.image ? { '@type': 'ImageObject', url: `${SITE.baseUrl}/${page.image}` } : undefined,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: breadcrumbItems.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.name,
        item: item.href.startsWith('http')
          ? item.href
          : item.href === 'index.html'
            ? `${SITE.baseUrl}/`
            : `${SITE.baseUrl}/${item.href}`,
      })),
    },
    page.faqs && page.faqs.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: page.faqs.map((faq) => ({
            '@type': 'Question',
            name: faq.q.replace(/<[^>]+>/g, ''),
            acceptedAnswer: { '@type': 'Answer', text: faq.a.replace(/<[^>]+>/g, '') },
          })),
        }
      : null,
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${CSP}">
  <meta name="theme-color" content="#f7f8f7">
  <meta name="description" content="${esc(page.description)}">
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="AirBridge">
  <meta property="og:locale" content="en">
  <meta property="og:title" content="${esc(page.title)}">
  <meta property="og:description" content="${esc(page.description)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${SITE.baseUrl}/og.png">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="AirBridge — Android to Mac, Windows and Linux file transfer, clipboard sync and screen sharing">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(page.title)}">
  <meta name="twitter:description" content="${esc(page.description)}">
  <meta name="twitter:image" content="${SITE.baseUrl}/og.png">
  <meta name="twitter:image:alt" content="AirBridge — Android to Mac, Windows and Linux file transfer, clipboard sync and screen sharing">
${jsonLd.map(jsonLdScript).join('\n')}
  <link rel="icon" href="icon.svg" type="image/svg+xml">
  <link rel="icon" href="favicon-32.png" sizes="32x32" type="image/png">
  <link rel="apple-touch-icon" href="apple-touch-icon.png">
  <link rel="stylesheet" href="styles.css">
  <title>${esc(page.title)}</title>
</head>
<body id="top">
<a class="skip-link" href="#main">Skip to main content</a>
${iconLibrary()}
${header()}

<main class="legal wrap guide" id="main">
    <article class="legal-card">
      ${breadcrumbs(breadcrumbItems)}
      <p class="section-label"><span>GUIDE</span> ${esc(page.kicker)}</p>
      <h1>${page.h1}</h1>
      <p class="guide-lede">${page.lede}</p>
${page.image ? `      <figure class="guide-figure${page.imageHeight > page.imageWidth ? ' guide-figure-phone' : ''}">
        <img src="${page.image}" width="${page.imageWidth || 1600}" height="${page.imageHeight || 905}" alt="${esc(page.imageAlt)}" loading="lazy" decoding="async">
        <figcaption>${esc(page.imageCaption)}</figcaption>
      </figure>` : ''}
      <div class="guide-body">
${sectionHtml(page.sections)}
      </div>
${faqBlock(page.faqs)}
${downloadCta()}
${relatedBlock(page.related)}
    </article>
</main>
${footer()}
</body>
</html>
`;
}

function renderHub() {
  const hub = bySlug.get('guides');
  const cards = PAGES.filter((page) => page.group === 'guide')
    .map(
      (page) => `        <li><a href="${page.slug}.html"><strong>${esc(page.shortTitle)}</strong><span>${esc(page.cardBlurb)}</span></a></li>`,
    )
    .join('\n');
  const canonical = urlFor('guides');
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: hub.title,
      description: hub.description,
      url: canonical,
      inLanguage: 'en',
      isPartOf: { '@type': 'WebSite', name: 'AirBridge', url: `${SITE.baseUrl}/` },
      hasPart: PAGES.filter((page) => page.group === 'guide').map((page) => ({
        '@type': 'WebPage',
        name: page.title,
        description: page.description,
        url: urlFor(page.slug),
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'AirBridge', item: `${SITE.baseUrl}/` },
        { '@type': 'ListItem', position: 2, name: 'Guides', item: canonical },
      ],
    },
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${CSP}">
  <meta name="theme-color" content="#f7f8f7">
  <meta name="description" content="${esc(hub.description)}">
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="AirBridge">
  <meta property="og:locale" content="en">
  <meta property="og:title" content="${esc(hub.title)}">
  <meta property="og:description" content="${esc(hub.description)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${SITE.baseUrl}/og.png">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="AirBridge — Android to Mac, Windows and Linux file transfer, clipboard sync and screen sharing">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(hub.title)}">
  <meta name="twitter:description" content="${esc(hub.description)}">
  <meta name="twitter:image" content="${SITE.baseUrl}/og.png">
${jsonLd.map(jsonLdScript).join('\n')}
  <link rel="icon" href="icon.svg" type="image/svg+xml">
  <link rel="icon" href="favicon-32.png" sizes="32x32" type="image/png">
  <link rel="apple-touch-icon" href="apple-touch-icon.png">
  <link rel="stylesheet" href="styles.css">
  <title>${esc(hub.title)}</title>
</head>
<body id="top">
<a class="skip-link" href="#main">Skip to main content</a>
${iconLibrary()}
${header()}

<main class="legal wrap guide" id="main">
    <article class="legal-card">
      ${breadcrumbs([
        { name: 'AirBridge', href: 'index.html' },
        { name: 'Guides', href: 'guides.html' },
      ])}
      <p class="section-label"><span>GUIDES</span> AIRBRIDGE</p>
      <h1>${hub.h1}</h1>
      <p class="guide-lede">${hub.lede}</p>
      <div class="guide-body">
        <p>Each guide below explains the problem it solves, what AirBridge actually does on that platform, how the encryption and permissions work, and where another tool may be the better choice. Start with the platform you use today:</p>
        <ul class="related-list related-list-wide">
${cards}
        </ul>
        <h2 id="how-to-choose">Which guide should I read?</h2>
        <ul>
          <li><strong>Just moved files from Android to a computer:</strong> the Android to <a href="android-to-mac-file-transfer.html">macOS</a>, <a href="android-to-windows-file-transfer.html">Windows</a> or <a href="android-to-linux-file-transfer.html">Linux</a> guide.</li>
          <li><strong>Trying to replace AirDrop:</strong> the <a href="android-airdrop-alternative.html">Android AirDrop alternative</a> guide, plus the <a href="open-source-airdrop-alternative.html">open-source alternative</a> guide if licensing matters to you.</li>
          <li><strong>Copy and paste between phone and computer:</strong> the <a href="android-clipboard-sync.html">Android clipboard sync</a> guide.</li>
          <li><strong>Showing your phone screen on a computer:</strong> the <a href="android-screen-sharing.html">Android screen sharing</a> guide.</li>
          <li><strong>Evaluating the privacy model:</strong> the <a href="private-file-transfer.html">private file transfer</a> guide, then the project's own <a href="${SITE.repoUrl}/blob/main/SECURITY.md">security notes</a>.</li>
        </ul>
      </div>
${downloadCta()}
    </article>
</main>
${footer()}
</body>
</html>
`;
}

function renderSitemap() {
  const urls = [
    { loc: `${SITE.baseUrl}/`, priority: '1.0' },
    { loc: urlFor('download'), priority: '0.9' },
    { loc: urlFor('guides'), priority: '0.8' },
    ...PAGES.filter((page) => page.group === 'guide').map((page) => ({
      loc: urlFor(page.slug),
      priority: '0.8',
    })),
    { loc: urlFor('compare'), priority: '0.8' },
    { loc: urlFor('privacy'), priority: '0.3' },
  ];
  const entries = urls
    .map(
      (entry) => `  <url>
    <loc>${entry.loc}</loc>
    <priority>${entry.priority}</priority>
  </url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

function write(relativePath, contents) {
  writeFileSync(join(WEBSITE, relativePath), contents, 'utf8');
  return relativePath;
}

const written = [];
for (const page of PAGES) {
  if (page.group === 'hub') continue;
  written.push(write(`${page.slug}.html`, renderPage(page)));
}
written.push(write('guides.html', renderHub()));
written.push(write('sitemap.xml', renderSitemap()));

console.log(`Rendered ${written.length} website files:`);
for (const file of written) console.log(`  website/${file}`);
