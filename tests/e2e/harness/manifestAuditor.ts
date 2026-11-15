import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ParsedPermission {
  name: string;
  maxSdkVersion?: number;
}

export interface ParsedService {
  name: string;
  exported: boolean;
  permission?: string;
  foregroundServiceType?: string;
  foregroundServiceTypes: string[];
  stopWithTask?: boolean;
}

export interface ParsedActivity {
  name: string;
  exported: boolean;
  launchMode?: string;
  actions: string[];
  categories: string[];
  schemes: string[];
}

export interface ParsedManifest {
  rawXml: string;
  permissions: ParsedPermission[];
  services: ParsedService[];
  activities: ParsedActivity[];
  applicationAttributes: Record<string, string>;
}

export interface ParsedSigningConfig {
  name: string;
  storeFile?: string;
  enableV1Signing?: boolean;
  enableV2Signing?: boolean;
  v1SigningEnabled?: boolean;
  v2SigningEnabled?: boolean;
}

export interface ParsedBuildGradle {
  rawText: string;
  compileSdk: number | null;
  minSdk: number | null;
  targetSdk: number | null;
  versionName: string | null;
  versionCodeExpression: string | null;
  signingConfigs: Map<string, ParsedSigningConfig>;
  dependencies: string[];
}

const DEFAULT_MANIFEST_PATH = path.resolve(
  process.cwd(),
  'android/app/src/main/AndroidManifest.xml'
);

const DEFAULT_GRADLE_PATH = path.resolve(
  process.cwd(),
  'android/app/build.gradle.kts'
);

/**
 * Parses AndroidManifest.xml into structured components.
 */
export async function readAndroidManifest(manifestPath = DEFAULT_MANIFEST_PATH): Promise<ParsedManifest> {
  const rawXml = await fs.readFile(manifestPath, 'utf8');

  const permissions: ParsedPermission[] = [];
  const permRegex = /<uses-permission\s+([^>]+?)\/?>/g;
  let match: RegExpExecArray | null;

  while ((match = permRegex.exec(rawXml)) !== null) {
    const attrs = match[1];
    const nameMatch = /android:name="([^"]+)"/.exec(attrs);
    const maxSdkMatch = /android:maxSdkVersion="([^"]+)"/.exec(attrs);
    if (nameMatch) {
      permissions.push({
        name: nameMatch[1],
        maxSdkVersion: maxSdkMatch ? Number.parseInt(maxSdkMatch[1], 10) : undefined,
      });
    }
  }

  const services: ParsedService[] = [];
  const serviceRegex = /<service\s+([^>]+?)(?:>(.*?)<\/service>|\/>)/gs;

  while ((match = serviceRegex.exec(rawXml)) !== null) {
    const attrs = match[1];
    const nameMatch = /android:name="([^"]+)"/.exec(attrs);
    const exportedMatch = /android:exported="([^"]+)"/.exec(attrs);
    const permMatch = /android:permission="([^"]+)"/.exec(attrs);
    const fgsMatch = /android:foregroundServiceType="([^"]+)"/.exec(attrs);
    const stopWithTaskMatch = /android:stopWithTask="([^"]+)"/.exec(attrs);

    if (nameMatch) {
      const fgsRaw = fgsMatch ? fgsMatch[1] : undefined;
      const fgsTypes = fgsRaw ? fgsRaw.split('|').map((s) => s.trim()) : [];
      services.push({
        name: nameMatch[1],
        exported: exportedMatch ? exportedMatch[1] === 'true' : false,
        permission: permMatch ? permMatch[1] : undefined,
        foregroundServiceType: fgsRaw,
        foregroundServiceTypes: fgsTypes,
        stopWithTask: stopWithTaskMatch ? stopWithTaskMatch[1] === 'true' : undefined,
      });
    }
  }

  const activities: ParsedActivity[] = [];
  const activityRegex = /<activity\s+([^>]+?)>(.*?)<\/activity>/gs;

  while ((match = activityRegex.exec(rawXml)) !== null) {
    const attrs = match[1];
    const body = match[2];
    const nameMatch = /android:name="([^"]+)"/.exec(attrs);
    const exportedMatch = /android:exported="([^"]+)"/.exec(attrs);
    const launchMatch = /android:launchMode="([^"]+)"/.exec(attrs);

    const actions: string[] = [];
    const actionRegex = /<action\s+android:name="([^"]+)"/g;
    let actMatch: RegExpExecArray | null;
    while ((actMatch = actionRegex.exec(body)) !== null) {
      actions.push(actMatch[1]);
    }

    const categories: string[] = [];
    const catRegex = /<category\s+android:name="([^"]+)"/g;
    let catM: RegExpExecArray | null;
    while ((catM = catRegex.exec(body)) !== null) {
      categories.push(catM[1]);
    }

    const schemes: string[] = [];
    const schemeRegex = /<data\s+android:scheme="([^"]+)"/g;
    let schM: RegExpExecArray | null;
    while ((schM = schemeRegex.exec(body)) !== null) {
      schemes.push(schM[1]);
    }

    if (nameMatch) {
      activities.push({
        name: nameMatch[1],
        exported: exportedMatch ? exportedMatch[1] === 'true' : false,
        launchMode: launchMatch ? launchMatch[1] : undefined,
        actions,
        categories,
        schemes,
      });
    }
  }

  const appAttrs: Record<string, string> = {};
  const appMatch = /<application\s+([^>]+?)>/s.exec(rawXml);
  if (appMatch) {
    const attrRegex = /([a-zA-Z0-9_:]+)="([^"]+)"/g;
    let aM: RegExpExecArray | null;
    while ((aM = attrRegex.exec(appMatch[1])) !== null) {
      appAttrs[aM[1]] = aM[2];
    }
  }

  return {
    rawXml,
    permissions,
    services,
    activities,
    applicationAttributes: appAttrs,
  };
}

/**
 * Checks whether a given permission is declared in AndroidManifest.xml.
 */
export function hasPermission(manifest: ParsedManifest, permissionName: string): boolean {
  return manifest.permissions.some(
    (p) => p.name === permissionName || p.name === `android.permission.${permissionName}`
  );
}

/**
 * Returns a service from the manifest matching the name.
 */
export function getService(manifest: ParsedManifest, serviceName: string): ParsedService | undefined {
  return manifest.services.find(
    (s) => s.name === serviceName || s.name === `.${serviceName}` || s.name.endsWith(serviceName)
  );
}

/**
 * Returns the list of declared foregroundServiceTypes for the service.
 */
export function getForegroundServiceTypes(manifest: ParsedManifest, serviceName: string): string[] {
  const svc = getService(manifest, serviceName);
  return svc ? svc.foregroundServiceTypes : [];
}

/**
 * Verifies if a foregroundServiceType is present on the service.
 */
export function hasForegroundServiceType(
  manifest: ParsedManifest,
  serviceName: string,
  expectedType: string
): boolean {
  const types = getForegroundServiceTypes(manifest, serviceName);
  return types.includes(expectedType);
}

/**
 * Returns an activity from the manifest matching the name.
 */
export function getActivity(manifest: ParsedManifest, activityName: string): ParsedActivity | undefined {
  return manifest.activities.find(
    (a) => a.name === activityName || a.name === `.${activityName}` || a.name.endsWith(activityName)
  );
}

/**
 * Parses android/app/build.gradle.kts to inspect SDKs, signing configs, and versioning.
 */
export async function readAppBuildGradle(gradlePath = DEFAULT_GRADLE_PATH): Promise<ParsedBuildGradle> {
  const rawText = await fs.readFile(gradlePath, 'utf8');

  const compileSdkMatch = /compileSdk\s*=\s*(\d+)/.exec(rawText);
  const minSdkMatch = /minSdk\s*=\s*(\d+)/.exec(rawText);
  const targetSdkMatch = /targetSdk\s*=\s*(\d+)/.exec(rawText);
  const versionNameMatch = /versionName\s*=\s*"([^"]+)"/.exec(rawText);
  const versionCodeMatch = /versionCode\s*=\s*([^}\n\r]+)/.exec(rawText);

  const signingConfigs = new Map<string, ParsedSigningConfig>();
  const configBlockRegex = /create\("([^"]+)"\)\s*\{(.*?)\}/gs;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = configBlockRegex.exec(rawText)) !== null) {
    const name = blockMatch[1];
    const body = blockMatch[2];

    const enableV1 = /enableV1Signing\s*=\s*(true|false)/.exec(body);
    const enableV2 = /enableV2Signing\s*=\s*(true|false)/.exec(body);
    const v1Enabled = /v1SigningEnabled\s*=\s*(true|false)/.exec(body);
    const v2Enabled = /v2SigningEnabled\s*=\s*(true|false)/.exec(body);
    const storeMatch = /storeFile\s*=\s*([^\n\r]+)/.exec(body);

    signingConfigs.set(name, {
      name,
      storeFile: storeMatch ? storeMatch[1].trim() : undefined,
      enableV1Signing: enableV1 ? enableV1[1] === 'true' : undefined,
      enableV2Signing: enableV2 ? enableV2[1] === 'true' : undefined,
      v1SigningEnabled: v1Enabled ? v1Enabled[1] === 'true' : undefined,
      v2SigningEnabled: v2Enabled ? v2Enabled[1] === 'true' : undefined,
    });
  }

  const dependencies: string[] = [];
  const depBlockMatch = /dependencies\s*\{(.*?)\}/s.exec(rawText);
  if (depBlockMatch) {
    const depLines = depBlockMatch[1].split('\n');
    for (const line of depLines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('//')) {
        dependencies.push(trimmed);
      }
    }
  }

  return {
    rawText,
    compileSdk: compileSdkMatch ? Number.parseInt(compileSdkMatch[1], 10) : null,
    minSdk: minSdkMatch ? Number.parseInt(minSdkMatch[1], 10) : null,
    targetSdk: targetSdkMatch ? Number.parseInt(targetSdkMatch[1], 10) : null,
    versionName: versionNameMatch ? versionNameMatch[1] : null,
    versionCodeExpression: versionCodeMatch ? versionCodeMatch[1].trim() : null,
    signingConfigs,
    dependencies,
  };
}

/**
 * Checks whether v1 APK signature scheme is enabled in the specified signing config.
 */
export function isV1SigningEnabled(gradle: ParsedBuildGradle, configName = 'ciSideload'): boolean {
  const cfg = gradle.signingConfigs.get(configName);
  if (!cfg) return false;
  return cfg.enableV1Signing === true || cfg.v1SigningEnabled === true;
}

/**
 * Checks whether v2 APK signature scheme is enabled in the specified signing config.
 */
export function isV2SigningEnabled(gradle: ParsedBuildGradle, configName = 'ciSideload'): boolean {
  const cfg = gradle.signingConfigs.get(configName);
  if (!cfg) return false;
  return cfg.enableV2Signing === true || cfg.v2SigningEnabled === true;
}
