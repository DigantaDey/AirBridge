// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(file, "utf8");

describe("iOS browser support documentation", () => {
  it("distinguishes browser access, native features and local certificate trust", () => {
    for (const file of [
      "README.md",
      "website/index.html",
      "website/download.html",
      "website/compare.html",
      "src/client/components/DownloadsModal.tsx",
    ]) {
      const copy = read(file);
      expect(copy, file).toMatch(/iPhone/);
      expect(copy, file).toMatch(/Safari/);
      expect(copy, file).toMatch(/clipboard sharing/);
      expect(copy, file).toMatch(/browser permissions/);
      expect(copy, file).toMatch(/contacts and calls/);
      expect(copy, file).toMatch(/CA trust warning|certificate authority/);
      expect(copy, file).toMatch(/your own (?:AirBridge )?instance/);
    }
  });

  it("does not confuse the lack of a native iOS app with no iOS support", () => {
    const files = ["README.md", ...fs.readdirSync("website").filter(f => f.endsWith(".html")).map(f => `website/${f}`)];
    for (const file of files) {
      expect(read(file), file).not.toMatch(/iPhone-to-Android is not supported|No iPhone or iPad support|No iOS,|Android-to-iPhone transfer is out of scope|cannot exchange files with an iPhone/);
    }
    expect(read("website/compare.html")).toContain("Browser: files and clipboard, subject to permissions");
    expect(read("website/android-airdrop-alternative.html")).toContain("Yes, using the AirBridge browser UI on the iPhone");
  });
});
