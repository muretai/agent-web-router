/**
 * test/wire-twin.test.mjs — the vendored wire layer and vectors are unedited.
 *
 * `wire.mjs` and `test/wire_vectors.json` are copies of files that live in
 * https://github.com/muretai/agent-wire, which publishes the byte contract on its own. This
 * router does not own those bytes; it reproduces them. A copy that drifts is silent on the
 * wire — this router would sign payloads no door accepts, and nothing would throw.
 *
 * Pinned two ways: to the digest recorded when they were vendored (which runs anywhere,
 * including a fresh `npm install`), and to agent-wire itself when it is checked out beside
 * this repository. Re-vendor with:
 *
 *     cp ../agent-wire/js/wire.mjs wire.mjs
 *     cp ../agent-wire/vectors/wire_vectors.json test/wire_vectors.json
 *     # then update the two digests below
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIRE_ROOT = resolve(ROOT, process.env.MURETAI_AGENT_WIRE || '../agent-wire');

/** sha256 as vendored on 2026-09-07, from agent-wire main 9f0c648. */
const PINNED = [
  { mine: 'wire.mjs', theirs: 'js/wire.mjs', sha: '21fbf01e6538f49059b88f9c32662c67fae133b7d8ec6cd28ec89d917aab61e1' },
  { mine: 'test/wire_vectors.json', theirs: 'vectors/wire_vectors.json', sha: 'e03e083f644167a67132638ab74fd1c62667db2733fb58466dce2644feca39c2' },
];

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

for (const f of PINNED) {
  test(`${f.mine} is the vendored copy, unedited`, () => {
    assert.equal(sha256(join(ROOT, f.mine)), f.sha,
      `${f.mine} does not match the digest recorded when it was vendored — it was edited here `
      + '(it must not be: edit it upstream) or re-vendored without updating this file');
  });

  test(`${f.mine} matches agent-wire, when agent-wire is beside us`, (t) => {
    const upstream = join(WIRE_ROOT, f.theirs);
    if (!existsSync(upstream)) return t.skip(`no agent-wire checkout at ${WIRE_ROOT}`);
    assert.equal(sha256(join(ROOT, f.mine)), sha256(upstream),
      `agent-wire's ${f.theirs} has moved — re-vendor it and update the digest here`);
  });
}
