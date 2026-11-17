#!/usr/bin/env node
/**
 * Staged-rollout control for desktop self-updates (see src/server/rollout.ts).
 *
 *   node scripts/rollout.mjs init  <version> [--out file] [--stages 0:10,24:50,72:100]
 *   node scripts/rollout.mjs status <tag>
 *   node scripts/rollout.mjs halt   <tag>        stop offering the update (installs already updated keep it)
 *   node scripts/rollout.mjs resume <tag>
 *   node scripts/rollout.mjs set    <tag> <percent>   jump to a percentage now (100 = everyone)
 *   node scripts/rollout.mjs require <tag> <minimumVersion>  force the update for older installs
 *
 * Changes take effect at each computer's next background check (every 6 h).
 * Uses the GitHub CLI (`gh`) for release assets.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_STAGES = '0:10,24:50,72:100';
const [, , cmd, target, arg] = process.argv;

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function parseStages(spec) {
  const stages = spec.split(',').map((part) => {
    const [h, p] = part.split(':').map(Number);
    if (!Number.isFinite(h) || h < 0 || !Number.isFinite(p) || p < 0 || p > 100) throw new Error(`bad stage "${part}" (hours:percent)`);
    return { afterHours: h, percent: p };
  });
  return stages.sort((a, b) => a.afterHours - b.afterHours);
}

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
}

function download(tag) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'airbridge-rollout-'));
  gh(['release', 'download', tag, '--pattern', 'rollout.json', '--dir', dir]);
  return { dir, policy: JSON.parse(readFileSync(path.join(dir, 'rollout.json'), 'utf8')) };
}

function upload(tag, dir, policy) {
  const file = path.join(dir, 'rollout.json');
  writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`);
  gh(['release', 'upload', tag, file, '--clobber']);
  describe(policy);
}

function percentNow(policy) {
  const hours = (Date.now() - Date.parse(policy.publishedAt)) / 3_600_000;
  let percent = 0;
  for (const s of policy.stages) if (hours >= s.afterHours) percent = s.percent;
  return percent;
}

function describe(policy) {
  const state = policy.halted ? 'HALTED' : `${percentNow(policy)}% of installs`;
  console.log(`AirBridge ${policy.version}: ${state}`);
  console.log(`  published ${policy.publishedAt}; stages ${policy.stages.map((s) => `${s.afterHours}h→${s.percent}%`).join(', ')}`);
  if (policy.minimumVersion) console.log(`  required for installs older than ${policy.minimumVersion}`);
}

try {
  switch (cmd) {
    case 'init': {
      if (!target) throw new Error('usage: init <version>');
      const policy = {
        version: target.replace(/^v/, ''),
        publishedAt: new Date().toISOString(),
        stages: parseStages(flag('--stages', process.env.AIRBRIDGE_ROLLOUT_STAGES || DEFAULT_STAGES)),
        halted: false,
      };
      const out = flag('--out', 'rollout.json');
      writeFileSync(out, `${JSON.stringify(policy, null, 2)}\n`);
      describe(policy);
      break;
    }
    case 'status': {
      describe(download(target).policy);
      break;
    }
    case 'halt':
    case 'resume': {
      const { dir, policy } = download(target);
      policy.halted = cmd === 'halt';
      upload(target, dir, policy);
      break;
    }
    case 'set': {
      const percent = Number(arg);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('usage: set <tag> <0-100>');
      const { dir, policy } = download(target);
      const hours = Math.max(0, (Date.now() - Date.parse(policy.publishedAt)) / 3_600_000);
      // Keep earlier stages, replace the future with "now: percent", keep higher later stages.
      policy.stages = [
        ...policy.stages.filter((s) => s.afterHours <= hours && s.percent < percent),
        { afterHours: Math.round(hours * 100) / 100, percent },
        ...policy.stages.filter((s) => s.afterHours > hours && s.percent > percent),
      ];
      policy.halted = false;
      upload(target, dir, policy);
      break;
    }
    case 'require': {
      if (!/^v?\d+\.\d+\.\d+$/.test(arg ?? '')) throw new Error('usage: require <tag> <minimumVersion>');
      const { dir, policy } = download(target);
      policy.minimumVersion = arg.replace(/^v/, '');
      upload(target, dir, policy);
      break;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 14).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`rollout: ${err.message}`);
  process.exit(1);
}
