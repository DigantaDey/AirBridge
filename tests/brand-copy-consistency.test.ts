// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => fs.readFileSync(path, "utf8");

describe("brand and licence consistency", () => {
  it("states that Google Play availability is coming soon without a store install link", () => {
    for (const file of ["website/index.html", "website/download.html"]) {
      expect(read(file)).toContain("Google Play Store app — coming soon");
      expect(read(file)).not.toContain("https://play.google.com/store/apps/details");
    }
  });
  it("uses the navy icon background in installed web app chrome", () => {
    const manifest = JSON.parse(read("public/manifest.webmanifest"));
    expect(manifest.theme_color).toBe("#0F1222");
    expect(manifest.background_color).toBe("#0F1222");
    expect(read("index.html")).toContain('name="theme-color" content="#0F1222"');
    expect(manifest.icons.some((icon: { src: string }) => icon.src === "/icon.svg")).toBe(true);
  });

  it("describes the actual non-commercial licence rather than a permissive one", () => {
    expect(read("LICENSE")).toContain("Fair-Use & Non-Commercial License");
    for (const file of ["README.md", "website/index.html", "website/open-source-airdrop-alternative.html"]) {
      const copy = read(file);
      expect(copy, file).toMatch(/Fair-Use/);
      expect(copy, file).toMatch(/written consent/);
      expect(copy, file).not.toMatch(/MIT\/Apache-style/);
    }
    expect(read("website/index.html")).toContain("not an OSI-approved");
  });
});
