/**
 * test/vectors.test.mjs — two runtimes, one contract.
 *
 * `wire_vectors.json` is the golden file agent-seam publishes, copied byte for byte: the
 * canonical-JSON cases, the six-field signing payloads, did:key derivations, a seed→DID
 * pair, and the envelopes a door MUST refuse. The router signs what a door verifies, so it
 * has to produce the same bytes and refuse the same envelopes — a drift in either direction
 * is silent on the wire (nothing throws; signatures simply stop verifying for everyone).
 *
 * It is the SUPERSET now (it also carries device bindings, owner state, relay tokens, invites
 * and sealed boxes), so a group this router does not implement is simply not read here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJSON, signingPayload, didFromPublicKey, loadKey, verifyEnvelopeSignature, verifyReply, verifyDomainLinkage } from '../agent-web-router.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(HERE, 'wire_vectors.json'), 'utf8'));

test('canonical JSON matches the wire vectors, every case', () => {
  let checked = 0;
  for (const c of V.canonical) {
    assert.equal(canonicalJSON(c.payload), c.canonical, c.name);
    checked += 1;
  }
  assert.ok(checked >= 14, `only ${checked} canonical vectors checked`);
});

// The refusal duty lives in `numberHazards`, not in `canonical`, and the distinction is the
// whole point: a `canonical` case is bytes every language reproduces, while a hazard is a
// value whose bytes DIFFER between languages (Python's float repr against JavaScript's).
// This router used to refuse every non-integer, including the ordinary decimals the contract
// renders identically everywhere — passing its own test while disagreeing with the wire.
//
// What a hazard actually demands is narrower and stranger: this runtime must never produce
// the bytes PYTHON produces for one. Three of them it refuses outright (exponent notation, an
// integer past 2^53). The other five it cannot even see: a JSON file cannot carry Python's
// `1.0` apart from `1`, so by the time they are parsed here they ARE integers, and the hazard
// belongs to a signer holding a float in memory, not to this file. Either way the duty is the
// same, and it is testable: never claim Python's spelling.
test('a value no two runtimes spell alike is never rendered as Python spells it', () => {
  const hazards = (V.numberHazards ?? []).filter((h) => h.signMustNotEmit);
  assert.ok(hazards.length >= 8, `only ${hazards.length} hazards to check`);
  for (const h of hazards) {
    let out = null;
    try { out = canonicalJSON(h.payload); } catch { out = null; }   // refusing outright is the strongest answer
    assert.notEqual(out, h.pythonCanonical, `${h.name}: this runtime must not claim to produce Python's bytes`);
  }
});

test('canonical JSON sorts object keys by Unicode code point, not UTF-16 code unit', () => {
  assert.equal(canonicalJSON({ '\u{10000}': 2, '\uE000': 1 }), '{"":1,"𐀀":2}');
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
    if (r.name === 'wire-names-its-own-recipient') {
      // Also a perfectly valid signature — the refusal is again the recipient dimension, and
      // the bait is an UNSIGNED `recipientDid` equal to the message's own `to`. A verifier
      // that read the recipient off the wire would compare the message against itself and
      // always agree. This router cannot: `verifyReply` takes `myDid` from its CALLER and
      // never looks at the envelope for it. Assert the bait is really there, that the
      // signature really passes (so a signature-only verifier would wrongly accept), and
      // that naming a different recipient still refuses.
      assert.equal(input.recipientDid, input.to, `${r.name}: the bait must equal \`to\``);
      assert.equal(verifyEnvelopeSignature(input), true, r.name);
      // Shape the reply exactly as verifyReply reads one, so 'not addressed to you' is the
      // ONLY reason left. A test whose subject fails for three reasons at once is not
      // testing the one it is named for.
      const asReply = {
        messageId: input.messageId,
        contextId: input.contextId ?? null,
        parts: [{ kind: 'text', text: input.text }],
        metadata: { from: input.from, to: input.to, timestamp: input.timestamp,
                    sig: input.sig, recipientDid: input.recipientDid },
      };
      const mine = verifyReply(asReply, { doorDid: input.from, myDid: input.to, now: input.timestamp });
      assert.deepEqual(mine.reasons, [], `${r.name}: the real recipient must find no fault`);
      const stranger = verifyReply(asReply, { doorDid: input.from, myDid: 'did:key:zStranger', now: input.timestamp });
      assert.deepEqual(stranger.reasons, ['not addressed to you'],
                       `${r.name}: a door that is not the recipient must refuse, and for THAT reason alone`);
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

test('a Domain Linkage credential is refused for the right reason: wrong origin, expiry, padding, a re-spelled signature, another did, tampering', () => {
  const c = V.domainLinkage[0];
  const at = c.nbf + 60;
  const origin = `https://${c.domain}`;

  let v = verifyDomainLinkage(c.token, { did: c.did, origin: 'https://other.example', now: at });
  assert.ok(!v.ok && v.reasons.some((r) => /origin/.test(r)), `wrong origin: ${v.reasons}`);

  v = verifyDomainLinkage(c.token, { did: c.did, origin, now: c.exp + 1 });
  assert.ok(!v.ok && v.reasons.includes('expired'), `expiry: ${v.reasons}`);

  v = verifyDomainLinkage(c.token + '=', { did: c.did, origin, now: at });
  assert.ok(!v.ok && v.reasons.some((r) => /base64url/.test(r)), `padding is refused, not repaired: ${v.reasons}`);

  // THE SIXTEEN SPELLINGS OF ONE SIGNATURE. The case above passes for a shallow reason — '='
  // is outside the alphabet — and an alphabet test is all this verifier used to have. A
  // 64-byte Ed25519 signature is 86 base64url characters: 516 bits carrying 512, so the LAST
  // character's low FOUR bits are discarded by the decoder and sixteen alphabet-clean strings
  // decode to the identical 64 bytes. All sixteen used to verify against this very vector.
  // One credential with sixteen token strings walks around any peer that caches, logs,
  // de-duplicates or revocation-lists a domain-linkage credential BY the token — and two
  // routers can disagree about whether they have seen the same credential. Exactly one
  // spelling re-encodes to itself; exactly one is the credential.
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const [sh, sp, ss] = c.token.split('.');
  assert.equal(ss.length, 86, 'an Ed25519 signature segment is 86 base64url characters');
  const keep = B64URL.indexOf(ss[85]) & 0b110000;   // the last character's two DATA bits
  const sixteen = Array.from({ length: 16 }, (_, i) => ss.slice(0, 85) + B64URL[keep | i]);
  assert.equal(new Set(sixteen).size, 16, 'sixteen distinct spellings');
  assert.ok(sixteen.includes(ss), 'the genuine signature must be one of the sixteen');
  const sigBytes = Buffer.from(ss, 'base64url');
  let accepted = 0;
  for (const alt of sixteen) {
    assert.ok(Buffer.from(alt, 'base64url').equals(sigBytes),
              `...${alt.slice(-4)} must decode to the same 64 bytes, or this case proves nothing`);
    const r = verifyDomainLinkage(`${sh}.${sp}.${alt}`, { did: c.did, origin, now: at });
    if (alt === ss) {
      assert.deepEqual(r, { ok: true, reasons: [] }, 'the genuine spelling must still verify');
      accepted += 1;
      continue;
    }
    assert.notEqual(Buffer.from(alt, 'base64url').toString('base64url'), alt,
                    `...${alt.slice(-4)} must be a residual spelling: it does not re-encode to itself`);
    // The reason must be the CREDENTIAL's shape and nothing else — not an expiry, not an
    // origin, not a signature that happened not to verify. A negative case that passes for an
    // incidental reason is the defect this whole file keeps finding.
    assert.deepEqual(r.reasons, ['not unpadded base64url compact JWS — refused, not repaired'],
                     `a re-spelled signature (...${alt.slice(-4)}) must be refused as a malformed credential, and for THAT reason alone`);
  }
  assert.equal(accepted, 1, 'exactly one of the sixteen spellings is the credential');

  // Only the SIGNATURE is malleable that way, and that is checked rather than remembered: the
  // signing input is the LITERAL text of the header and payload segments, so a re-spelling of
  // either breaks the signature on its own — the gate simply refuses it earlier.
  const spare = { 0: 1, 2: 4, 3: 2 }[sp.length % 4];
  const pkeep = B64URL.indexOf(sp[sp.length - 1]) & ~(spare - 1);
  for (let i = 0; i < spare; i++) {
    const alt = sp.slice(0, -1) + B64URL[pkeep | i];
    if (alt === sp) continue;
    assert.ok(Buffer.from(alt, 'base64url').equals(Buffer.from(sp, 'base64url')), 'same payload bytes');
    const r = verifyDomainLinkage(`${sh}.${alt}.${ss}`, { did: c.did, origin, now: at });
    assert.ok(!r.ok, `a re-spelled payload must never verify: ...${alt.slice(-4)} -> ${JSON.stringify(r.reasons)}`);
  }

  v = verifyDomainLinkage(c.token, { did: V.webBotAuth.did, origin, now: at });
  assert.ok(!v.ok && v.reasons.some((r) => /must all be the card's did/.test(r)), `another did: ${v.reasons}`);

  const [h, p, s] = c.token.split('.');
  const decoded = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const tampered = Buffer.from(JSON.stringify({ ...decoded, nbf: decoded.nbf - 1 })).toString('base64url');
  v = verifyDomainLinkage(`${h}.${tampered}.${s}`, { did: c.did, origin, now: at });
  assert.ok(!v.ok && v.reasons.some((r) => /signature/.test(r)), `tampering: ${v.reasons}`);
});
