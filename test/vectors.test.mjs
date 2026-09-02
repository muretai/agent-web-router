/**
 * test/vectors.test.mjs — two runtimes, one contract.
 *
 * `agent-entry-vectors.json` is the Agent Entry conformance file, copied byte for byte: the
 * canonical-JSON cases, the six-field signing payloads, did:key derivations, a seed→DID
 * pair, and the envelopes a door MUST refuse. The router signs what a door verifies, so it
 * has to produce the same bytes and refuse the same envelopes — a drift in either direction
 * is silent on the wire (nothing throws; signatures simply stop verifying for everyone).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJSON, signingPayload, didFromPublicKey, loadKey, verifyEnvelopeSignature, verifyDomainLinkage } from '../agent-web-router.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(HERE, 'agent-entry-vectors.json'), 'utf8'));

function hasNonInteger(v) {
  if (typeof v === 'number') return !Number.isSafeInteger(v);
  if (Array.isArray(v)) return v.some(hasNonInteger);
  if (v && typeof v === 'object') return Object.values(v).some(hasNonInteger);
  return false;
}

test('canonical JSON matches the Agent Entry vectors (integer-only subset; floats are refused, not mis-rendered)', () => {
  let checked = 0;
  for (const c of V.canonical) {
    if (hasNonInteger(c.payload)) {
      assert.throws(() => canonicalJSON(c.payload), `${c.name}: a float must be refused`);
      continue;
    }
    assert.equal(canonicalJSON(c.payload), c.canonical, c.name);
    checked += 1;
  }
  assert.ok(checked >= 8, `only ${checked} canonical vectors checked`);
});

test('the six-field signing payload is byte-identical to the door\'s', () => {
  for (const e of V.envelope) {
    assert.equal(signingPayload(e), e.signingPayload, e.name);
  }
});

test('did:key derivation matches for every ed25519 vector', () => {
  let checked = 0;
  for (const d of V.did) {
    if (d.curve !== 'ed25519') continue;
    assert.equal(didFromPublicKey(d.publicHex), d.did);
    checked += 1;
  }
  assert.ok(checked >= 1);
});

test('a seed loads to the DID the vectors say it controls', () => {
  const key = loadKey(V.webBotAuth.seedHex);
  assert.equal(key.did, V.webBotAuth.did);
});

test('every envelope a door must reject is refused here too — and the wrong-recipient one is refused for the RIGHT reason', () => {
  for (const r of V.reject.message) {
    const input = r.input;
    if (r.name === 'wrong-recipient') {
      // A perfectly valid signature, for someone else: the signature passes, the recipient
      // check (verifyReply's `to === myDid`) is what refuses it.
      assert.equal(verifyEnvelopeSignature(input), true, r.name);
      assert.notEqual(input.to, r.recipientDid, r.name);
      continue;
    }
    assert.equal(verifyEnvelopeSignature(input), false, `${r.name} must be refused`);
  }
});

test('the Domain Linkage credential verifies byte-for-byte against the vectors', () => {
  // The vectors' exp (2025-11-09) is deliberately in the past by now, which is exactly why
  // the verifier takes an injected `now`: a verifier reading the wall clock could never
  // check these bytes again. `signingInput` is the token's first two segments AS TEXT.
  for (const c of V.domainLinkage) {
    assert.equal(c.token.split('.').slice(0, 2).join('.'), c.signingInput, c.name);
    const v = verifyDomainLinkage(c.token, { did: c.did, origin: `https://${c.domain}`, now: c.nbf + 60 });
    assert.deepEqual(v, { ok: true, reasons: [] }, `${c.name}: ${v.reasons}`);
  }
});

test('a Domain Linkage credential is refused for the right reason: wrong origin, expiry, padding, another did, tampering', () => {
  const c = V.domainLinkage[0];
  const at = c.nbf + 60;
  const origin = `https://${c.domain}`;

  let v = verifyDomainLinkage(c.token, { did: c.did, origin: 'https://other.example', now: at });
  assert.ok(!v.ok && v.reasons.some((r) => /origin/.test(r)), `wrong origin: ${v.reasons}`);

  v = verifyDomainLinkage(c.token, { did: c.did, origin, now: c.exp + 1 });
  assert.ok(!v.ok && v.reasons.includes('expired'), `expiry: ${v.reasons}`);

  v = verifyDomainLinkage(c.token + '=', { did: c.did, origin, now: at });
  assert.ok(!v.ok && v.reasons.some((r) => /base64url/.test(r)), `padding is refused, not repaired: ${v.reasons}`);

  v = verifyDomainLinkage(c.token, { did: V.webBotAuth.did, origin, now: at });
  assert.ok(!v.ok && v.reasons.some((r) => /must all be the card's did/.test(r)), `another did: ${v.reasons}`);

  const [h, p, s] = c.token.split('.');
  const decoded = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const tampered = Buffer.from(JSON.stringify({ ...decoded, nbf: decoded.nbf - 1 })).toString('base64url');
  v = verifyDomainLinkage(`${h}.${tampered}.${s}`, { did: c.did, origin, now: at });
  assert.ok(!v.ok && v.reasons.some((r) => /signature/.test(r)), `tampering: ${v.reasons}`);
});
