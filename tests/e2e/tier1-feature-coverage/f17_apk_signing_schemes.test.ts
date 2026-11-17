import { describe, expect, it } from 'vitest';
import {
  isV1SigningEnabled,
  isV2SigningEnabled,
  readAppBuildGradle,
  repoFileExists,
} from '../harness/index.js';

describe('F17: Play upload-key signing is fail-closed', () => {
  it('enables v1, v2 and v3 signing on the private release config', async () => {
    const gradle = await readAppBuildGradle();
    expect(isV1SigningEnabled(gradle, 'release')).toBe(true);
    expect(isV2SigningEnabled(gradle, 'release')).toBe(true);
    expect(gradle.rawText).toContain('enableV3Signing = true');
  });

  it('loads release credentials only from ignored local properties or environment', async () => {
    const gradle = await readAppBuildGradle();
    expect(gradle.rawText).toContain('keystore.properties');
    expect(gradle.rawText).toContain('AIRBRIDGE_KEYSTORE_FILE');
    expect(gradle.rawText).toContain('hasReleaseSigning');
    expect(gradle.rawText).toContain('Release signing is not configured');
    expect(gradle.rawText).not.toContain('ciSideload');
  });

  it('does not retain a committed signing key and provides a safe local template', async () => {
    expect(await repoFileExists('android/ci.keystore')).toBe(false);
    expect(await repoFileExists('android/keystore.properties.example')).toBe(true);
  });

  it('enables code/resource shrinking for the Play release bundle', async () => {
    const gradle = await readAppBuildGradle();
    expect(gradle.rawText).toContain('isMinifyEnabled = true');
    expect(gradle.rawText).toContain('isShrinkResources = true');
  });

  it('declares verification script android/scripts/verify.sh for automated APK & engine checks', async () => {
    expect(await repoFileExists('android/scripts/verify.sh')).toBe(true);
  });
});
