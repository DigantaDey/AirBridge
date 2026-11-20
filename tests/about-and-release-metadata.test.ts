// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildLinuxLauncherEntry } from "../src/server/desktopLauncher.js";

describe("Version Consistency & Updated About AirBridge Across All Platforms", () => {
  it("aligns version 2.5.1 across package manifests, Android Gradle, website, and docs", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    const appGradle = fs.readFileSync("android/app/build.gradle.kts", "utf8");
    const websiteIndex = fs.readFileSync("website/index.html", "utf8");
    const androidDoc = fs.readFileSync("docs/ANDROID_VALIDATION.md", "utf8");
    const playDoc = fs.readFileSync("docs/PLAY_STORE_RELEASE.md", "utf8");

    expect(pkg.version).toBe("2.5.1");
    expect(lock.version).toBe("2.5.1");
    expect(lock.packages[""]?.version).toBe("2.5.1");
    expect(appGradle).toContain('versionName = "2.5.1"');
    expect(websiteIndex).toContain('"softwareVersion":"2.5.1"');
    expect(websiteIndex).toContain("v2.5.1");
    expect(androidDoc).toContain("(2.5.1)");
    expect(playDoc).toContain("AirBridge 2.5.1");
  });

  it("includes updated About AirBridge details in the Web UI, macOS app, Android Compose Settings, and Linux launcher", () => {
    const webApp = fs.readFileSync("src/client/App.tsx", "utf8");
    expect(webApp).toContain("About AirBridge");
    expect(webApp).toContain("Created by Diganta Dey");
    expect(webApp).toContain("https://airbridge.fyi/");
    expect(webApp).toContain("https://airbridge.fyi/privacy.html");
    expect(webApp).toContain("two-way Mac call audio");
    expect(webApp).toContain("photo clipboard sync");

    const macApp = fs.readFileSync("scripts/mac_app.swift", "utf8");
    expect(macApp).toContain("showAbout()");
    expect(macApp).toContain("Created by Diganta Dey");
    expect(macApp).toContain("https://airbridge.fyi/");
    expect(macApp).toContain("two-way Mac call audio");

    const pkgMac = fs.readFileSync("scripts/package-mac-app.sh", "utf8");
    expect(pkgMac).toContain("© 2026 Diganta Dey");

    const installSh = fs.readFileSync("install.sh", "utf8");
    expect(installSh).toContain("© 2026 Diganta Dey");
    expect(installSh).toContain("by Diganta Dey");

    const androidSettings = fs.readFileSync(
      "android/app/src/main/kotlin/com/airbridge/app/ui/screens/SettingsScreen.kt",
      "utf8",
    );
    expect(androidSettings).toContain("AboutAirBridgeCard");
    expect(androidSettings).toContain("About AirBridge");
    expect(androidSettings).toContain("BuildConfig.VERSION_NAME");
    expect(androidSettings).toContain("Created by Diganta Dey");
    expect(androidSettings).toContain("two-way Mac call audio bridge");

    const desktopEntry = buildLinuxLauncherEntry({
      executable: "/usr/local/bin/airbridge",
      version: "2.5.1",
    });
    expect(desktopEntry).toContain("Comment=AirBridge 2.5.1");
    expect(desktopEntry).toContain("Diganta Dey");
    expect(desktopEntry).toContain("H.264 screen sharing");
  });
});
