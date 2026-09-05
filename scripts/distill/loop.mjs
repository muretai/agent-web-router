#!/usr/bin/env node
/**
 * Local loop: distill fixtures (+ optional var/traces.jsonl) → measure → M0.
 * --apply-skill writes demonstrated SKILL.md gaps only when lift > 0.
 * --skip-m0 skips npm test. Never uploads. Never changes route()/checkHandoff.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillGaps } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const apply = process.argv.includes('--apply-skill');
const skipM0 = process.argv.includes('--skip-m0');

function run(file, extra = []) {
  const r = spawnSync(process.execPath, [resolve(HERE, file), ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r;
}

function runNpm(args) {
  const options = { cwd: ROOT, encoding: 'utf8' };
  if (process.env.npm_execpath) {
    return spawnSync(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    ...options,
    shell: process.platform === 'win32',
  });
}

run('distill.mjs');
run('measure.mjs');

process.stdout.write('\n--- mutation (empty Distiller) ---\n');
run('distill.mjs', ['--empty']);
run('measure.mjs', ['--empty']);
run('distill.mjs');

if (!skipM0) {
  process.stdout.write('\n--- M0 npm test ---\n');
  const t = runNpm(['test']);
  if (t.stdout) process.stdout.write(t.stdout);
  if (t.stderr) process.stderr.write(t.stderr);
  if (t.status !== 0) {
    process.stderr.write('M0 failed — do not merge a SKILL.md hunk\n');
    process.exit(t.status ?? 1);
  }
}

if (apply) {
  const rules = JSON.parse(readFileSync(resolve(ROOT, 'generated/rules.json'), 'utf8'));
  const skillPath = resolve(ROOT, 'SKILL.md');
  const skillMd = readFileSync(skillPath, 'utf8');
  const gaps = skillGaps(rules, skillMd);
  if (!gaps.length) {
    process.stdout.write('\n--apply-skill: SKILL.md already covers the demonstrated rules\n');
  } else {
    const needle = 'that entry is the door\'s contract.\n';
    const extra = gaps.map((g) => `   ${g.bullet}\n`).join('');
    if (!skillMd.includes(needle)) {
      process.stderr.write('--apply-skill: could not find the insertion point in SKILL.md\n');
      process.exit(1);
    }
    writeFileSync(skillPath, skillMd.replace(needle, needle + extra));
    process.stdout.write(`\n--apply-skill: wrote ${gaps.length} bullet(s) into SKILL.md\n`);
  }
} else if (existsSync(resolve(ROOT, 'generated/SKILL.hunk.md'))) {
  process.stdout.write('\nProposed hunk: generated/SKILL.hunk.md (re-run with --apply-skill to write it)\n');
}
