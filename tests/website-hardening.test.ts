// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";

function parseHexColor(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "");
  if (clean.length === 3) {
    return [
      parseInt(clean[0]! + clean[0]!, 16),
      parseInt(clean[1]! + clean[1]!, 16),
      parseInt(clean[2]! + clean[2]!, 16),
    ];
  }
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexColor(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Website Revamp, Horizontal Overflow Prevention & Hardening", () => {
  const styles = fs.readFileSync("website/styles.css", "utf8");
  const indexHtml = fs.readFileSync("website/index.html", "utf8");
  const privacyHtml = fs.readFileSync("website/privacy.html", "utf8");
  const notFoundHtml = fs.readFileSync("website/404.html", "utf8");
  const pagesYml = fs.readFileSync(".github/workflows/pages.yml", "utf8");

  it("achieves WCAG AA >= 4.5:1 contrast ratios across light, mint, and dark surfaces with no sub-12px font sizes", () => {
    expect(styles).toContain("--muted: #46564d");
    const lightSurfaces = ["#fbfcfa", "#ffffff", "#f1f6f1", "#f3f6f2", "#dfeee1", "#dceee0", "#eef6ef"];
    for (const surface of lightSurfaces) {
      expect(contrastRatio("#46564d", surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio("#17221e", surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio("#2d6348", surface)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio("#1f2f26", "#dceee0")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#f4f8f5", "#192921")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#cbe0d3", "#192921")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#9ed9b5", "#192921")).toBeGreaterThanOrEqual(4.5);

    const fontSizes = [...styles.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(fontSizes.length).toBeGreaterThan(0);
    for (const size of fontSizes) {
      expect(size).toBeGreaterThanOrEqual(12);
    }
  });

  it("prevents horizontal page scrolling across viewports via overflow-x clip, minmax(0, ...), min-width: 0, and contained code/table wrappers", () => {
    expect(styles).toContain("overflow-x: clip;");
    expect(styles).toContain("max-width: 100%;");
    expect(styles).toContain("minmax(0,");
    expect(styles).toContain("min-width: 0;");
    expect(styles).toContain(".table-wrap");
    expect(styles).toContain("overflow-wrap: anywhere;");
    expect(styles).toContain("overflow-x: auto;");

    // No absolute positioning left on bento feature cards
    expect(styles).not.toContain(".clipboard-visual{position:absolute");
    expect(styles).not.toContain(".file-visual{position:absolute");
    // Mobile nav never hidden
    expect(styles).not.toContain(".nav-links{display:none}");
  });

  it("showcases all AirBridge v2.5.0 capabilities, comparison table, honest platform disclosures, and creator About section", () => {
    expect(indexHtml).toContain('<a class="skip-link" href="#main">');
    expect(indexHtml).toContain('<main id="main">');
    expect(indexHtml).toContain('class="hero-visual" role="img"');
    expect(indexHtml).toContain('"softwareVersion":"2.5.0"');
    expect(indexHtml).toContain("v2.5.0");
    expect(indexHtml).toContain("MediaCodec");
    expect(indexHtml).toContain("avcC");
    expect(indexHtml).toContain("NSPasteboard");
    expect(indexHtml).toContain("Use Mac Audio");
    expect(indexHtml).toContain("saved contacts");
    expect(indexHtml).toContain("compare-table");
    expect(indexHtml).toContain('href="https://github.com/DigantaDey/AirBridge#readme">README</a>');
    expect(indexHtml).toContain("Diganta Dey");
    expect(indexHtml).toContain('http-equiv="Content-Security-Policy"');
  });

  it("satisfies Pages workflow static HTML rules across index.html, privacy.html, and 404.html", () => {
    for (const html of [indexHtml, privacyHtml, notFoundHtml]) {
      expect(html).not.toContain("src/client/main.tsx");
      expect(html).not.toMatch(/(?:src|href)="\//);
    }
    expect(notFoundHtml).not.toContain("Manrope");
    expect(notFoundHtml).not.toContain('http-equiv="refresh"');
    expect(notFoundHtml).not.toContain('style="');
    expect(notFoundHtml).toContain('href="./index.html"');
    expect(notFoundHtml).toContain('href="styles.css"');

    expect(privacyHtml).toContain("Crash reports and diagnostics");
    expect(privacyHtml).toContain("Copy diagnostics");
    expect(privacyHtml).toContain("Report on GitHub");
    expect(privacyHtml).toContain("Diganta Dey");
    expect(pagesYml).toContain("for page in website/index.html website/privacy.html website/404.html");
  });
});
