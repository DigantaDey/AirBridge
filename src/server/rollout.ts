/**
 * Staged rollouts for self-updates, with no update server.
 *
 * Each release carries a small `rollout.json` asset:
 *
 *   { "version": "0.0.7", "publishedAt": "2026-11-20T10:00:00Z",
 *     "stages": [{ "afterHours": 0, "percent": 5 }, { "afterHours": 24, "percent": 25 },
 *                { "afterHours": 72, "percent": 100 }],
 *     "halted": false, "minimumVersion": "0.0.5" }
 *
 * Every install has a random id that never leaves the machine. Its bucket
 * for a version, SHA-256(id ‖ version) mod 10 000, is stable and
 * independent across versions, so the same early 5% are not always the
 * guinea pigs. The percentage ramps with time automatically; maintainers
 * halt or resume by re-uploading rollout.json (`node scripts/rollout.mjs`).
 * `minimumVersion` forces the update for older installs (security fixes).
 *
 * Integrity: the binaries are still checked against SHA256SUMS and their
 * Sigstore provenance. rollout.json only decides *when* to update; a
 * tampered file could delay or hasten an update, never change what runs.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, parseVersion } from './updater.js';

export interface RolloutStage {
  afterHours: number;
  percent: number;
}

export interface RolloutPolicy {
  version: string;
  publishedAt: string;
  stages: RolloutStage[];
  halted?: boolean;
  minimumVersion?: string;
}

export interface RolloutDecision {
  eligible: boolean;
  /** Share of installs offered the update right now (0–100). */
  percent: number;
  halted: boolean;
  /** This install's position, 0–99.99 (lower = earlier). */
  bucketPercent: number;
  /** When this install becomes eligible (ISO), if it is scheduled at all. */
  eligibleAt: string | null;
  forced: boolean;
  reason: string;
}

export const DEFAULT_STAGES: RolloutStage[] = [
  { afterHours: 0, percent: 10 },
  { afterHours: 24, percent: 50 },
  { afterHours: 72, percent: 100 },
];

/** Validates an untrusted rollout.json. Null when it is not a usable policy. */
export function parseRolloutPolicy(raw: unknown, expectedVersion: string): RolloutPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const version = typeof o.version === 'string' ? o.version.replace(/^v/, '') : '';
  if (!parseVersion(version) || version !== expectedVersion.replace(/^v/, '')) return null;
  const publishedAt = typeof o.publishedAt === 'string' && !Number.isNaN(Date.parse(o.publishedAt)) ? o.publishedAt : null;
  if (!publishedAt) return null;
  if (!Array.isArray(o.stages) || o.stages.length === 0 || o.stages.length > 20) return null;
  const stages: RolloutStage[] = [];
  for (const s of o.stages) {
    const st = s as Record<string, unknown>;
    const afterHours = Number(st?.afterHours);
    const percent = Number(st?.percent);
    if (!Number.isFinite(afterHours) || afterHours < 0 || afterHours > 24 * 365) return null;
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
    stages.push({ afterHours, percent });
  }
  stages.sort((a, b) => a.afterHours - b.afterHours);
  const minimumVersion = typeof o.minimumVersion === 'string' && parseVersion(o.minimumVersion) ? o.minimumVersion.replace(/^v/, '') : undefined;
  return { version, publishedAt, stages, halted: o.halted === true, minimumVersion };
}

export function rolloutBucket(installId: string, version: string): number {
  const digest = createHash('sha256').update(`airbridge-rollout-v1:${installId}:${version.replace(/^v/, '')}`).digest();
  return digest.readUInt32BE(0) % 10_000;
}

export function percentAt(policy: RolloutPolicy, now: number): number {
  const hours = (now - Date.parse(policy.publishedAt)) / 3_600_000;
  let percent = 0;
  for (const stage of policy.stages) if (hours >= stage.afterHours) percent = stage.percent;
  return percent;
}

export function decideRollout(policy: RolloutPolicy | null, installId: string, currentVersion: string, now = Date.now()): RolloutDecision {
  if (!policy) {
    // Releases without rollout.json (older pipelines) go to everyone.
    return { eligible: true, percent: 100, halted: false, bucketPercent: 0, eligibleAt: null, forced: false, reason: 'no staged rollout' };
  }
  const bucket = rolloutBucket(installId, policy.version);
  const bucketPercent = bucket / 100;
  const forced = Boolean(policy.minimumVersion && compareVersions(currentVersion, policy.minimumVersion) < 0);
  if (policy.halted) {
    return { eligible: false, percent: 0, halted: true, bucketPercent, eligibleAt: null, forced, reason: 'rollout paused by the maintainers' };
  }
  const percent = percentAt(policy, now);
  if (forced) {
    return { eligible: true, percent, halted: false, bucketPercent, eligibleAt: null, forced, reason: `required update (this version is older than ${policy.minimumVersion})` };
  }
  if (bucket < percent * 100) {
    return { eligible: true, percent, halted: false, bucketPercent, eligibleAt: null, forced, reason: `in the first ${percent}% of the rollout` };
  }
  const stage = policy.stages.find((s) => bucket < s.percent * 100);
  const eligibleAt = stage ? new Date(Date.parse(policy.publishedAt) + stage.afterHours * 3_600_000).toISOString() : null;
  return { eligible: false, percent, halted: false, bucketPercent, eligibleAt, forced, reason: `rolling out gradually (${percent}% so far)` };
}

/** A random id for rollout bucketing; created once, never sent anywhere. */
export function loadOrCreateInstallId(stateDir: string): string {
  const file = path.join(stateDir, 'install-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(existing)) return existing;
  } catch {
    // create below
  }
  const id = randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  } catch {
    // Unwritable state dir: a per-run id still gives a fair bucket.
  }
  return id;
}

const BAD_VERSIONS = 'bad-versions.json';

/** Versions that failed to start on this machine and were rolled back. Never retried. */
export function readBadVersions(stateDir: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, BAD_VERSIONS), 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && parseVersion(v) !== null).slice(-20) : [];
  } catch {
    return [];
  }
}

export function markVersionBad(stateDir: string, version: string): void {
  const list = readBadVersions(stateDir).filter((v) => v !== version);
  list.push(version);
  try {
    fs.writeFileSync(path.join(stateDir, BAD_VERSIONS), JSON.stringify(list.slice(-20)), { mode: 0o600 });
  } catch {
    // best effort
  }
}

/** The release pipeline's default policy for a new version. */
export function defaultPolicy(version: string, publishedAt = new Date().toISOString(), stages = DEFAULT_STAGES): RolloutPolicy {
  return { version: version.replace(/^v/, ''), publishedAt, stages, halted: false };
}
