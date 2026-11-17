import { describe, expect, it } from 'vitest';
import {
  readAndroidManifest,
  readAppBuildGradle,
  readRepoFile,
  startTestServer,
} from '../harness/index.js';

describe('F18: Monotonic VersionCode & Android Package Consistency', () => {
  it('targets API 36 (Play requirement since Aug 2026) with compileSdk 36 and minSdk 26 in android/app/build.gradle.kts', async () => {
    const gradle = await readAppBuildGradle();
    expect(gradle.compileSdk).toBe(36);
    expect(gradle.minSdk).toBe(26);
    expect(gradle.targetSdk).toBe(36);
  });

  it('derives a monotonic versionCode >= 100000 from AIRBRIDGE_VERSION_CODE or git commit count', async () => {
    const gradle = await readAppBuildGradle();
    expect(gradle.rawText).toContain('AIRBRIDGE_VERSION_CODE');
    expect(gradle.rawText).toContain('100000 + ciRunNumber');
    expect(gradle.rawText).toContain('100000 + gitCommitCount');
  });

  it('aligns Android applicationId (com.airbridge.app) and versionName (2.2.1) with package.json', async () => {
    const gradle = await readAppBuildGradle();
    const pkgRaw = await readRepoFile('package.json');
    const pkg = JSON.parse(pkgRaw) as { version: string };
    expect(gradle.rawText).toContain('applicationId = "com.airbridge.app"');
    expect(gradle.versionName).toBe(pkg.version);
  });

  it('configures Android label, backup rules, and singleTask launchMode cleanly in manifest + strings.xml', async () => {
    const manifest = await readAndroidManifest();
    const strings = await readRepoFile('android/app/src/main/res/values/strings.xml');
    expect(strings).toContain('AirBridge');
    expect(manifest.rawXml).toContain('android:label="AirBridge"');
  });

  it('declares core Jetpack Compose, Lifecycle, Camera/QR, and engine module dependencies cleanly', async () => {
    const gradle = await readAppBuildGradle();
    expect(gradle.rawText).toContain('implementation(project(":engine"))');
    expect(gradle.dependencies.some((d) => d.includes('material3'))).toBe(true);
    expect(gradle.dependencies.some((d) => d.includes('activity-compose'))).toBe(true);
  });

  it('publishes consistent service version/protocol identity on HTTP /api/health', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    try {
      const res = await fetch(`${server.httpUrl}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { protocol: string; e2ee: string; service: string };
      expect(body.protocol).toBe('warp-v1');
      expect(body.e2ee).toBe('ECDH-P256-AES-256-GCM');
      expect(body.service).toContain('AirBridge');
    } finally {
      await server.close();
    }
  });
});
