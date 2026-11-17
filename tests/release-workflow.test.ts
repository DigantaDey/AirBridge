import { describe, expect, it } from 'vitest';
import { readRepoFile } from './e2e/harness/index.js';

describe('public release workflow', () => {
  it('defers a Play AAB without credentials while retaining fail-closed private signing', async () => {
    const workflow = await readRepoFile('.github/workflows/release.yml');

    expect(workflow).toContain('signed_aab_built: ${{ steps.signing.outputs.configured }}');
    expect(workflow).toContain('echo "configured=false" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('::notice title=Play AAB deferred::');
    expect(workflow).toContain("if: ${{ steps.signing.outputs.configured == 'true' }}");

    for (const secret of [
      'AIRBRIDGE_UPLOAD_KEYSTORE_BASE64',
      'AIRBRIDGE_KEYSTORE_PASSWORD',
      'AIRBRIDGE_KEYSTORE_ALIAS',
      'AIRBRIDGE_KEYSTORE_KEY_PASSWORD',
    ]) {
      expect(workflow).toContain(secret);
    }

    const publishJob = workflow.slice(workflow.indexOf('  publish:'));
    expect(publishJob).toContain('SIGNED_AAB_BUILT: ${{ needs.android-aab.outputs.signed_aab_built }}');
    expect(publishJob).toContain('public release contains only the validated desktop artifacts');
    expect(publishJob).not.toContain('AirBridge.aab');
  });
});
