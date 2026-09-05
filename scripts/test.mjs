#!/usr/bin/env node
/**
 * Cross-platform test discovery with an explicit positive-count guard.
 *
 * Node's implicit discovery has changed between supported releases, and shell globs are
 * not expanded by every platform. Enumerating the files here makes "zero tests" a failure.
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(ROOT, 'test');
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(testDir, name));

if (files.length === 0) {
  process.stderr.write('agent-web-router: no test files found\n');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (result.error) {
  process.stderr.write(`agent-web-router: could not start tests: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
