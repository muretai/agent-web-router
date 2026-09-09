/**
 * The local distill loop, exercised the way an operator exercises it:
 * gold labels come from route()/checkHandoff (the product), not from SKILL.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRules, inferRules, label, loadCases, naive, skillGaps, tracesFromCases,
} from '../scripts/distill/lib.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function score(cases, decide) {
  let ok = 0;
  for (const c of cases) {
    if (decide(c) === label(c).take) ok += 1;
  }
  return cases.length ? ok / cases.length : 0;
}

test('environment labels refuse a card with no did', () => {
  const c = loadCases().find((x) => x.id === 'no-did');
  assert.equal(label(c).take, false);
  assert.match(label(c).feedback, /names no did/i);
  assert.equal(naive(c), true, 'first-match still takes a card that has a url');
});

test('environment labels refuse a rewritten handoff to', () => {
  const c = loadCases().find((x) => x.id === 'handoff-other-did');
  assert.equal(label(c).take, false);
  assert.equal(naive(c), true);
});

test('distilled rules beat first-match on holdout', () => {
  const cases = loadCases();
  const rules = inferRules(tracesFromCases(cases, 'train'));
  const holdout = cases.filter((c) => c.split === 'holdout');
  const without = score(holdout, naive);
  const withSkill = score(holdout, (c) => applyRules(c, rules));
  assert.ok(withSkill > without, `expected lift, got without=${without} with=${withSkill}`);
  assert.equal(withSkill, 1, 'skill should clear the whole holdout');
});

test('empty Distiller produces no lift (producer mutation)', () => {
  const holdout = loadCases().filter((c) => c.split === 'holdout');
  const without = score(holdout, naive);
  const withEmpty = score(holdout, (c) => applyRules(c, { empty: true }));
  assert.equal(withEmpty, without);
});

// THE DIRECTION THAT WAS NEVER TESTED. `skillGaps` was exercised only through the test
// below, which runs against the SKILL.md in this tree — and that file already states every
// demonstrated rule, so the only branch ever taken asserted that the helper stayed SILENT.
// A `skillGaps` gutted to `return []` passed the whole suite. Silence is the easy half: the
// helper's job is to SPEAK when the skill omits a rule the traces demonstrated, and that
// half must be pinned against a text this repository controls rather than against SKILL.md,
// whose wording changes every time the loop is dogfooded.
test('skillGaps names every demonstrated rule the skill does not state', () => {
  const rules = inferRules(tracesFromCases(loadCases(), 'train'));
  // An empty skill states nothing, so every rule the traces demonstrate is an open gap.
  const gaps = skillGaps(rules, '');
  assert.deepEqual(
    gaps.map((g) => g.rule).sort(),
    ['handoff_to_must_eq_card', 'refuse_invalid_sig', 'require_did', 'require_origin_bound'],
    'a skill that says nothing must leave every demonstrated rule open',
  );
  for (const g of gaps) {
    assert.ok(typeof g.bullet === 'string' && g.bullet.length > 20,
              `${g.rule}: a gap must carry the sentence that closes it, not just a name`);
  }
});

// ...and the mirror, so "speaks up" cannot be satisfied by a helper that speaks up ALWAYS.
// The sentences are the ones SKILL.md carries today, quoted here as literals: this test
// reads no file, so it pins the helper rather than the current wording of the skill.
test('skillGaps goes quiet, rule by rule, as the skill states each one', () => {
  const rules = inferRules(tracesFromCases(loadCases(), 'train'));
  const stated = {
    require_did: 'If the card names no `did`, there is no door — a reply could not be verified.',
    require_origin_bound: 'The card must have been served by the origin you dialled, and its `url` must be on that origin.',
    refuse_invalid_sig: 'If it exists and fails, refuse the door.',
    handoff_to_must_eq_card: "For each entry: a `to` must equal the card's `did`.",
  };
  const open = () => skillGaps(rules, '').map((g) => g.rule).sort();
  let text = '';
  const remaining = open();
  for (const [rule, sentence] of Object.entries(stated)) {
    assert.ok(remaining.includes(rule), `${rule} must start open, or this case proves nothing`);
    text += `${sentence}\n`;
    const still = skillGaps(rules, text).map((g) => g.rule);
    assert.ok(!still.includes(rule), `stating "${sentence}" must close ${rule}`);
  }
  assert.deepEqual(skillGaps(rules, text).map((g) => g.rule), [],
                   'a skill stating all four rules leaves no gap open');
});

test('SKILL.md is missing the no-did refusal until the loop writes it', () => {
  const skillMd = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
  const rules = inferRules(tracesFromCases(loadCases(), 'train'));
  const gaps = skillGaps(rules, skillMd);
  // After dogfood this may already be filled. The test asserts the helper
  // agrees with the file, not that the gap stays open forever.
  if (/names no `did`/.test(skillMd)) {
    assert.ok(!gaps.some((g) => g.rule === 'require_did'));
  } else {
    assert.ok(gaps.some((g) => g.rule === 'require_did'));
  }
});
