#!/usr/bin/env node
/**
 * Traces → rules.json + a proposed SKILL.md hunk.
 * Labels come from route()/checkHandoff (called in lib.mjs). Distiller itself
 * only sees features + environment_take. Empty Distiller is --empty (mutation).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCases, tracesFromCases, inferRules, renderHunk, skillGaps, readJsonl, features, label,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = resolve(ROOT, 'generated');

function caseFromDoc(doc, id) {
  if (doc.kind === 'route' || doc.kind === 'handoff') return { ...doc, id: doc.id || id };
  if (doc.ways) {
    const card = doc.ways.card || {};
    const mcp = doc.ways.mcp || {};
    const page = doc.ways.page || {};
    return {
      id,
      kind: 'route',
      split: 'local',
      onHand: doc.route?.onHand || doc.onHand || { key: true },
      ways: {
        card: {
          found: Boolean(card.found),
          did: card.did || null,
          url: card.url || null,
          originBound: card.originBound === true,
          signed: card.signed,
          skills: Array.isArray(card.skills) ? card.skills : [],
          prefer: card.prefer ?? null,
        },
        mcp: {
          declared: Boolean(mcp.declared),
          url: mcp.url || null,
          originBound: mcp.originBound === true,
          openAccess: Boolean(mcp.openAccess),
        },
        page: {
          reachable: Boolean(page.reachable),
          declarativeTools: Array.isArray(page.declarativeTools) ? page.declarativeTools : [],
          imperativeHint: page.imperativeHint ?? null,
          robotsAllowRoot: page.robotsAllowRoot,
        },
      },
    };
  }
  if (doc.handoff && doc.origin) {
    return {
      id,
      kind: 'handoff',
      split: 'local',
      origin: doc.origin,
      card: { did: doc.cardDid || doc.card?.did || null, url: doc.card?.url || `${doc.origin}/` },
      result: { _meta: { handoff: doc.handoff } },
    };
  }
  return null;
}

function localTraces(path) {
  const rows = readJsonl(path);
  const out = [];
  let i = 0;
  for (const row of rows) {
    const doc = row.doc || row;
    const c = caseFromDoc(doc, row.id || `local-${++i}`);
    if (!c) continue;
    const env = label(c);
    out.push({
      id: c.id,
      kind: c.kind,
      features: features(c),
      worker_take: false,
      environment_take: env.take,
      feedback: env.feedback,
      success: false,
      _case: c,
    });
  }
  return out;
}

const empty = process.argv.includes('--empty');
const tracesPath = process.env.AWR_TRACES || resolve(ROOT, 'var/traces.jsonl');
const train = tracesFromCases(loadCases(), 'train');
const local = existsSync(tracesPath) ? localTraces(tracesPath) : [];
const rules = empty ? { empty: true, evidence: [] } : inferRules([...train, ...local]);

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'rules.json'), JSON.stringify(rules, null, 2) + '\n');

const skillMd = readFileSync(resolve(ROOT, 'SKILL.md'), 'utf8');
const gaps = rules.empty ? [] : skillGaps(rules, skillMd);
const hunk = renderHunk(rules, gaps);
writeFileSync(resolve(OUT, 'SKILL.hunk.md'), hunk);

const R = {
  traces: train.length + local.length,
  local: local.length,
  empty,
  rules: { ...rules, evidence: undefined },
  gaps: gaps.map((g) => g.rule),
};
writeFileSync(resolve(OUT, 'R.json'), JSON.stringify(R, null, 2) + '\n');

process.stdout.write(
  `distilled ${train.length} fixture + ${local.length} local traces`
  + (empty ? ' (empty Distiller)' : '')
  + ` → generated/rules.json\n`
  + (gaps.length ? `SKILL.md gaps: ${gaps.map((g) => g.rule).join(', ')}\n` : 'SKILL.md already states the demonstrated rules\n'),
);
