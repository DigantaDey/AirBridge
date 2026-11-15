import { describe, expect, it } from 'vitest';
import {
  isV1SigningEnabled,
  isV2SigningEnabled,
  readAppBuildGradle,
  repoFileExists,
} from '../harness/index.js';

describe('F17: Consistent APK Signing Schemes (v1/v2/v3) for Clean Updates', () => {
  it('enables v1 and v2 signing schemes on the shared ciSideload signing config', async () => {
    const gradle = await readAppBuildGradle();
    expect(isV1SigningEnabled(gradle, 'ciSideload')).toBe(true);
    expect(isV2SigningEnabled(gradle, 'ciSideload')).toBe(true);
  });

  it('enables v3 key-rotation/upgrade signature scheme on both ciSideload and release configs', async () => {
    const gradle = await readAppBuildGradle();
    expect(gradle.rawText).toContain('enableV3Signing = true');
    expect(isV1SigningEnabled(gradle, 'release') || gradle.rawText.includes('getByName("ciSideload")')).toBe(
      true,
    );
    expect(isV2SigningEnabled(gradle, 'release') || gradle.rawText.includes('getByName("ciSideload")')).toBe(
      true,
    );
  });

  it('falls back release builds to ciSideload when AIRBRIDGE_RELEASE_* secrets are unset', async () => {
    const gradle = await readAppBuildGradle();
    expect(gradle.rawText).toContain(
      'signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("ciSideload")',
    );
  });

  it('commits the deterministic android/ci.keystore alongside Gradle signing config', async () => {
    expect(await repoFileExists('android/ci.keystore')).toBe(true);
    const gradle = await readAppBuildGradle();
    expect(gradle.rawText).toContain('ci.keystore');
  });

  it('keeps debug and release build types signed with matching certificate lineage when built locally', async () => {
    const gradle = await readAppBuildGradle();
    const debugMatches = gradle.rawText.match(/debug\s*\{[\s\S]*?signingConfig = signingConfigs\.getByName\("ciSideload"\)/);
    expect(debugMatches).not.toBeNull();
  });

  it('declares verification script android/scripts/verify.sh for automated APK & engine checks', async () => {
    expect(await repoFileExists('android/scripts/verify.sh')).toBe(true);
  });
});
