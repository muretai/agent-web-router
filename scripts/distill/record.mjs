#!/usr/bin/env node
/**
 * Append a probe / handoff / knock --json document to a LOCAL jsonl file.
 * Nothing here phones home. Default path: var/traces.jsonl (gitignored).
 *
 *   npx @muretai/agent-web-router probe https://shop.example --json | node scripts/distill/record.mjs
 *   node scripts/distill/record.mjs --file /tmp/mine.jsonl < probe.json
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function usage(code = 1) {
  process.stderr.write(
    'usage: record.mjs [--file <path>]\n'
    + '  pipe probe/knock/handoff --json on stdin.\n'
    + '  writes only to the path you name. never uploads.\n',
  );
  process.exit(code);
}

function parseArgs(argv) {
  const out = { file: process.env.AWR_TRACES || resolve(ROOT, 'var/traces.jsonl') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') { out.file = resolve(argv[++i] || ''); continue; }
    if (argv[i] === '--help' || argv[i] === '-h') usage(0);
    usage();
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const raw = readFileSync(0, 'utf8');
if (!raw.trim()) {
  process.stderr.write('record.mjs: stdin is empty — pipe probe --json here\n');
  process.exit(1);
}

let doc;
try {
  doc = JSON.parse(raw);
} catch (e) {
  process.stderr.write(`record.mjs: stdin is not JSON: ${e.message}\n`);
  process.exit(1);
}

const row = {
  recorded_at: new Date().toISOString(),
  source: 'stdin',
  doc,
};
mkdirSync(dirname(args.file), { recursive: true });
appendFileSync(args.file, JSON.stringify(row) + '\n');
process.stdout.write(`recorded 1 row → ${args.file}\n`);
