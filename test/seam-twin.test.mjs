/**
 * test/seam-twin.test.mjs — the vendored seam and vectors are unedited, and the pin is honest.
 *
 * `seam.mjs` and `test/wire_vectors.json` are copies of files whose home is
 * https://github.com/muretai/agent-seam, which publishes the byte contract on its own. This
 * router does not own those bytes; it reproduces them. A copy that drifts is silent on the
 * wire — this router would sign payloads no door accepts, and nothing would throw.
 *
 * Pinned two ways. ALWAYS: to the sha256 recorded below when they were vendored, which runs
 * anywhere, including a fresh `npm install`, and needs no agent-seam checkout. ONLY WHEN
 * agent-seam is checked out beside this repository (../agent-seam, or $MURETAI_AGENT_SEAM):
 * the recorded commit really produces every vendored byte (`git show <commit>:<path>`), so the
 * pin cannot name a commit it was not taken from — and a note says how many commits behind
 * that checkout's HEAD the pin is. A missing sibling is one `skip:` line, never a failure.
 *
 * Re-vendor (only this way; a vendored file is never edited here, and nothing here writes
 * into agent-seam):
 *
 *     git -C ../agent-seam show <ref>:js/seam.mjs > seam.mjs
 *     git -C ../agent-seam show <ref>:vectors/wire_vectors.json > test/wire_vectors.json
 *     # then set PINNED_REF, PINNED_COMMIT and the two digests below to what you took
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEAM_ROOT = resolve(ROOT, process.env.MURETAI_AGENT_SEAM || '../agent-seam');
const SIBLING = existsSync(join(SEAM_ROOT, '.git'));

/** agent-seam v0.2.0 (201ab05), vendored 2026-09-07. sha256 of each file as written here. */
const PINNED_REF = 'v0.2.0';
const PINNED_COMMIT = '201ab05e93745864e02a8476d75bf41e87725f16';
const PINNED = [
  { mine: 'seam.mjs', theirs: 'js/seam.mjs', sha: '01878be5b0b4954c089e9e5cc9d5da155060924660b88736f8537f23cdc2e272' },
  { mine: 'test/wire_vectors.json', theirs: 'vectors/wire_vectors.json', sha: 'e03e083f644167a67132638ab74fd1c62667db2733fb58466dce2644feca39c2' },
];

// A floor: the two files this package vendors are named HERE, so an emptied PINNED list
// cannot pass by pinning nothing (the for-loop below would simply emit no tests).
test('the pin names both vendored files', () => {
  assert.deepEqual(PINNED.map((f) => f.mine).sort(), ['seam.mjs', 'test/wire_vectors.json']);
  for (const f of PINNED) assert.match(f.sha, /^[0-9a-f]{64}$/, `${f.mine} has a full sha256`);
  assert.match(PINNED_COMMIT, /^[0-9a-f]{40}$/);
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mine = (f) => readFileSync(join(ROOT, f.mine));
const git = (...a) => execFileSync('git', ['-C', SEAM_ROOT, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
const short = PINNED_COMMIT.slice(0, 7);

if (!SIBLING) {
  console.log(`skip: no agent-seam checkout at ${SEAM_ROOT} — the pin is verified by digest only (set MURETAI_AGENT_SEAM to check the recorded commit too)`);
}

for (const f of PINNED) {
  test(`${f.mine} is the vendored copy, unedited`, () => {
    assert.equal(sha256(mine(f)), f.sha,
      `${f.mine} does not match the digest recorded when it was vendored — it was edited here `
      + '(it must not be: edit it upstream) or re-vendored without updating this file');
  });

  test(`${f.mine} is what agent-seam ${short} produces, when agent-seam is beside us`, (t) => {
    if (!SIBLING) return t.skip(`no agent-seam checkout at ${SEAM_ROOT}`);
    let theirs = null;
    try { theirs = git('show', `${PINNED_COMMIT}:${f.theirs}`); } catch { /* reported below */ }
    assert.ok(theirs !== null,
      `${SEAM_ROOT} has no ${f.theirs} at ${short} — a stale checkout (fetch it), or a pin that lies`);
    assert.ok(theirs.equals(mine(f)),
      `the pin lies: ${f.theirs} at ${short} is ${sha256(theirs).slice(0, 12)}, the copy here is ${sha256(mine(f)).slice(0, 12)}`);
  });
}

test(`the pin ${PINNED_REF} (${short}) is a commit agent-seam knows, and how far behind its HEAD it is`, (t) => {
  if (!SIBLING) return t.skip(`no agent-seam checkout at ${SEAM_ROOT}`);
  let known = true;
  try { git('cat-file', '-e', `${PINNED_COMMIT}^{commit}`); } catch { known = false; }
  assert.ok(known, `${SEAM_ROOT} does not have commit ${short} — a stale checkout (fetch it), or a pin that lies`);
  // The tag may not have been fetched there; when it has, it must name the pinned commit.
  let tagAt = null;
  try { tagAt = git('rev-parse', '--verify', '--quiet', `${PINNED_REF}^{commit}`).toString().trim(); } catch { /* no such tag there */ }
  if (tagAt !== null) {
    assert.equal(tagAt, PINNED_COMMIT, `${SEAM_ROOT} says ${PINNED_REF} is ${tagAt.slice(0, 7)}, not ${short} — PINNED_REF and PINNED_COMMIT disagree`);
  }
  const behind = git('rev-list', '--count', `${PINNED_COMMIT}..HEAD`).toString().trim();
  const head = git('rev-parse', '--short', 'HEAD').toString().trim();
  console.log(`  sibling: ${SEAM_ROOT} — pin ${PINNED_REF} (${short}) is ${behind} commit(s) behind its HEAD ${head}`);
});
