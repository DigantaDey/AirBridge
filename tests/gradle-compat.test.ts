import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Gradle 8.x / 9.x compatibility in android/engine/build.gradle.kts', () => {
  const buildScript = fs.readFileSync(
    path.resolve(process.cwd(), 'android/engine/build.gradle.kts'),
    'utf8',
  );

  it('does not use a bare Gradle 9+ failOnNoDiscoveredTests property reference', () => {
    expect(buildScript).not.toMatch(/\bfailOnNoDiscoveredTests\.set\s*\(/);
    expect(buildScript).not.toMatch(/\bfailOnNoDiscoveredTests\s*=/);
  });

  it('configures failOnNoDiscoveredTests reflectively for cross-version compatibility', () => {
    expect(buildScript).toContain('getMethod("getFailOnNoDiscoveredTests")');
    expect(buildScript).toContain('runCatching');
  });

  it('registers resilienceAndContinuityAudioTest in check and orders milestone2Test after it', () => {
    expect(buildScript).toContain('val resilienceAndContinuityAudioTest = tasks.register<JavaExec>("resilienceAndContinuityAudioTest")');
    expect(buildScript).toContain('resilienceAndContinuityAudioTest,');
  });
});
