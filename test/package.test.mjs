/**
 * Release guard: the version users install and the files npm selects must match this tree.
 * This test runs under `prepublishOnly`, so a false-green test command cannot ship drift.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
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
    // The vendored seam `main` imports on its first line. A `files` edit that drops it ships
    // a package whose entry point throws ERR_MODULE_NOT_FOUND on `import`, and every test in
    // THIS tree still passes, because the tests import from the tree and not from the tarball.
    'seam.mjs',
    // Read (not imported) by the packed test above, so no import scan can see it. Without it
    // the conformance test we just insisted on packing cannot run at all.
    'test/wire_vectors.json',
  ]) {
    assert.ok(files.has(path), `packed artifact is missing ${path}`);
  }
  assert.equal(PACKAGE.bin['agent-web-router'], './bin/agent-web-router.mjs');
  assert.match(readFileSync(join(ROOT, 'bin', 'agent-web-router.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\r?$/m);
  if (process.platform !== 'win32') {
    assert.ok((files.get('bin/agent-web-router.mjs').mode & 0o111) !== 0, 'packed CLI must remain executable');
  }
});

/**
 * THE LIST ABOVE CANNOT BE THE WHOLE GUARD, because a list goes stale: it names what someone
 * thought to name on the day they wrote it, and `seam.mjs` — the file `main` imports on its
 * first line — sat unnamed in it for as long as it existed. So the import graph is checked
 * rather than remembered: every relative specifier reachable from the packed `.mjs` files
 * must resolve to a path that is ALSO in the tarball. A `files` edit that drops a module
 * anything packed imports now fails here, whether or not anyone remembered to list it.
 *
 * It closes the import dimension and only that dimension: a file merely READ at runtime
 * (`test/wire_vectors.json`) is invisible to any static scan, which is why the explicit list
 * still names it. Comments are stripped before scanning so that prose about a path is not
 * mistaken for an import of it.
 */
test('every module the packed files import is itself packed', () => {
  const packed = JSON.parse(npmOutput(['pack', '--dry-run', '--json', '--ignore-scripts']))[0];
  const inTarball = new Set(packed.files.map((file) => file.path));

  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

  const PATTERNS = [
    /\bfrom\s*['"](\.[^'"]+)['"]/g,          // a static  import ... from  specifier
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,    // a dynamic import(...) call
    /^\s*import\s+['"](\.[^'"]+)['"]/gm,       // a bare side-effect import
  ];

  let found = 0;
  for (const entry of packed.files) {
    if (!entry.path.endsWith('.mjs')) continue;
    const source = stripComments(readFileSync(join(ROOT, entry.path), 'utf8'));
    for (const pattern of PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const target = posix.normalize(posix.join(posix.dirname(entry.path), match[1]));
        assert.ok(inTarball.has(target),
                  `${entry.path} imports ${match[1]}, but ${target} is not in the tarball — `
                  + 'the published package cannot load it');
        found += 1;
      }
    }
  }
  // A scan that matched nothing would pass over every packed file in silence — the exact
  // defect this test exists to close. The floor is what the tree resolves today.
  assert.ok(found >= 10,
            `only ${found} relative import(s) resolved across the packed .mjs files; the scan `
            + 'matched less than it did when this floor was set, so it is no longer checking '
            + 'the import graph');
});
