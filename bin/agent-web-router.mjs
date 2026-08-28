#!/usr/bin/env node
/**
 * agent-web-router — the command line.
 *
 *   agent-web-router probe <url> [--person] [--browser] [--token] [--no-key] [--json] [--timeout <ms>]
 *   agent-web-router handoff <file|-> --origin <url> [--json] [--timeout <ms>]
 *
 * `probe` reads what a site offers and prints the route for what you have on hand.
 * `handoff` checks a tool result (a JSON file, or stdin) against the site's own card.
 *
 * Exit codes: 0 at least one route (or every handoff entry accepted); 2 nothing to take
 * (or something refused); 1 usage or a bad argument. GET only — nothing here POSTs.
 */

import { readFileSync } from 'node:fs';
import { probe, route, parseHandoff, checkHandoff, describeKnock, VERSION } from '../agent-web-router.mjs';

function usage(code = 1) {
  process.stderr.write([
    `agent-web-router ${VERSION}`,
    '',
    'usage:',
    '  agent-web-router probe <url> [--person] [--browser] [--token] [--no-key] [--json] [--timeout <ms>]',
    '  agent-web-router handoff <file|-> --origin <url> [--json] [--timeout <ms>]',
    '',
    'on hand (probe):',
    '  --person    a person is in the tab; the page is theirs',
    '  --browser   you can run a browser yourself (headless)',
    '  --token     you hold a credential for the site\'s MCP server',
    '  --no-key    you hold no signing key yet (default: you do)',
    '',
  ].join('\n'));
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--timeout' || a === '--origin') { out.flags[a.slice(2)] = argv[++i]; continue; }
    if (a.startsWith('--')) { out.flags[a.slice(2)] = true; continue; }
    out._.push(a);
  }
  return out;
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function yn(v) { return v ? 'yes' : 'no'; }

function printProbe(result, decision, knock) {
  const { card, mcp, page } = result.ways;
  const lines = [];
  lines.push(`agent-web-router ${VERSION} · ${result.origin}`);
  lines.push('');
  lines.push('ways in');
  if (card.found) {
    const signed = card.signed === true ? 'signed: yes' : card.signed === false ? 'signed: INVALID' : 'signed: no';
    lines.push(`  ${pad('card', 6)} ${card.did ?? '(no did)'}`);
    lines.push(`         ${signed}  door: ${card.url ?? '(none)'}${card.originBound ? '' : '  (NOT this origin)'}  skills: ${card.skills.length}`);
  } else {
    lines.push(`  ${pad('card', 6)} none (${card.status ?? 'unreachable'})`);
  }
  lines.push(`  ${pad('mcp', 6)} ${mcp.declared ? `declared at ${mcp.url ?? '(no endpoint)'}${mcp.openAccess ? ', no credential needed' : ''}` : `not declared (${mcp.status ?? 'unreachable'})`}`);
  if (page.reachable) {
    const names = page.declarativeTools.map((t) => t.name).join(', ');
    lines.push(`  ${pad('page', 6)} ${page.declarativeTools.length} declarative tool(s)${names ? ` (${names})` : ''}; imperative hint: ${page.imperativeHint ?? 'none'}`);
  } else {
    lines.push(`  ${pad('page', 6)} no page (${page.status ?? 'unreachable'})`);
  }
  lines.push('');
  const on = decision.onHand;
  lines.push(`on hand: key ${yn(on.key)}  token ${yn(on.token)}  browser ${yn(on.browser)}  person ${yn(on.person)}`);
  lines.push('');
  lines.push(`route  (order: ${decision.order === 'site' ? 'the site\'s, from its card' : 'default'})`);
  if (decision.routes.length === 0) lines.push('  (nothing to take)');
  decision.routes.forEach((r, i) => {
    lines.push(`  ${i + 1}. ${pad(r.kind, 5)} ${r.why}${r.note ? `  [${r.note}]` : ''}`);
  });
  if (decision.excluded.length) {
    lines.push('');
    lines.push('excluded');
    for (const x of decision.excluded) lines.push(`  ${pad(x.kind, 5)} ${x.why}`);
  }
  if (knock) {
    lines.push('');
    lines.push(`knock: POST ${knock.endpoint ?? '?'}  to ${knock.recipient ?? '?'}${knock.signedFields ? `  sign ${knock.signedFields.join(',')}` : ''}${knock.howTo ? `  how-to ${knock.howTo}` : ''}`);
  }
  const sp = result.signposts;
  if (sp && (sp.llmsTxt.found || sp.link.length)) {
    lines.push('');
    lines.push('signposts (not routes)');
    if (sp.llmsTxt.found) lines.push(`  llms.txt   ${sp.llmsTxt.bytes} bytes${sp.llmsTxt.title ? `  "${sp.llmsTxt.title}"` : ''}`);
    for (const l of sp.link) lines.push(`  Link       ${l.url}  rel=${l.rel}`);
  }
  if (result.notes.length) {
    lines.push('');
    lines.push('notes');
    for (const n of result.notes) lines.push(`  - ${n}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

async function cmdProbe(args) {
  const url = args._[1];
  if (!url) usage();
  const timeoutMs = args.flags.timeout ? Number(args.flags.timeout) : undefined;
  let result;
  try {
    result = await probe(url, { timeoutMs });
  } catch (e) {
    process.stderr.write(`agent-web-router: ${e.message}\n`);
    process.exit(1);
  }
  const onHand = { person: Boolean(args.flags.person), browser: Boolean(args.flags.browser), token: Boolean(args.flags.token), key: !args.flags['no-key'] };
  const decision = route(result.ways, onHand);
  const knock = result.ways.card.found ? describeKnock(result.ways.card.card) : null;
  if (args.flags.json) {
    const { card, ...rest } = result.ways.card;   // the raw card rides along under `card`
    process.stdout.write(JSON.stringify({ ...result, ways: { ...result.ways, card: { ...rest, card } }, route: decision, knock }, null, 2) + '\n');
  } else {
    printProbe(result, decision, knock);
  }
  process.exit(decision.routes.length ? 0 : 2);
}

async function cmdHandoff(args) {
  const file = args._[1];
  const origin = args.flags.origin;
  if (!file || !origin) usage();
  let doc;
  try {
    doc = JSON.parse(file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8'));
  } catch (e) {
    process.stderr.write(`agent-web-router: cannot read ${file}: ${e.message}\n`);
    process.exit(1);
  }
  const handoff = parseHandoff(doc);
  const timeoutMs = args.flags.timeout ? Number(args.flags.timeout) : undefined;
  let probed;
  try {
    probed = await probe(origin, { timeoutMs });
  } catch (e) {
    process.stderr.write(`agent-web-router: ${e.message}\n`);
    process.exit(1);
  }
  const cardInfo = probed.ways.card;
  // Only a card this origin actually stands behind can vouch for a handoff: served here,
  // bound here, and not carrying a failed signature.
  const usable = cardInfo.found && cardInfo.originBound && cardInfo.signed !== false ? cardInfo.card : null;
  const verdict = handoff ? checkHandoff(handoff, { origin, card: usable }) : { accepted: [], refused: [] };
  const out = { origin: probed.origin, handoff, cardDid: usable?.did ?? null, ...verdict };
  if (args.flags.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    const lines = [`agent-web-router ${VERSION} · handoff against ${probed.origin} (card ${usable?.did ?? 'none usable'})`, ''];
    if (!handoff) lines.push('no handoff found in the result (nothing to follow)');
    for (const a of out.accepted) lines.push(`  accept  ${a.entry.kind}  ${a.entry.to ?? a.entry.endpoint ?? a.entry.server ?? a.entry.url}${a.requiresPerson ? '  (needs a person: never opened silently)' : ''}${a.note ? `  [${a.note}]` : ''}`);
    for (const r of out.refused) lines.push(`  REFUSE  ${r.entry.kind}  ${r.entry.to ?? r.entry.endpoint ?? r.entry.server ?? r.entry.url}  — ${r.reason}`);
    process.stdout.write(lines.join('\n') + '\n');
  }
  process.exit(handoff && out.refused.length === 0 ? 0 : 2);
}

const args = parseArgs(process.argv.slice(2));
if (args.flags.help || args.flags.h || args._.length === 0) usage(args._.length === 0 && !args.flags.help ? 1 : 0);
if (args._[0] === 'probe') await cmdProbe(args);
else if (args._[0] === 'handoff') await cmdHandoff(args);
else usage();
