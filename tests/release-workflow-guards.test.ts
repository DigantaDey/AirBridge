// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guards the 2.5.1 release fixes:
 *
 * 1. The Android version code used two formulas — CI added the workflow run
 *    number, local builds added the git commit count — so the published APK
 *    and a local build could cross and Android refused the "downgrade".
 *    CI must now derive the code from the commit count, exactly like Gradle,
 *    and must check out full history so the count is real.
 * 2. Release notes are published as the GitHub release body, where relative
 *    markdown links 404. They must use absolute URLs.
 */
describe("Release workflow guards", () => {
  it("derives the Android version code from the commit count in CI, exactly like local builds", () => {
    const release = fs.readFileSync(".github/workflows/release.yml", "utf8");
    expect(release).not.toContain("GITHUB_RUN_NUMBER");
    expect(release).toContain("git rev-list --count HEAD");
    // Both Android jobs (APK + AAB) need full history for a real count.
    const fetchDepthZero = release.match(/fetch-depth: 0/g) ?? [];
    expect(fetchDepthZero.length).toBeGreaterThanOrEqual(2);
    const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci.slice(ci.indexOf("  android:"))).toMatch(/uses: actions\/checkout@v4\s+with:\s+fetch-depth: 0/);
  });

  it("refuses to mint a version code from a shallow clone", () => {
    const gradle = fs.readFileSync("android/app/build.gradle.kts", "utf8");
    expect(gradle).toContain("is-shallow-repository");
    expect(gradle).toContain("git fetch --unshallow");
  });

  it("keeps release notes free of relative links (they render on the release page)", () => {
    const notes = fs.readdirSync("docs").filter((file) => /^RELEASE_.*\.md$/.test(file));
    expect(notes.length).toBeGreaterThan(0);
    for (const file of notes) {
      const text = fs.readFileSync(`docs/${file}`, "utf8");
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const url = match[1]!;
        expect(
          /^(https?:\/\/|#|\/)/.test(url),
          `${file} has relative link ${url} — it 404s on the GitHub release page`,
        ).toBe(true);
      }
    }
  });
});
