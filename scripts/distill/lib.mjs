/**
 * Local feedback loop helpers. Labels come from route()/checkHandoff — the
 * product — never from reading SKILL.md. Distiller never imports those
 * functions; it sees traces only.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, parseHandoff, checkHandoff } from '../../agent-web-router.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadCases() {
  const raw = JSON.parse(readFileSync(join(HERE, 'fixtures.json'), 'utf8'));
  return raw.cases;
}

/** Environment: what the shipped router actually decides. */
export function label(case_) {
  if (case_.kind === 'route') {
    const decision = route(case_.ways, case_.onHand || {});
    const takeCard = decision.routes.some((r) => r.kind === 'card');
    const takeMcp = decision.routes.some((r) => r.kind === 'mcp');
    const take = takeCard || takeMcp;
    const why = take
      ? (decision.routes[0]?.why || '')
      : ((decision.excluded.find((x) => x.kind === 'card' && x.why)
        || decision.excluded.find((x) => x.kind === 'mcp')
        || decision.routes[0] || {}).why || '');
    return {
      take,
      takeCard,
      feedback: why,
      decision,
    };
  }
  const handoff = parseHandoff(case_.result);
  const { accepted, refused } = checkHandoff(handoff, {
    origin: case_.origin,
    card: case_.card,
  });
  return {
    take: accepted.length > 0 && refused.length === 0,
    takeCard: false,
    feedback: refused[0]?.reason || 'handoff accepted',
    decision: { accepted, refused },
  };
}

/** Unguided visitor: a card that exists is a door; a `to` is a destination. */
export function naive(case_) {
  if (case_.kind === 'route') {
    const c = case_.ways.card || {};
    if (c.found && (c.did || c.url)) return true;
    const m = case_.ways.mcp || {};
    return Boolean(m.declared && m.url);
  }
  const to = case_.result?._meta?.handoff?.next?.[0]?.to;
  return Boolean(to && String(to).startsWith('did:key:'));
}

export function features(case_) {
  if (case_.kind === 'route') {
    const c = case_.ways.card || {};
    const m = case_.ways.mcp || {};
    return {
      kind: 'route',
      cardFound: Boolean(c.found),
      hasDid: Boolean(c.did),
      originBound: c.originBound === true,
      sigInvalid: c.signed === false,
      mcpDeclared: Boolean(m.declared),
      mcpOriginBound: m.originBound === true,
    };
  }
  const to = case_.result?._meta?.handoff?.next?.[0]?.to || '';
  const cardDid = case_.card?.did || '';
  return {
    kind: 'handoff',
    toEqCard: Boolean(to && cardDid && to === cardDid),
    toSet: Boolean(to),
  };
}

export function inferRules(traces) {
  const rules = {
    empty: traces.length === 0,
    require_did: false,
    require_origin_bound: false,
    refuse_invalid_sig: false,
    mcp_require_origin_bound: false,
    handoff_to_must_eq_card: false,
    evidence: [],
  };
  for (const tr of traces) {
    rules.evidence.push({
      id: tr.id,
      take: tr.environment_take,
      feedback: tr.feedback,
    });
    const f = tr.features;
    if (!tr.environment_take && f.kind === 'route') {
      if (f.cardFound && !f.hasDid) rules.require_did = true;
      if (f.cardFound && f.hasDid && !f.originBound) rules.require_origin_bound = true;
      if (f.cardFound && f.sigInvalid) rules.refuse_invalid_sig = true;
      if (f.mcpDeclared && !f.mcpOriginBound) rules.mcp_require_origin_bound = true;
    }
    if (!tr.environment_take && f.kind === 'handoff' && f.toSet && !f.toEqCard) {
      rules.handoff_to_must_eq_card = true;
    }
  }
  return rules;
}

export function applyRules(case_, rules) {
  if (rules.empty) return naive(case_);
  const f = features(case_);
  if (f.kind === 'route') {
    if (f.cardFound) {
      if (rules.require_did && !f.hasDid) return false;
      if (rules.require_origin_bound && !f.originBound) return false;
      if (rules.refuse_invalid_sig && f.sigInvalid) return false;
      return true;
    }
    if (f.mcpDeclared) {
      if (rules.mcp_require_origin_bound && !f.mcpOriginBound) return false;
      return true;
    }
    return false;
  }
  if (rules.handoff_to_must_eq_card && f.toSet && !f.toEqCard) return false;
  return f.toEqCard;
}

export function tracesFromCases(cases, split = 'train') {
  return cases.filter((c) => c.split === split).map((c) => {
    const env = label(c);
    return {
      id: c.id,
      kind: c.kind,
      features: features(c),
      worker_take: naive(c),
      environment_take: env.take,
      feedback: env.feedback,
      success: naive(c) === env.take,
    };
  });
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function skillGaps(rules, skillMd) {
  const checks = [];
  if (rules.require_did && !/names no did|no `did`|no did/i.test(skillMd)) {
    checks.push({
      rule: 'require_did',
      bullet: 'If the card names no `did`, there is no door — a reply could not be verified.',
    });
  }
  if (rules.require_origin_bound && !/url` must be on that origin|another origin/i.test(skillMd)) {
    checks.push({
      rule: 'require_origin_bound',
      bullet: 'If `card.url` is not on the origin you dialled, refuse the door.',
    });
  }
  if (rules.refuse_invalid_sig && !/fails, refuse|refused, not ignored|never "unsigned"/i.test(skillMd)) {
    checks.push({
      rule: 'refuse_invalid_sig',
      bullet: 'A present signature that fails is a refusal, never "unsigned".',
    });
  }
  if (rules.handoff_to_must_eq_card && !/to` must equal[\s\S]{0,40}card's `did`/i.test(skillMd)) {
    checks.push({
      rule: 'handoff_to_must_eq_card',
      bullet: 'A handoff `to` must equal the card\'s `did`; any other DID is another door.',
    });
  }
  return checks;
}

export function renderHunk(rules, gaps) {
  const ev = (rules.evidence || [])
    .map((e) => `- \`${e.id}\` → ${e.take ? 'TAKE' : 'REFUSE'}: ${e.feedback}`)
    .join('\n');
  const extra = gaps.map((g) => `- ${g.bullet}`).join('\n') || '- (SKILL.md already states every demonstrated rule)';
  return [
    '## Distilled additions (from local traces + fixtures)',
    '',
    'These bullets were demonstrated by environment labels (`route` / `checkHandoff`).',
    'They do not override the command line. Merge only after `npm run distill` reports lift.',
    '',
    extra,
    '',
    '### Evidence',
    '',
    ev || '- (none)',
    '',
  ].join('\n');
}
