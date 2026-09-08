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

/** agent-seam v0.3.0 (dcefaae), vendored 2026-09-08. sha256 of each file as written here. */
const PINNED_REF = 'v0.3.0';
const PINNED_COMMIT = 'dcefaaecb7b92e222af820fca45bc56f90e22016';
const PINNED = [
  { mine: 'seam.mjs', theirs: 'js/seam.mjs', sha: '8c8d04d8c59cec2aae2337e9d8ef90361b199c0b969dd1ea9c0741b318f6dbf7' },
  { mine: 'test/wire_vectors.json', theirs: 'vectors/wire_vectors.json', sha: '31d256cb4f360481865551dd63492fbb5a955a2c146c870b33133ffb30704841' },
];

// A floor: the two files this package vendors are named HERE, so an emptied PINNED list
// cannot pass by pinning nothing (the for-loop below would simply emit no tests).
test('the pin names both vendored files', () => {
  assert.deepEqual(PINNED.map((f) => f.mine).sort(), ['seam.mjs', 'test/wire_vectors.json']);
  for (const f of PINNED) assert.match(f.sha, /^[0-9a-f]{64}$/, `${f.mine} has a full sha256`);
  assert.match(PINNED_COMMIT, /^[0-9a-f]{40}$/);
});

// This router carries one number the seam pins but does not export: the card-envelope version
// it requires an envelope to declare (see agent-web-router.mjs, "this router's own gate"). A
// local copy of a contract constant is exactly the drift this repository stopped writing, so
// it is read back out of the bytes the seam actually signs.
test('the card-envelope version this router requires is the one the seam signs', async () => {
  const { CARD_ENVELOPE_VERSION_HERE, cardEnvelopePayload } = await import('../agent-web-router.mjs');
  const payload = JSON.parse(cardEnvelopePayload({ did: 'did:key:zTest', name: 'x' }, 1788000000));
  assert.equal(payload.v, CARD_ENVELOPE_VERSION_HERE,
    `the seam signs v=${payload.v}; this router requires v=${CARD_ENVELOPE_VERSION_HERE}`);
});

// The router carries a second thing the seam pins but does not export: `strictB64Url`, the
// rule that gives an unpadded base64url string exactly ONE spelling (alphabet, length not
// congruent to 1 mod 4, and a re-encode that returns the input character for character). The
// seam keeps it module-private, so `verifyDomainLinkage` restates it — and two copies of one
// rule are only safe while they accept the SAME SET. A copy that is merely similar is a new
// split: whichever side is more permissive becomes the hole. Both are lifted out of their
// source text and compared input by input, so the guarantee is behavioural, not a promise in
// a comment. When upstream exports `strictB64Url`, delete the router's copy, import it, and
// this test with it.
/** The rule as its own source file writes it, lifted out and made callable. The router spells
 *  the alphabet constant `B64URL_ALPHABET` and the seam spells it `WBA_B64URL`; that rename is
 *  the ONLY difference either side is allowed. */
const liftStrictB64Url = (file) => {
  const src = readFileSync(join(ROOT, file), 'utf8').replace(/B64URL_ALPHABET/g, 'WBA_B64URL');
  const alphabet = src.match(/const WBA_B64URL = [^\n]*/);
  const fn = src.match(/function strictB64Url\(value\) \{[\s\S]*?\n\}/);
  assert.ok(alphabet && fn,
    `could not find strictB64Url in ${file} — it moved or was renamed. Re-check BY HAND that the `
    + "router's copy accepts exactly what the seam's does, then repair this lift");
  // eslint-disable-next-line no-new-func -- the two rules are compared as CODE, on purpose
  return new Function('Buffer', `${alphabet[0]}\n${fn[0]}\nreturn strictB64Url;`)(Buffer);
};

test("the router's strictB64Url accepts exactly what the seam's does", () => {
  const seam = liftStrictB64Url('seam.mjs');
  const router = liftStrictB64Url('agent-web-router.mjs');

  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const dirty = [...A, '+', '/', '=', '.', ' ', '\n', 'e\u0301'];
  const cases = new Set(['']);
  for (const a of dirty) { cases.add(a); for (const b of dirty) cases.add(a + b); }
  for (const a of dirty) for (const b of dirty) for (const c of '-_A9+/=') cases.add(a + b + c);
  // every residue class at every realistic length, 43 (a key) and 86 (a signature) included
  const run = 'A'.repeat(90);
  for (let n = 0; n <= 90; n += 1) for (const last of A) cases.add(run.slice(0, n) + last);

  let compared = 0;
  for (const v of cases) {
    const a = seam(v);
    const b = router(v);
    const same = a === null ? b === null : b !== null && Buffer.compare(a, b) === 0;
    assert.ok(same, `the two rules disagree about ${JSON.stringify(v)}: seam=${a === null ? 'refused' : a.toString('hex')}, router=${b === null ? 'refused' : b.toString('hex')}`);
    compared += 1;
  }
  for (const v of [null, undefined, 42, 0, {}, [], true, Buffer.from('ab')]) {
    assert.equal(seam(v) === null, router(v) === null, `the two rules disagree about ${String(v)}`);
  }
  assert.ok(compared > 5000, `only ${compared} strings compared`);
  // The two corner cases the seam spells out, named here so a copy cannot quietly drop either.
  assert.equal(seam('').length, 0, 'the seam accepts the empty string');
  assert.equal(router('').length, 0, "the router's copy accepts the empty string too — length is the CALLER's rule");
  assert.equal(seam('A'), null);
  assert.equal(router('A'), null, 'a length congruent to 1 mod 4 carries 6 bits and no byte');
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
