import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static guards for Google Play policy items and the public site's
 * SEO/answer-engine assets. Each assertion maps to a reviewer check listed in
 * docs/PLAY_STORE.md.
 */
const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const app = 'android/app/src/main/kotlin/com/airbridge/app';

describe('Google Play readiness', () => {
  it('targets API 36 with an AGP that supports it and CI installs that platform', () => {
    const gradle = read('android/app/build.gradle.kts');
    expect(gradle).toMatch(/compileSdk\s*=\s*36/);
    expect(gradle).toMatch(/targetSdk\s*=\s*36/);
    const agp = /com\.android\.application"\)\s*version\s*"(\d+)\.(\d+)/.exec(read('android/build.gradle.kts'));
    expect(agp).not.toBeNull();
    const [major, minor] = [Number(agp![1]), Number(agp![2])];
    expect(major > 8 || (major === 8 && minor >= 9)).toBe(true);
    for (const wf of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      expect(read(wf)).toContain('platforms;android-36');
    }
  });

  it('is ready for Android 16 edge-to-edge and predictive back', () => {
    expect(read(`${app}/MainActivity.kt`)).toContain('enableEdgeToEdge(');
    expect(read('android/app/src/main/AndroidManifest.xml')).toContain('android:enableOnBackInvokedCallback="true"');
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).not.toMatch(/screenOrientation=/);
    expect(manifest).not.toMatch(/windowOptOutEdgeToEdgeEnforcement/);
  });

  it('shows a prominent disclosure before Accessibility or Notification access', () => {
    const settings = read(`${app}/ui/screens/SettingsScreen.kt`);
    expect(settings).toContain('private fun SensitiveAccessDisclosure(');
    expect(settings).toContain('Text("Agree")');
    // The switches and buttons route through the disclosure, not straight to Android Settings.
    expect(settings).toContain('onClick = { disclosure = DISCLOSURE_NOTIFICATIONS }');
    expect(settings).toContain('if (on) disclosure = DISCLOSURE_ACCESSIBILITY else onSetAccessibilityOptIn(false)');
    expect(settings).not.toContain('OutlinedButton(onClick = onOpenNotificationListenerSettings)');
    expect(settings).not.toContain('TextButton(onClick = onOpenAccessibilitySettings)');
    // Disclosure content: what, where, not sold/ads, how to stop.
    expect(settings).toMatch(/paired computer, end-to-end encrypted/);
    expect(settings).toMatch(/no(?:thing goes to)? AirBridge servers or third parties/i);
  });

  it('never opts the Accessibility service in without the in-app consent', () => {
    const svc = read(`${app}/ClipboardAccessibilityService.kt`);
    expect(svc).not.toMatch(/accessibilityClipboardOptIn\s*=\s*true/);
    const cfg = read('android/app/src/main/res/xml/accessibility_service_config.xml');
    expect(cfg).toContain('android:canRetrieveWindowContent="false"');
    expect(cfg).toContain('android:canPerformGestures="false"');
    expect(cfg).not.toContain('flagRetrieveInteractiveWindows');
    expect(cfg).not.toContain('isAccessibilityTool');
  });

  it('relays only alert-style notifications', () => {
    const svc = read(`${app}/NotificationSharingService.kt`);
    for (const guard of [
      'sbn.isOngoing',
      'Notification.FLAG_ONGOING_EVENT',
      'Notification.FLAG_FOREGROUND_SERVICE',
      'Notification.FLAG_GROUP_SUMMARY',
      'Notification.VISIBILITY_SECRET',
    ]) {
      expect(svc).toContain(guard);
    }
    expect(svc).toMatch(/if \(!shouldRelay\(sbn, notif\)\) return/);
  });

  it('documents privacy, Data safety, declarations and a private upload key', () => {
    const privacy = read('docs/PRIVACY.md');
    expect(privacy).toMatch(/no accounts,\s+no cloud,\s+no\s+advertising,\s+no analytics/i);
    expect(privacy).toMatch(/\*\*never\*\*:\s+reads what you type/);
    const play = read('docs/PLAY_STORE.md');
    for (const topic of ['Data safety', 'FOREGROUND_SERVICE_MEDIA_PROJECTION', 'RECORD_AUDIO', 'AccessibilityService', 'Play App Signing', 'privacy.html']) {
      expect(play).toContain(topic);
    }
    expect(play).toMatch(/never use `android\/ci\.keystore` for Play/);
  });
});

describe('public site SEO / AEO', () => {
  const site = read('website/index.html');

  it('has search and social metadata', () => {
    expect(site).toMatch(/<title>[^<]*Android[^<]*Mac[^<]*<\/title>/);
    expect(site).toContain('<link rel="canonical" href="https://airbridge.fyi/">');
    expect(site).toContain('property="og:image" content="https://airbridge.fyi/og-image.jpg"');
    expect(site).toContain('name="twitter:card" content="summary_large_image"');
    expect(existsSync(join(root, 'website/og-image.jpg'))).toBe(true);
    const description = /<meta name="description" content="([^"]+)"/.exec(site)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(70);
    expect(description.length).toBeLessThanOrEqual(170);
  });

  it('ships JSON-LD whose FAQ matches the visible FAQ', () => {
    const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(site)?.[1];
    expect(json).toBeTruthy();
    const data = JSON.parse(json!);
    const types = data['@graph'].map((n: { '@type': string }) => n['@type']);
    expect(types).toEqual(expect.arrayContaining(['WebSite', 'Organization', 'SoftwareApplication', 'FAQPage']));
    const faq = data['@graph'].find((n: { '@type': string }) => n['@type'] === 'FAQPage');
    const visible = [...site.matchAll(/<details><summary>(.*?)<span>＋<\/span><\/summary>/g)].map((m) => m[1]);
    expect(faq.mainEntity.map((q: { name: string }) => q.name)).toEqual(visible.map((q) => q.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')));
    // Answer-engine questions people actually ask.
    const names = faq.mainEntity.map((q: { name: string }) => q.name).join('\n');
    expect(names).toMatch(/cast my Android screen to a Mac/);
    expect(names).toMatch(/Netflix/);
    expect(names).toMatch(/answer Android phone calls on my Mac/);
  });

  it('publishes robots.txt, sitemap.xml, llms.txt and a privacy page with relative assets', () => {
    expect(read('website/robots.txt')).toContain('Sitemap: https://airbridge.fyi/sitemap.xml');
    const sitemap = read('website/sitemap.xml');
    expect(sitemap).toContain('<loc>https://airbridge.fyi/</loc>');
    expect(sitemap).toContain('<loc>https://airbridge.fyi/privacy.html</loc>');
    expect(read('website/llms.txt')).toMatch(/^# AirBridge\n\n> /);
    const privacy = read('website/privacy.html');
    expect(privacy).toContain('<link rel="canonical" href="https://airbridge.fyi/privacy.html">');
    expect(site).toContain('href="privacy.html"');
    // pages.yml rejects absolute asset paths.
    for (const page of [site, privacy]) expect(page).not.toMatch(/src="\//);
    expect(read('website/404.html')).toContain('noindex');
  });

  it('keeps the local app out of search indexes', () => {
    expect(read('index.html')).toContain('name="robots" content="noindex, nofollow"');
  });
});
