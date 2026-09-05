/**
 * Public library composition tests. These exercise the values a caller receives from
 * probe(), rather than the CLI wrapper, so a safe CLI cannot hide an unsafe API seam.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkHandoff, parseHandoff, usableCard } from '../agent-web-router.mjs';

const ORIGIN = 'https://shop.example';
const DID = 'did:key:z6MkExampleDooraaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RAW_CARD = { did: DID, url: `${ORIGIN}/` };
const HANDOFF = parseHandoff({ _meta: { handoff: { v: 1, next: [{ kind: 'dm', to: DID }] } } });

function cardInfo(overrides = {}) {
  return {
    found: true,
    did: DID,
    url: `${ORIGIN}/`,
    originBound: true,
    signed: 'absent',
    card: RAW_CARD,
    ...overrides,
  };
}

test('checkHandoff requires the probe card record, not an untrusted raw card', () => {
  const raw = checkHandoff(HANDOFF, { origin: ORIGIN, card: RAW_CARD });
  assert.equal(raw.accepted.length, 0);
  assert.match(raw.refused[0].reason, /no usable card/);

  const probed = checkHandoff(HANDOFF, { origin: ORIGIN, card: cardInfo() });
  assert.equal(probed.refused.length, 0);
  assert.equal(probed.accepted.length, 1);
});

test('a usable card record from another origin cannot authorize a URL-only handoff', () => {
  const foreignOrigin = 'https://other.example';
  const foreignCard = { did: DID, url: `${foreignOrigin}/` };
  const foreignInfo = cardInfo({
    url: foreignCard.url,
    card: foreignCard,
  });
  const handoff = parseHandoff({ _meta: { handoff: { v: 1, next: [
    { kind: 'a2a', endpoint: `${foreignOrigin}/rpc` },
  ] } } });
  const verdict = checkHandoff(handoff, { origin: ORIGIN, card: foreignInfo });
  assert.equal(verdict.accepted.length, 0);
  assert.match(verdict.refused[0].reason, /leaves the origin/);
});

test('card-only and endpoint-only forms are valid for a2a, never for dm', () => {
  for (const entry of [
    { kind: 'dm', card: `${ORIGIN}/.well-known/agent-card.json` },
    { kind: 'dm', endpoint: `${ORIGIN}/rpc` },
  ]) {
    assert.equal(parseHandoff({ handoff: { v: 1, next: [entry] } }), null);
  }
});

test('usableCard rejects failed, off-origin, and internally inconsistent probe records', () => {
  assert.equal(usableCard(cardInfo()), RAW_CARD);
  assert.equal(usableCard(cardInfo({ signed: false })), null);
  assert.equal(usableCard(cardInfo({ originBound: false })), null);
  assert.equal(usableCard(cardInfo({ did: 'did:key:z6MkExampleOtheraaaaaaaaaaaaaaaaaaaaaaaa' })), null);
  assert.equal(usableCard(RAW_CARD), null);
});
