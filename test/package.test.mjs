/**
 * Release guard: the version users install and the files npm selects must match this tree.
 * This test runs under `prepublishOnly`, so a false-green test command cannot ship drift.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const SOURCE = readFileSync(join(ROOT, 'agent-web-router.mjs'), 'utf8');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

function npmOutput(args) {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  }
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
}

test('package, runtime, and README versions stay in lockstep', () => {
  const runtime = SOURCE.match(/export const VERSION = '([^']+)'/)?.[1];
  assert.equal(runtime, PACKAGE.version);
  assert.match(README, new RegExp(`Status: \\*\\*${PACKAGE.version.replaceAll('.', '\\.')}\\*\\*`));
  assert.match(README, new RegExp(`agent-web-router ${PACKAGE.version.replaceAll('.', '\\.')} ·`));
});

test('npm selects the runnable package and its conformance tests', () => {
  const packed = JSON.parse(npmOutput(['pack', '--dry-run', '--json', '--ignore-scripts']))[0];
  assert.equal(packed.name, PACKAGE.name);
  assert.equal(packed.version, PACKAGE.version);

  const files = new Map(packed.files.map((file) => [file.path, file]));
  for (const path of [
    'agent-web-router.mjs',
    'bin/agent-web-router.mjs',
    'README.md',
    'LICENSE',
    'SKILL.md',
    'scripts/test.mjs',
    'spec/v0.md',
    'test/router.test.mjs',
    'test/vectors.test.mjs',
  ]) {
    assert.ok(files.has(path), `packed artifact is missing ${path}`);
  }
  assert.equal(PACKAGE.bin['agent-web-router'], './bin/agent-web-router.mjs');
  assert.match(readFileSync(join(ROOT, 'bin', 'agent-web-router.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\r?$/m);
  if (process.platform !== 'win32') {
    assert.ok((files.get('bin/agent-web-router.mjs').mode & 0o111) !== 0, 'packed CLI must remain executable');
  }
});
