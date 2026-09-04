#!/usr/bin/env node
/**
 * M2: held-out fixtures. Naive = first-match (a card/to that exists is a door).
 * Skill = apply distilled rules. Gold = route()/checkHandoff.
 * Mutation: --empty uses rules.empty so apply == naive and lift must be 0.
 * M0 (npm test) is loop.mjs's job — this file must not spawn the suite
 * (the suite imports these helpers).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRules, label, loadCases, naive } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = resolve(ROOT, 'generated');

function loadRules(empty) {
  if (empty) return { empty: true };
  const p = resolve(OUT, 'rules.json');
  if (!existsSync(p)) {
    process.stderr.write('measure.mjs: run distill.mjs first (no generated/rules.json)\n');
    process.exit(1);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function score(cases, decide) {
  const rows = [];
  let ok = 0;
  for (const c of cases) {
    const gold = label(c).take;
    const pred = decide(c);
    const hit = pred === gold;
    if (hit) ok += 1;
    rows.push({ id: c.id, gold, pred, hit });
  }
  return { ok, n: cases.length, pct: cases.length ? ok / cases.length : 0, rows };
}

const empty = process.argv.includes('--empty');
const rules = loadRules(empty);
const holdout = loadCases().filter((c) => c.split === 'holdout');
const without = score(holdout, naive);
const withSkill = score(holdout, (c) => applyRules(c, rules));
const lift = withSkill.pct - without.pct;

const lines = [
  '# Agent Web Router — local distill measure',
  '',
  empty ? 'Arm: **empty Distiller** (mutation).' : 'Arm: distilled `generated/rules.json`.',
  '',
  `| arm | holdout |`,
  `|---|---|`,
  `| without skill (first-match) | ${without.ok}/${without.n} (${(without.pct * 100).toFixed(0)}%) |`,
  `| with skill | ${withSkill.ok}/${withSkill.n} (${(withSkill.pct * 100).toFixed(0)}%) |`,
  `| lift | ${(lift * 100).toFixed(0)} pt |`,
  '',
  'Gold labels are `route()` / `checkHandoff`, not SKILL.md.',
  '',
  '### holdout',
  '',
  ...withSkill.rows.map((r) => {
    const w = without.rows.find((x) => x.id === r.id);
    return `- \`${r.id}\` gold=${r.gold ? 'TAKE' : 'REFUSE'} naive=${w.pred ? 'TAKE' : 'REFUSE'} skill=${r.pred ? 'TAKE' : 'REFUSE'} ${r.hit ? 'ok' : 'MISS'}`;
  }),
  '',
];

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'report.md'), lines.join('\n'));
process.stdout.write(lines.join('\n'));

if (empty && lift !== 0) {
  process.stderr.write('mutation failed: empty Distiller still produced lift\n');
  process.exit(2);
}
if (!empty && lift <= 0) {
  process.stderr.write('no lift on holdout — do not merge a SKILL.md hunk\n');
  process.exit(2);
}
