/**
 * agent-web-router.mjs — pick how an agent enters a website.
 *
 * A site can be entered three ways, and they are not rivals:
 *
 *   page   WebMCP tools registered in the page — declarative `<form toolname=…>` or the
 *          imperative `document.modelContext` API. They run in a browser, as whoever is
 *          logged into that browser; headless, as nobody. Nothing remains when the tab closes.
 *   mcp    an MCP server the site declares (`/.well-known/mcp.json`, SEP-2127 — a draft at
 *          the time of writing). Runs over HTTP as whoever the token names.
 *   card   the Agent Card at `/.well-known/agent-card.json` and the A2A door it names:
 *          POST one signed message/send, get a signed reply in the same response.
 *          Any implementation of that contract — not one vendor. Runs as the visitor's
 *          own key, a did:key, and needs nothing else. A counterparty the site can
 *          reach again is what remains.
 *
 * Which one an agent should take depends on what it has on hand, and that is the whole
 * decision this module makes:
 *
 *   a person in the tab   -> the page (it is theirs; the tools run in their session)
 *   an agent alone        -> the door first (its key is all it needs), the server if it
 *                            holds a token, the page only if it carries a browser
 *
 * The router does four things, and only four:
 *
 *   probe(origin)              discover which ways THIS origin offers. GETs only: it never
 *                              runs page script, never opens a browser.
 *   route(ways, onHand)        order those ways by what the agent has on hand.
 *   checkHandoff(handoff, …)   accept a site-declared continuation ("the rest of this
 *                              happens at the door / on this page / on this server") only
 *                              when the origin's own card names where it points.
 *   knock(origin, {key,…})     complete the card route: POST one signed message at the door
 *                              with a key the caller ALREADY HOLDS, verify the signed reply.
 *
 * It does NOT mint keys, and it does NOT browse. The key is an identity, and where it lives
 * (per visit? per machine? per site?) is a decision the caller owns; the page, when it is the
 * way in, is the harness's own browser's to run. describeKnock(card) still returns the door's
 * contract for a harness that prefers to knock with its own code.
 *
 * Three rules of CONDUCT run through all four (spec §7b), and each is pinned by a test that
 * attempts the opposite:
 *
 *   identity comes from the caller   the visitor's DID is derived from the key the caller
 *                                    supplied — never from a field the site put in its card,
 *                                    its page, a tool result or a handoff (AWR-25)
 *   tool results are data            the ONLY thing consumed from a tool result is the handoff
 *                                    envelope at `_meta.handoff`; prose in `content`, anything
 *                                    in `structuredContent`, cannot create or re-order a route
 *                                    (AWR-26)
 *   a refusal is final for the call  one POST per knock(); a 429, a 503 or a JSON-RPC error
 *                                    is returned with its Retry-After, never retried (AWR-27)
 *
 * Why these are here and not left to the model: a paper that measured it (arXiv 2606.06460)
 * found agents honour an in-band "stop" 0–100 % depending on the model, and a harness-level
 * interceptor 120/120. The router IS that interceptor for the three cases above.
 *
 * Zero dependencies. Node >= 20 (global fetch, node:crypto Ed25519).
 */

import { createPrivateKey, createPublicKey, randomUUID, sign as cryptoSign } from 'node:crypto';

// THE WIRE LAYER IS NOT WRITTEN HERE. Canonical JSON, did:key, the six signed fields and the
// signed card envelope are one contract with one set of bytes, and this file used to carry a
// second, hand-written implementation of them — a canonicalizer that REFUSED a float the door
// renders, a key sort by UTF-16 unit where the contract sorts by code point. Both are ways to
// disagree with every other implementation while every local test passes. `seam.mjs` is the
// seam itself — the published layer (agent-seam, MIT) — vendored beside this file and pinned
// by `test/seam-twin.test.mjs`.
import {
  AGENT_CARD_PATH, AGENT_CARD_PATH_LEGACY, AGENT_CARD_SIG_PATH,
  canonicalJSON, didFromPublicKeyHex, publicKeyHexFromDid, verifyBytes,
  cardEnvelopePayload,
  verifyCardEnvelope as seamVerifyCardEnvelope,
  signingPayload, verifyEnvelopeSignature as seamVerifyEnvelopeSignature,
} from './seam.mjs';

export {
  AGENT_CARD_PATH, AGENT_CARD_PATH_LEGACY, AGENT_CARD_SIG_PATH,
  canonicalJSON, signingPayload,
};

// ---------------------------------------------------------------- this router's own gate
//
// The seam decides BYTES. What a caller is allowed to be is this router's decision, and a
// router may refuse more than the contract does — never less. Two refusals live here rather
// than in the seam, and 0.6.0's "fail closed at routing trust boundaries" is where they came
// from; when that work landed they were edits to a hand-written copy of the seam, and this is
// the same behaviour re-stated in the one place it belongs.
//
//   1. The card envelope must DECLARE the version this build understands. The seam rebuilds
//      the signed payload from `card` and `ts` alone and hardcodes `v` into it, so an envelope
//      labelled v:2 still verifies against v:1 bytes. Nothing is forged by that — card and ts
//      stay authenticated — but a router that routes on a version it did not check is routing
//      on a field nobody bound. CARD_ENVELOPE_VERSION_HERE must equal the seam's; the twin
//      test proves it by reading the payload the seam actually signs.
//   2. An envelope this router accepts must be ADDRESSED. The seam allows `to` to be the empty
//      string on purpose: that is how a door's anonymous-lane reply is addressed, "signed by
//      me, to nobody in particular", and a door that refused it would call its own answer
//      unsigned. A router is not that door. It relays between named parties, and an unaddressed
//      envelope has nowhere to go, so it is refused here and only here.

/** The card-envelope version this build understands. The seam pins the same number but does
 *  not export it; `test/seam-twin.test.mjs` fails if the two ever disagree. */
export const CARD_ENVELOPE_VERSION_HERE = 1;
export { cardEnvelopePayload };

/** The seam's card-envelope check, with the declared version required. */
export function verifyCardEnvelope(envelope, expectedDid = null) {
  if (!envelope || typeof envelope !== 'object') return null;
  if (envelope.v !== CARD_ENVELOPE_VERSION_HERE) return null;
  if (!envelope.card || typeof envelope.card !== 'object' || typeof envelope.card.did !== 'string') return null;
  if (!Number.isSafeInteger(envelope.ts)) return null;
  return seamVerifyCardEnvelope(envelope, expectedDid);
}

/** The seam's envelope check, with every field required to be what it claims and `to` required
 *  to name someone. */
export function verifyEnvelopeSignature(f) {
  if (!f || typeof f !== 'object') return false;
  if (typeof f.from !== 'string' || !f.from || !f.sig) return false;
  if (typeof f.to !== 'string' || !f.to) return false;
  if (typeof f.messageId !== 'string' || !f.messageId) return false;
  if (typeof f.text !== 'string' || !Number.isSafeInteger(f.timestamp)) return false;
  if (f.contextId !== null && f.contextId !== undefined && typeof f.contextId !== 'string') return false;
  return seamVerifyEnvelopeSignature(f);
}

/** The DID a 32-byte Ed25519 public key encodes. Kept under this name because it is this
 *  package's published API; the wire layer spells it `didFromPublicKeyHex` and takes either
 *  a Buffer or hex. */
export const didFromPublicKey = didFromPublicKeyHex;

/** The 32-byte public key a `did:key` encodes, as a Buffer — this package's published shape.
 *  The wire layer returns hex. Throws on a malformed DID, as it always did. */
export function publicKeyFromDid(did) {
  return Buffer.from(publicKeyHexFromDid(did), 'hex');
}

export const VERSION = '0.6.1';
export const MCP_SERVER_CARD_PATH = '/.well-known/mcp.json';
export const DID_CONFIGURATION_PATH = '/.well-known/did-configuration.json';
export const LLMS_TXT_PATH = '/llms.txt';
export const LLMS_FULL_TXT_PATH = '/llms-full.txt';
export const ROBOTS_PATH = '/robots.txt';

/** Crawler names AI vendors publish for robots.txt. Reported per name so a site's stance
 *  toward agents is visible at a glance; the `*` group is what applies to everyone else. */
export const AI_USER_AGENTS = [
  'GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot',
  'anthropic-ai', 'Google-Extended', 'PerplexityBot', 'Perplexity-User', 'CCBot', 'Bytespider',
  'Applebot-Extended', 'meta-externalagent', 'Amazonbot', 'DuckAssistBot', 'cohere-ai',
];

const MAX_CARD_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_KNOCK_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_PROBE_DEADLINE_MS = 30000;

// ================================================================ HTTP (GET only, capped)

function safeOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function isHttpUrl(u) {
  if (typeof u !== 'string') return false;
  try { const p = new URL(u).protocol; return p === 'https:' || p === 'http:'; } catch { return false; }
}

async function readBodyCapped(res, ctrl, maxBytes) {
  let buf;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { ctrl.abort(); } catch { /* already down */ }
        try { await reader.cancel(); } catch { /* the abort above is authoritative */ }
        return { ok: false, error: `body over ${maxBytes} bytes` };
      }
      chunks.push(Buffer.from(value));
    }
    buf = Buffer.concat(chunks);
  } else {
    // A caller-supplied fetch with no stream body: buffer, then apply the same cap.
    buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { ok: false, error: `body over ${maxBytes} bytes` };
  }
  return { ok: true, text: buf.toString('utf8') };
}

/** One capped GET. Never throws: a network failure is a finding, not an exception.
 *  The cap is enforced WHILE reading, not after: a body is abandoned (and the request
 *  aborted) the moment it crosses `maxBytes`, so an endless or hostile stream costs at
 *  most the cap in memory and never holds the probe until its timeout. */
async function getCapped(url, { fetchImpl, timeoutMs, maxBytes, accept }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let status = 0;
  let responseUrl = url;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { accept, 'user-agent': `agent-web-router/${VERSION}` },
    });
    status = res.status;
    responseUrl = res.url || url;
    const body = await readBodyCapped(res, ctrl, maxBytes);
    if (!body.ok) return { ok: false, status, url: responseUrl, error: body.error };
    return {
      ok: res.ok, status, url: responseUrl,
      contentType: res.headers.get('content-type') || '',
      link: res.headers.get('link') || '',
      text: body.text,
    };
  } catch (e) {
    return { ok: false, status, url: responseUrl, error: e?.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function parseJSON(text) {
  try { const v = JSON.parse(text); return (v && typeof v === 'object') ? v : null; } catch { return null; }
}

// ================================================================ the page (no browser)

/**
 * Attribute scan for the WebMCP declarative API: a `<form>` carrying BOTH `toolname` and
 * `tooldescription` is a tool (remove either and the browser unregisters it). This reads
 * what the HTML declares without running anything — the imperative API
 * (`modelContext.registerTool`) is only observable by executing the page, so for that the
 * probe can report a HINT, never a tool list.
 */
export function findDeclarativeTools(html) {
  const tools = [];
  // Neutralize comments before the lightweight tag scan. Preserve their width with a
  // non-syntax byte: deleting or spacing them could synthesize `<form>` from either
  // `<fo<!-- -->rm>` or `<form<!-- --> ...>`, neither of which the HTML parser names form.
  const source = String(html).replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => 'x'.repeat(comment.length));
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  const attrsOf = (tag) => {
    const attrs = {};
    let a;
    attrRe.lastIndex = 0;
    while ((a = attrRe.exec(tag)) !== null) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    return attrs;
  };
  let m;
  const formRe = /<form\b([^>]*)>/gi;
  while ((m = formRe.exec(source)) !== null) {
    const attrs = attrsOf(m[1]);
    if (attrs.toolname && attrs.tooldescription) {
      tools.push({
        dialect: 'webmcp',
        name: attrs.toolname,
        description: attrs.tooldescription,
        action: attrs.action ?? null,
        method: (attrs.method || 'get').toLowerCase(),
        autosubmit: 'toolautosubmit' in attrs,
      });
    }
  }
  // VOIX (TU Darmstadt, arXiv 2511.11287): `<tool name description>` elements — a sibling
  // dialect of the same idea. The page's own script handles the call, so a browser is
  // still what runs it; this only lists what is declared.
  const toolRe = /<tool\b([^>]*)>/gi;
  while ((m = toolRe.exec(source)) !== null) {
    const attrs = attrsOf(m[1]);
    if (attrs.name && attrs.description) {
      tools.push({ dialect: 'voix', name: attrs.name, description: attrs.description, action: null, method: null, autosubmit: false });
    }
  }
  return tools;
}

/**
 * The SIGNPOSTS: what else the site declares about itself for agents. None of these is
 * a way in — an llms.txt is reading material, a Link header points at the card — so none
 * creates a route. They are reported so a visitor sees the whole of what the site put up,
 * in one place, without knowing every convention.
 */
async function readSignposts(get, front) {
  const out = { robots: { found: false }, llmsTxt: { found: false }, llmsFullTxt: { found: false }, markdown: { offered: false }, structuredData: [], link: [] };

  const r = await get(ROBOTS_PATH, MAX_CARD_BYTES, 'text/plain, */*;q=0.1');
  if (r.ok && !/html/i.test(r.contentType || '')) {
    const parsed = parseRobots(r.text);
    const ai = {};
    for (const name of AI_USER_AGENTS) {
      const v = robotsAllows(parsed, name, '/');
      if (v !== null) ai[name] = v ? 'allow' : 'disallow';
    }
    out.robots = {
      found: true,
      everyoneMayFetchRoot: robotsAllows(parsed, '*', '/'),
      ai,
      ...(Object.keys(parsed.signals).length ? { contentSignal: parsed.signals } : {}),
    };
  }

  const l = await get(LLMS_TXT_PATH, MAX_CARD_BYTES, 'text/plain, text/markdown;q=0.9, */*;q=0.1');
  if (l.ok && !/html/i.test(l.contentType || '')) {
    const title = (l.text.match(/^#\s+(.+)$/m) || [])[1] || null;
    out.llmsTxt = { found: true, bytes: Buffer.byteLength(l.text, 'utf8'), title };
    const f = await get(LLMS_FULL_TXT_PATH, MAX_HTML_BYTES, 'text/plain, text/markdown;q=0.9, */*;q=0.1');
    if (f.ok && !/html/i.test(f.contentType || '')) out.llmsFullTxt = { found: true, bytes: Buffer.byteLength(f.text, 'utf8') };
  }

  if (front.ok) {
    // Content negotiation: does the site hand an agent a Markdown edition of the page when
    // asked (`Accept: text/markdown`)? A read surface, not a way in.
    const md = await get('/', MAX_HTML_BYTES, 'text/markdown');
    if (md.ok && /text\/markdown/i.test(md.contentType || '')) out.markdown = { offered: true, bytes: Buffer.byteLength(md.text, 'utf8') };
    if (/html/i.test(front.contentType || '')) out.structuredData = structuredDataTypes(front.text);
  }

  const frontLink = front.link;
  if (frontLink) {
    // RFC 8288 Link header on the front page: `<url>; rel="…"`. Report every rel that names
    // an agent-facing document, so a site's own signpost is visible even when the page has
    // no anchor to it.
    const re = /<([^>]+)>\s*((?:;[^,]*)*)/g;
    let m;
    while ((m = re.exec(frontLink)) !== null) {
      const rel = (m[2].match(/rel\s*=\s*"?([^";]+)"?/i) || [])[1] || '';
      if (/agent|llms|mcp/i.test(rel + m[1])) out.link.push({ url: m[1], rel: rel.trim() });
    }
  }
  return out;
}

/**
 * robots.txt, read the RFC 9309 way but only as far as a visitor needs: which groups
 * exist, what each says about the front page (`/`), and any `Content-Signal` lines (the
 * robots.txt extension for stating ai-train / ai-input / search preferences). The
 * verdict for a name is the most specific group that names it, else the `*` group; for a
 * path, the longest matching rule wins and a tie goes to Allow.
 */
export function parseRobots(text) {
  const groups = [];
  const signals = {};
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || cur.rulesStarted) { cur = { agents: [], allow: [], disallow: [], rulesStarted: false }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
    } else if (key === 'disallow' || key === 'allow') {
      if (!cur) continue;
      cur.rulesStarted = true;
      cur[key].push(val);
    } else if (key === 'content-signal') {
      for (const part of val.split(',')) {
        const [k, v] = part.split('=').map((s) => s.trim().toLowerCase());
        if (k) signals[k] = v ?? '';
      }
    }
  }
  return { groups, signals };
}

function robotsRuleMatches(rule, path) {
  if (rule === '') return false;
  const escaped = rule.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  const re = new RegExp('^' + (escaped.endsWith('\\$') ? escaped.slice(0, -2) + '$' : escaped));
  return re.test(path);
}

/** true when `name` (or `*`) may fetch `path`; `null` when robots.txt says nothing about it. */
export function robotsAllows(parsed, name, path = '/') {
  const lower = String(name).toLowerCase();
  const exactGroups = parsed.groups.filter((g) => g.agents.includes(lower));
  const wildcardGroups = parsed.groups.filter((g) => g.agents.includes('*'));
  const groups = exactGroups.length ? exactGroups : wildcardGroups;
  if (!groups.length) return null;
  let best = null;
  for (const group of groups) {
    for (const [verdict, rules] of [['allow', group.allow], ['disallow', group.disallow]]) {
      for (const r of rules) {
        if (!robotsRuleMatches(r, path)) continue;
        if (!best || r.length > best.rule.length || (r.length === best.rule.length && verdict === 'allow')) best = { rule: r, verdict };
      }
    }
  }
  return best ? best.verdict === 'allow' : true;
}

/** `@type` values declared in the page's JSON-LD blocks — what the page says it is. */
export function structuredDataTypes(html) {
  const types = new Set();
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const collect = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    if (Array.isArray(node)) { node.forEach((n) => collect(n, depth + 1)); return; }
    const t = node['@type'];
    if (typeof t === 'string') types.add(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.add(x));
    if (node['@graph']) collect(node['@graph'], depth + 1);
  };
  while ((m = re.exec(html)) !== null) {
    try { collect(JSON.parse(m[1])); } catch { /* not JSON: not structured data */ }
    if (types.size >= 32) break;
  }
  return [...types];
}

/** Does /.well-known/did-configuration.json (Well Known DID Configuration) name `did`?
 *  Entries are JWTs or JSON-LD credentials; only the NAMING is checked here, not the
 *  proof — and the result says so. */
export function didConfigurationNames(doc, did) {
  const entries = Array.isArray(doc?.linked_dids) ? doc.linked_dids : [];
  for (const e of entries) {
    try {
      if (typeof e === 'string') {
        const parts = e.split('.');
        if (parts.length < 2) continue;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (payload.iss === did || payload.sub === did || payload.vc?.credentialSubject?.id === did) return true;
      } else if (e && typeof e === 'object') {
        const issuer = typeof e.issuer === 'string' ? e.issuer : e.issuer?.id;
        if (issuer === did || e.credentialSubject?.id === did) return true;
      }
    } catch { /* an unreadable entry names nothing */ }
  }
  return false;
}

/**
 * Verify one Well Known DID Configuration entry: a DIF Domain Linkage Credential as a
 * compact JWS. Fetched from the origin's own `/.well-known/did-configuration.json`, a
 * verifying credential is the DOMAIN's statement that it controls the DID — the other half
 * of the origin binding, and the difference between "names this did" and "proves it".
 *
 * The signature covers the ASCII TEXT of `<b64url header>.<b64url payload>` — never a
 * re-serialization of what those segments decode to. base64url is UNPADDED, and a padded
 * or standard-alphabet spelling is refused, not repaired: Node's own decoder is lenient,
 * so the shape is gated by regex before any decode. `exp` is mandatory — a domain is
 * leased, not owned, so a credential with no end date is indefinite authority over a name
 * the issuer may no longer hold. `kid` is not enforced: the verifying key comes from `did`
 * itself (with did:key the DID IS the key), so a kid check would only restate it.
 *
 * Never throws; every failure is named in `reasons` (verifyReply's shape), so a refusal
 * always says which check refused.
 */
export function verifyDomainLinkage(token, { did, origin, now = Math.floor(Date.now() / 1000) } = {}) {
  const out = { ok: false, reasons: [] };
  try {
    if (typeof token !== 'string') { out.reasons.push('not a compact JWS string'); return out; }
    const segs = token.split('.');
    if (segs.length !== 3 || !segs.every((x) => /^[A-Za-z0-9_-]+$/.test(x))) {
      out.reasons.push('not unpadded base64url compact JWS — refused, not repaired');
      return out;
    }
    const [h, pl, sg] = segs;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(pl, 'base64url').toString('utf8'));
    if (header?.alg !== 'EdDSA') out.reasons.push(`alg is ${header?.alg ?? 'absent'}, not EdDSA`);
    const subject = payload?.vc?.credentialSubject;
    if (!(payload?.iss === did && payload?.sub === did && subject?.id === did)) {
      out.reasons.push("iss, sub and credentialSubject.id must all be the card's did");
    }
    const types = Array.isArray(payload?.vc?.type) ? payload.vc.type : [];
    if (!types.includes('DomainLinkageCredential')) out.reasons.push('vc.type does not include DomainLinkageCredential');
    const claimed = typeof subject?.origin === 'string' ? safeOrigin(subject.origin) : null;
    if (!claimed || claimed !== safeOrigin(origin)) out.reasons.push(`credential origin (${subject?.origin ?? 'absent'}) is not the dialled origin`);
    if (!Number.isSafeInteger(payload?.exp)) out.reasons.push('exp missing or not an integer — a domain is leased, not owned');
    else if (now > payload.exp) out.reasons.push('expired');
    if (payload?.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || now < payload.nbf)) out.reasons.push('not yet valid');
    const sig = Buffer.from(sg, 'base64url');
    if (sig.length !== 64 || !verifyBytes(publicKeyFromDid(did), sig, Buffer.from(`${h}.${pl}`, 'utf8'))) {
      out.reasons.push("signature does not verify over the JWS signing input under the did's key");
    }
  } catch {
    out.reasons.push('unreadable credential');
  }
  out.ok = out.reasons.length === 0;
  return out;
}

export function imperativeHint(html) {
  if (/\bmodelContext\b/.test(html)) return 'modelContext referenced in the page';
  if (/registerTool\s*\(/.test(html)) return 'registerTool( referenced in the page';
  if (/<script\b[^>]*\bsrc\s*=\s*["'][^"']*(webmcp|mcp-b)[^"']*["']/i.test(html)) return 'a WebMCP runtime script is loaded';
  return null;
}

const MAX_SCRIPTS = 6;
const MAX_SCRIPT_BYTES = 512 * 1024;

/** Same-origin `<script src>` paths, in page order, deduplicated, at most MAX_SCRIPTS.
 *  Cross-origin scripts are skipped: they are someone else's code, not this site's tools. */
export function scriptSources(html, dialled) {
  const out = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let u;
    try { u = new URL(m[1] ?? m[2] ?? m[3], dialled + '/'); } catch { continue; }
    if (u.origin !== dialled) continue;
    const p = u.pathname + u.search;
    if (!out.includes(p)) out.push(p);
    if (out.length >= MAX_SCRIPTS) break;
  }
  return out;
}

/** A site that registers its tools from a file rather than inline (measured on a live
 *  front page: nothing inline, the registration in `/agent-tools.js`) shows nothing in
 *  the HTML. Read the site's own scripts — still GET, still never executed. */
async function scanScripts(html, dialled, get) {
  for (const p of scriptSources(html, dialled)) {
    const r = await get(p, MAX_SCRIPT_BYTES, 'application/javascript, text/javascript;q=0.9, */*;q=0.1');
    if (!r.ok) continue;
    if (/\bmodelContext\b/.test(r.text) || /registerTool\s*\(/.test(r.text)) return `modelContext referenced in ${p}`;
  }
  return null;
}

// ================================================================ probe

/**
 * Discover which ways in `origin` offers. Reads the card (and its signature), the MCP server
 * card, and the front page's HTML. GET only; no browser; every failure is recorded in the
 * result rather than thrown.
 *
 * All requests share one wall-clock deadline (`opts.deadlineMs`, default 30 s) on top of the
 * per-request timeout: a probe legitimately makes 10-17 GETs, and without a shared budget a
 * black-holing origin holds it for minutes (prior art: core's 10 s open-door read budget,
 * for one fetch). The GETs stay SEQUENTIAL on purpose — parallelising would scramble the
 * order of `notes` and of the requests a site observes, for little gain in the honest case.
 * A step not started before the deadline is skipped and recorded once in `notes`; it then
 * reports through the normal absent-way reasons, never as a crash.
 */
export async function probe(origin, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
  const dialled = safeOrigin(origin);
  if (!dialled) throw new TypeError(`not an http(s) origin: ${origin}`);
  const notes = [];
  const deadline = Date.now() + deadlineMs;
  let deadlineNoted = false;
  const get = (path, maxBytes, accept) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (!deadlineNoted) {
        deadlineNoted = true;
        notes.push(`probe deadline (${deadlineMs} ms) passed: later steps were not attempted`);
      }
      return Promise.resolve({ ok: false, status: 0, url: dialled + path, error: 'probe deadline passed' });
    }
    return getCapped(dialled + path, { fetchImpl, timeoutMs: Math.min(remaining, timeoutMs), maxBytes, accept });
  };

  // ---- card
  const card = { found: false, path: null, status: null, did: null, url: null, originBound: false,
    signed: 'absent', openDoor: false, skills: [], name: null, prefer: null,
    interfaces: [], extensions: [], domains: [], domainBinding: { found: false }, card: null };
  let res = await get(AGENT_CARD_PATH, MAX_CARD_BYTES, 'application/json');
  let path = AGENT_CARD_PATH;
  if (!res.ok) {
    const legacy = await get(AGENT_CARD_PATH_LEGACY, MAX_CARD_BYTES, 'application/json');
    if (legacy.ok) { res = legacy; path = AGENT_CARD_PATH_LEGACY; }
  }
  card.status = res.status;
  if (res.ok) {
    const doc = parseJSON(res.text);
    if (!doc) {
      notes.push(`card at ${path} is not a JSON object`);
    } else if (safeOrigin(res.url) !== dialled) {
      // A redirect to another origin is a substitution, not a card: whatever answered is
      // not the site that was dialled.
      notes.push(`card was served from ${safeOrigin(res.url)}, not the dialled origin — ignored`);
    } else {
      card.found = true;
      card.path = path;
      card.card = doc;
      card.did = typeof doc.did === 'string' ? doc.did : null;
      card.url = typeof doc.url === 'string' ? doc.url : null;
      card.name = typeof doc.name === 'string' ? doc.name : null;
      card.openDoor = Boolean(doc.agentEntry?.open_door || doc.muretai?.open_door);
      card.prefer = parsePrefer(doc.agentEntry?.prefer ?? doc.muretai?.prefer);
      // A2A: the main url's transport plus any additional interfaces (JSONRPC / GRPC /
      // HTTP+JSON), and extension URIs — the card's own account of how else to reach it.
      const main = { url: card.url, transport: typeof doc.preferredTransport === 'string' ? doc.preferredTransport : 'JSONRPC' };
      card.interfaces = [main, ...(Array.isArray(doc.additionalInterfaces) ? doc.additionalInterfaces : [])]
        .filter((i) => i && isHttpUrl(i.url))
        .map((i) => ({ url: i.url, transport: typeof i.transport === 'string' ? i.transport : null }))
        .filter((i, idx, arr) => arr.findIndex((j) => j.url === i.url && j.transport === i.transport) === idx);
      card.extensions = (Array.isArray(doc.capabilities?.extensions) ? doc.capabilities.extensions : [])
        .map((e) => (typeof e?.uri === 'string' ? e.uri : null)).filter(Boolean);
      card.domains = Array.isArray(doc.domains) ? doc.domains.filter((d) => typeof d === 'string') : [];
      // Well Known DID Configuration: the domain's own statement that it controls the DID —
      // the other half of the origin binding. The naming is read first; when it names this
      // card's did, the Domain Linkage proof itself is verified (AWR-7a). Only the dialled
      // origin's document is read — a router never fetches another domain's configuration
      // to prove this one. Entries are capped so a hostile document cannot buy Ed25519 CPU.
      const dc = await get(DID_CONFIGURATION_PATH, MAX_CARD_BYTES, 'application/json');
      if (dc.ok) {
        const dcDoc = parseJSON(dc.text);
        if (!dcDoc) card.domainBinding = { found: false };
        else {
          const names = card.did ? didConfigurationNames(dcDoc, card.did) : false;
          card.domainBinding = { found: true, namesCardDid: names, verified: false };
          if (names) {
            const entries = (Array.isArray(dcDoc.linked_dids) ? dcDoc.linked_dids : [])
              .filter((e) => typeof e === 'string').slice(0, 16);
            let firstReasons = null;
            for (const e of entries) {
              const v = verifyDomainLinkage(e, { did: card.did, origin: dialled });
              if (v.ok) { card.domainBinding.verified = true; firstReasons = null; break; }
              if (!firstReasons) firstReasons = v.reasons;
            }
            if (!card.domainBinding.verified && firstReasons) {
              card.domainBinding.reasons = firstReasons;
              notes.push(`did-configuration names the card's did but its proof does not verify: ${firstReasons[0]}`);
            }
          }
        }
      }
      card.skills =Array.isArray(doc.skills) ? doc.skills.map((s) => ({ id: s?.id ?? null, name: s?.name ?? null, description: s?.description ?? null })) : [];
      card.originBound = Boolean(card.url && safeOrigin(card.url) === dialled);
      if (!card.originBound) notes.push(`card.url (${card.url}) does not name the dialled origin — the door is not here`);
      if (!card.did) notes.push('card carries no did');
      const sigRes = await get(AGENT_CARD_SIG_PATH, MAX_CARD_BYTES, 'application/json');
      if (sigRes.ok) {
        const env = parseJSON(sigRes.text);
        const inner = env ? verifyCardEnvelope(env, card.did) : null;
        if (inner && canonicalSafe(inner) === canonicalSafe(doc)) card.signed = true;
        else {
          card.signed = false;
          notes.push(inner ? 'signed card differs from the plain card' : 'card signature does not verify under the card\'s own did');
        }
      } else if (sigRes.status >= 200 && sigRes.status < 300) {
        // A successful response proves that a signature representation was present. If it
        // cannot be read within the cap, it is invalid—not equivalent to a 404 absence.
        card.signed = false;
        notes.push(`card signature response is unusable: ${sigRes.error ?? `HTTP ${sigRes.status}`}`);
      } else if (sigRes.status !== 404 && sigRes.status !== 0) {
        notes.push(`${AGENT_CARD_SIG_PATH} answered ${sigRes.status}`);
      }
    }
  } else if (res.error) {
    notes.push(`card: ${res.error}`);
  }

  // ---- mcp server card (SEP-2127, draft)
  const mcp = { declared: false, status: null, url: null, originBound: false, openAccess: false, doc: null };
  const mres = await get(MCP_SERVER_CARD_PATH, MAX_CARD_BYTES, 'application/json');
  mcp.status = mres.status;
  if (mres.ok && safeOrigin(mres.url) !== dialled) {
    // The mcp analogue of AWR-4: a server card that arrived via a redirect to another
    // origin is somebody else's statement, not this site's.
    notes.push(`mcp server card was served from ${safeOrigin(mres.url)}, not the dialled origin — ignored`);
  } else if (mres.ok) {
    const doc = parseJSON(mres.text);
    if (doc) {
      mcp.declared = true;
      mcp.doc = doc;
      mcp.url = firstHttpUrl([doc.url, doc.endpoint, doc.transport?.url, doc.transport?.endpoint, doc.transports?.[0]?.url]);
      mcp.openAccess = doc.authentication === null || doc.authentication?.required === false || doc.auth === 'none';
      // `/.well-known/mcp.json` is the origin's statement about itself, like `card.url` —
      // and unlike a handoff `to`, an MCP endpoint carries no DID a reply could be
      // verified under, so an endpoint elsewhere offers no cryptographic recourse at all.
      mcp.originBound = Boolean(mcp.url && safeOrigin(mcp.url) === dialled);
      if (!mcp.url) notes.push('mcp server card declares no endpoint URL that could be found');
      else if (!mcp.originBound) notes.push(`mcp endpoint (${mcp.url}) is not on the dialled origin — the server is not here`);
    } else {
      notes.push(`${MCP_SERVER_CARD_PATH} is not a JSON object`);
    }
  }

  // ---- the page
  const page = { reachable: false, status: null, declarativeTools: [], imperativeHint: null, robotsAllowRoot: null };
  const pres = await get('/', MAX_HTML_BYTES, 'text/html');
  page.status = pres.status;
  if (pres.ok && /html/i.test(pres.contentType || '')) {
    page.reachable = true;
    page.declarativeTools = findDeclarativeTools(pres.text);
    page.imperativeHint = imperativeHint(pres.text) ?? await scanScripts(pres.text, dialled, get);
  } else if (pres.ok) {
    page.reachable = true;
    notes.push(`front page is ${pres.contentType || 'of unknown type'}, not HTML`);
  }

  // ---- signposts (informative; only robots.txt reaches into routing)
  const signposts = await readSignposts(get, pres);
  if (signposts.robots.found) page.robotsAllowRoot = signposts.robots.everyoneMayFetchRoot;

  return { origin: dialled, probedAt: new Date().toISOString(), ways: { card, mcp, page }, signposts, notes };
}

function canonicalSafe(v) { try { return canonicalJSON(v); } catch { return null; } }

function firstHttpUrl(candidates) {
  for (const c of candidates) if (isHttpUrl(c)) return c;
  return null;
}

// ================================================================ the site's own order

const KINDS = new Set(['page', 'card', 'mcp']);
const WHEN = {
  person: (o) => o.person, alone: (o) => !o.person,
  key: (o) => o.key, 'no-key': (o) => !o.key,
  token: (o) => o.token, browser: (o) => o.browser,
};

/**
 * The site's declared order of its own ways in — `agentEntry.prefer` on the card:
 *
 *   "prefer": [ { "kind": "page", "when": "no-key" }, "card", "mcp" ]
 *
 * An entry is a kind, or `{kind, when}` with `when` one of person / alone / key / no-key /
 * token / browser (read against what the visitor has on hand). Why the card and not the
 * page: the card is the origin's own statement, signed when the site signs it; a page can
 * be rewritten by any script it loads. Why a site gets to say this at all: whether a
 * visitor should read first and become a counterparty later, or knock first, is the
 * site's design — a keyless agent that meant only to read may decide to mint a key after
 * the conversation, and the site is the one that knows where that conversation goes.
 * Unknown kinds and unknown conditions are dropped, never guessed.
 */
export function parsePrefer(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const e of v) {
    if (typeof e === 'string') { if (KINDS.has(e)) out.push({ kind: e }); continue; }
    if (!e || typeof e !== 'object' || !KINDS.has(e.kind)) continue;
    const o = { kind: e.kind };
    if (e.when != null) {
      if (typeof e.when !== 'string' || !(e.when in WHEN)) continue;
      o.when = e.when;
    }
    out.push(o);
  }
  return out.length ? out : null;
}

// ================================================================ route

/**
 * Order the ways in by what the agent has on hand.
 *   onHand.person   a person is in the tab (the browser is theirs)
 *   onHand.browser  the agent can run a browser itself (headless)
 *   onHand.token    the agent holds a credential for the site's MCP server
 *   onHand.key      the agent holds its own Ed25519 key (a did:key)
 * Returns { order, routes: [...ordered], excluded: [...with reasons] }. Every way appears
 * in exactly one of the two lists, so "why not X" is always answered. `order` is "site"
 * when a usable card declared the order (see parsePrefer) and "default" otherwise. A
 * declaration only RE-ORDERS what is on offer: it can never add a route the rules below
 * exclude, and a card that is itself excluded declares nothing.
 */
export function route(ways, onHand = {}) {
  const on = { person: false, browser: false, token: false, key: true, ...onHand };
  let routes = [];
  const excluded = [];
  const { card, mcp, page } = ways;
  const pageHasTools = page.reachable && (page.declarativeTools.length > 0 || Boolean(page.imperativeHint));

  if (on.person) {
    if (pageHasTools) routes.push({ kind: 'page', why: 'a person is in the tab: the page is theirs, and its tools run in their session' });
    else excluded.push({ kind: 'page', why: page.reachable ? 'the page declares no tools' : 'no page answered' });
  }

  if (!card.found) {
    excluded.push({ kind: 'card', why: `no Agent Card (${AGENT_CARD_PATH} answered ${card.status ?? 'nothing'})` });
  } else if (!card.did) {
    excluded.push({ kind: 'card', why: 'the card names no did, so a reply could not be verified' });
  } else if (!card.originBound) {
    excluded.push({ kind: 'card', why: 'card.url names another origin — the door is not the site you dialled' });
  } else if (card.signed === false) {
    // Present-but-invalid is a refusal, never a downgrade to "unsigned": a card that
    // fails its own signature is exactly what a substituted card looks like.
    excluded.push({ kind: 'card', why: 'the signed card does not verify — refused, not ignored' });
  } else {
    routes.push({
      kind: 'card',
      why: on.key
        ? 'the door answers one signed message; your key is all it needs'
        : 'the door refuses an unsigned message but teaches how to mint a key (see knock.howTo)',
      ...(card.signed === 'absent' ? { note: 'card is unsigned; the signed reply is what proves the key' } : {}),
    });
  }

  if (!mcp.declared) {
    excluded.push({ kind: 'mcp', why: `no MCP server card (${MCP_SERVER_CARD_PATH} answered ${mcp.status ?? 'nothing'})` });
  } else if (!mcp.url) {
    excluded.push({ kind: 'mcp', why: 'server card declares no endpoint' });
  } else if (!mcp.originBound) {
    // Computed by probe (route never sees the dialled origin) — the card.originBound
    // pattern. A hand-built `ways.mcp` without the flag loses the route: fail closed.
    excluded.push({ kind: 'mcp', why: 'the server card\'s endpoint names another origin — the server is not the site you dialled' });
  } else if (on.token || mcp.openAccess) {
    routes.push({ kind: 'mcp', why: on.token ? 'a server is declared and you hold a token for it' : 'a server is declared and says it needs no credential' });
  } else {
    excluded.push({ kind: 'mcp', why: 'a server is declared but you hold no token for it' });
  }

  if (!on.person) {
    if (!pageHasTools) {
      excluded.push({ kind: 'page', why: page.reachable ? 'the page declares no tools' : 'no page answered' });
    } else if (page.robotsAllowRoot === false) {
      // A headless visit to the page is a crawler's visit, and robots.txt is the site's
      // standing answer to crawlers. A person in the tab is not a crawler, which is why
      // this branch sits under `!on.person`.
      excluded.push({ kind: 'page', why: 'robots.txt disallows the front page for agents; a headless visit is a crawl' });
    } else if (on.browser) {
      routes.push({ kind: 'page', why: 'you carry a browser: hand the page to it — it will run headless, as nobody' });
    } else {
      const forms = page.declarativeTools.filter((t) => t.action).length;
      excluded.push({
        kind: 'page',
        why: 'the page has tools but you carry no browser'
          + (forms ? `; ${forms} declarative form(s) name an action and could be submitted as plain HTTP` : ''),
      });
    }
  }

  // ---- the site's order, applied over what is on offer
  let order = 'default';
  const skipped = [];
  const cardUsable = card.found && card.did && card.originBound && card.signed !== false;
  if (cardUsable && card.prefer) {
    const picked = [];
    for (const p of card.prefer) {
      if (p.when && !WHEN[p.when](on)) { skipped.push({ kind: p.kind, when: p.when, why: `when=${p.when} does not hold` }); continue; }
      const r = routes.find((x) => x.kind === p.kind && !picked.includes(x));
      if (!r) { skipped.push({ kind: p.kind, why: 'not on offer (see excluded)' }); continue; }
      picked.push(r);
    }
    if (picked.length) {
      for (const r of picked) r.by = 'site';
      routes = [...picked, ...routes.filter((r) => !picked.includes(r))];
      order = 'site';
    }
  }

  return { onHand: on, order, routes, excluded, ...(skipped.length ? { siteOrderSkipped: skipped } : {}) };
}

// ================================================================ handoff

/**
 * A HANDOFF is what a tool result carries when the rest of the interaction happens
 * somewhere else: at the door (a signed message to a DID), on a page a person must see,
 * or on an MCP server. Neutral shape, in the slot MCP reserves for extensions:
 *
 *   { "_meta": { "handoff": { "v": 1, "next": [
 *       { "kind": "dm",  "to": "did:key:z…", "message": "…", "connect": … },
 *       { "kind": "a2a", "endpoint": "https://…", "card": "https://…/.well-known/agent-card.json" },
 *       { "kind": "ui",  "url": "https://…", "why": "payment needs a person" },
 *       { "kind": "mcp", "server": "https://…" } ] } } }
 *
 * The legacy `{ "muretai": { "v":1, "action":"dm", "to", "connect", "suggested_message" } }`
 * envelope is read as a single `dm` entry. Fail closed: anything malformed is dropped,
 * never acted on.
 */
/**
 * The ONLY thing this module consumes from a tool result is the handoff envelope, and only
 * at `_meta.handoff` (or top-level `handoff`; legacy `muretai`). Everything else in the
 * result — the prose in `content[]`, a `structuredContent` object, any other key — is data
 * the tool returned, never an instruction to the router (AWR-26). A handoff written out in
 * a text part, or placed under `structuredContent`, is therefore not a handoff: a page's
 * script or a peer's message can put anything in those, and "follow what the text says" is
 * exactly the move an injected instruction is written to trigger. Nothing in a tool result
 * names the visitor's own identity either — `from`, `as`, `agent_name` and the like are
 * dropped on the floor (AWR-25).
 */
export function parseHandoff(result) {
  if (!result || typeof result !== 'object') return null;
  const h = result._meta?.handoff ?? result.handoff;
  const legacy = result.muretai;
  if (h != null) {
    if (typeof h !== 'object' || h.v !== 1 || !Array.isArray(h.next)) return null;
    const next = [];
    for (const e of h.next) {
      if (!e || typeof e !== 'object' || typeof e.kind !== 'string') continue;
      const out = { kind: e.kind };
      if (e.kind === 'dm') {
        if (typeof e.to !== 'string' || !e.to.startsWith('did:key:')) continue;
        out.to = e.to;
        if (typeof e.message === 'string' && e.message.trim()) out.message = e.message;
        if (e.connect != null) out.connect = e.connect;
      } else if (e.kind === 'a2a') {
        if (typeof e.to === 'string' && e.to.startsWith('did:key:')) out.to = e.to;
        if (isHttpUrl(e.endpoint)) out.endpoint = e.endpoint;
        if (isHttpUrl(e.card)) out.card = e.card;
        if (!out.to && !out.endpoint && !out.card) continue;
        if (typeof e.message === 'string' && e.message.trim()) out.message = e.message;
        if (e.connect != null) out.connect = e.connect;
      } else if (e.kind === 'mcp') {
        if (!isHttpUrl(e.server)) continue;
        out.server = e.server;
      } else if (e.kind === 'ui') {
        if (!isHttpUrl(e.url)) continue;
        out.url = e.url;
        if (typeof e.why === 'string' && e.why.trim()) out.why = e.why;
      } else {
        continue;
      }
      next.push(out);
    }
    return next.length ? { v: 1, next } : null;
  }
  const m = legacy;
  if (m && typeof m === 'object' && m.v === 1 && m.action === 'dm' && typeof m.to === 'string' && m.to.startsWith('did:key:')) {
    const e = { kind: 'dm', to: m.to };
    if (typeof m.suggested_message === 'string' && m.suggested_message.trim()) e.message = m.suggested_message;
    if (m.connect != null) e.connect = m.connect;
    return { v: 1, legacy: 'muretai', next: [e] };
  }
  return null;
}

/**
 * Return the raw card only when it is carried by a complete, usable probe record.
 * Keeping the trust verdict attached prevents callers from accidentally passing the
 * unverified `ways.card.card` document across a routing boundary.
 */
export function usableCard(cardInfo) {
  if (!cardInfo || typeof cardInfo !== 'object') return null;
  if (cardInfo.found !== true || cardInfo.originBound !== true) return null;
  if (cardInfo.signed !== true && cardInfo.signed !== 'absent') return null;
  const card = cardInfo.card;
  if (!card || typeof card !== 'object') return null;
  if (typeof card.did !== 'string' || !card.did || typeof card.url !== 'string') return null;
  if (cardInfo.did !== card.did || cardInfo.url !== card.url) return null;
  return card;
}

/**
 * The one rule that makes a handoff safe to follow: a continuation that LEAVES the origin
 * is honoured only if the origin's own card names where it points. A `to` must equal the
 * card's DID; a URL without `to` must sit on the dialled origin. `card` is the complete
 * `ways.card` probe record, not its detached raw `.card`. A `ui` entry is never opened
 * without a person — it is returned with `requiresPerson`.
 *
 * Why this exists: a page-authored `to` is rewritable by any third-party script on the
 * page, and a rewritten `to` sends the visitor's signed message — and the account it opens
 * — to another door. The card is the origin's own statement; the page is not.
 */
export function checkHandoff(handoff, { origin, card } = {}) {
  const dialled = safeOrigin(origin);
  if (!dialled) throw new TypeError(`not an http(s) origin: ${origin}`);
  const candidateCard = usableCard(card);
  const cardDoc = candidateCard && safeOrigin(candidateCard.url) === dialled ? candidateCard : null;
  const cardDid = typeof cardDoc?.did === 'string' ? cardDoc.did : null;
  const onOrigin = (u) => safeOrigin(u) === dialled;

  const accepted = [];
  const refused = [];
  for (const e of handoff?.next ?? []) {
    const urls = ['endpoint', 'card', 'server', 'url'].filter((k) => e[k]).map((k) => e[k]);
    if (e.to) {
      if (!cardDid) { refused.push({ entry: e, reason: 'names a DID, but the origin serves no usable card to check it against' }); continue; }
      if (e.to !== cardDid) { refused.push({ entry: e, reason: `names ${e.to}, but the origin's card is ${cardDid}` }); continue; }
      const off = urls.filter((u) => !onOrigin(u));
      accepted.push({ entry: e, ...(off.length ? { note: 'endpoint is off-origin; the reply must verify under the named DID' } : {}) });
      continue;
    }
    const off = urls.filter((u) => !onOrigin(u));
    if (off.length) { refused.push({ entry: e, reason: `leaves the origin (${off.join(', ')}) and the card does not name it` }); continue; }
    accepted.push(e.kind === 'ui' ? { entry: e, requiresPerson: true } : { entry: e });
  }
  return { accepted, refused };
}

/**
 * RFC 9110 §10.2.3: `Retry-After` is either delay-seconds or an HTTP-date. Returns whole
 * seconds ≥ 0, or null when absent or unparseable. Surfaced, never acted on: the router
 * makes one POST per knock() and hands the door's own timing back to the caller (AWR-27).
 */
function retryAfterSeconds(value, now = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

// ================================================================ the knock (the card route, completed)

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const REPLY_WINDOW_S = 300;

/**
 * Load a signing key the caller ALREADY HOLDS: the muretai key file (`{"seed": <64 hex>, …}`)
 * or a bare 64-hex Ed25519 seed. This function never mints — where a key comes from and
 * where it lives is the caller's decision, and an agent that has none is told how to make
 * one by the door itself (see `describeKnock(...).howTo`).
 */
export function loadKey(source) {
  const text = String(source).trim();
  let seedHex = null;
  if (/^[0-9a-fA-F]{64}$/.test(text)) seedHex = text;
  else {
    try {
      const j = JSON.parse(text);
      if (typeof j?.seed === 'string' && /^[0-9a-fA-F]{64}$/.test(j.seed)) seedHex = j.seed;
    } catch { /* not JSON */ }
  }
  if (!seedHex) throw new TypeError('key: expected a 64-hex Ed25519 seed, or JSON with a "seed" field');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const pub = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url');
  return { did: didFromPublicKey(pub), sign: (data) => cryptoSign(null, data, privateKey) };
}

// `signingPayload` (the six frozen fields) and `verifyEnvelopeSignature` (a signature under
// the key `from` itself encodes, never a label) are the wire layer's, imported at the top and
// re-exported unchanged: this package's callers keep the names they had.

/** One signed A2A `message/send` request, ready to POST. `from` is derived from the key
 *  the caller supplied and from nothing else: a `from`, `agent_name` or `as` that a site
 *  writes into its card, its contract or a handoff is never read here (AWR-25) — with
 *  did:key the identity IS the key, so the site cannot hand the visitor one. */
export function buildKnock(key, { to, text, contextId = null, timestamp = null, messageId = null }) {
  if (typeof text !== 'string' || !text) throw new TypeError('knock: text is required');
  const from = key.did;
  const ts = Number.isSafeInteger(timestamp) ? timestamp : Math.floor(Date.now() / 1000);
  const id = messageId ?? randomUUID();
  const sig = key.sign(Buffer.from(signingPayload({ contextId, from, messageId: id, text, timestamp: ts, to }), 'utf8')).toString('base64');
  return {
    jsonrpc: '2.0', id: randomUUID(), method: 'message/send',
    params: { message: { kind: 'message', role: 'user', parts: [{ kind: 'text', text }], messageId: id, contextId, metadata: { timestamp: ts, from, to, sig } } },
  };
}

/**
 * Is this reply an authentic statement by the DOOR, addressed to ME, and fresh? Three
 * questions, answered separately so a refusal says which one failed. `doorDid` is the DID
 * the card named — never the reply's own `from`, which would let any signer pass.
 */
export function verifyReply(result, { doorDid, myDid, now = Math.floor(Date.now() / 1000) }) {
  const out = { ok: false, reasons: [] };
  if (!result || typeof result !== 'object') { out.reasons.push('no message in the reply'); return out; }
  const meta = result.metadata && typeof result.metadata === 'object' ? result.metadata : {};
  const text = Array.isArray(result.parts)
    ? result.parts.filter((p) => p && p.kind === 'text' && typeof p.text === 'string').map((p) => p.text).join('')
    : '';
  if (typeof result.messageId !== 'string' || !result.messageId) out.reasons.push('messageId is missing');
  if (meta.from !== doorDid) out.reasons.push(`signed by ${typeof meta.from === 'string' ? meta.from : 'nobody'}, not the DID the card names`);
  if (meta.to !== myDid) out.reasons.push('not addressed to you');
  if (!Number.isSafeInteger(meta.timestamp) || Math.abs(now - meta.timestamp) > REPLY_WINDOW_S) out.reasons.push(`timestamp outside the ${REPLY_WINDOW_S} s window`);
  if (!verifyEnvelopeSignature({ contextId: result.contextId ?? null, from: meta.from, messageId: result.messageId, text, timestamp: meta.timestamp, to: meta.to, sig: meta.sig })) {
    out.reasons.push('signature does not verify over the six fields');
  }
  out.ok = out.reasons.length === 0;
  if (out.ok) {
    out.text = text;
    out.messageId = result.messageId;
    out.contextId = result.contextId ?? null;
    out.timestamp = meta.timestamp;
  }
  return out;
}

/**
 * Complete the card route: probe the origin, and if the door is a route, POST ONE signed
 * message to it and verify the reply under the DID the card names. The only POST this
 * module ever makes, and it happens only after every probe-time refusal has passed — a
 * substituted card, an off-origin door, or a failed card signature means no knock at all.
 * Returns `{sent:false, why}` in those cases; never throws for a door's refusal (that is
 * an answer, and it teaches).
 *
 * A REFUSAL IS FINAL FOR THE CALL (AWR-27). Exactly one POST is made, whatever comes back:
 * a 429 or 503 is returned with its `Retry-After` as `retryAfter` (seconds), a JSON-RPC
 * error is returned as `error`, and neither is retried here — re-sending the same signed
 * message is a replay by construction, and re-sending a fresh one inside the window is what
 * the door just asked the caller not to do. The caller decides whether to come back later.
 */
export async function knock(origin, { key, text, contextId = null, timeoutMs, deadlineMs, fetch: fetchImpl } = {}) {
  if (!key || typeof key.sign !== 'function' || typeof key.did !== 'string') throw new TypeError('knock: a loaded key is required (see loadKey)');
  const f = fetchImpl ?? globalThis.fetch;
  // deadlineMs budgets the discovery probe; the POST below keeps its own timeout.
  const probed = await probe(origin, { timeoutMs, deadlineMs, fetch: f });
  const decision = route(probed.ways, { key: true });
  const base = { origin: probed.origin, from: key.did, probe: probed };
  if (!decision.routes.some((r) => r.kind === 'card')) {
    return { ...base, sent: false, why: decision.excluded.find((x) => x.kind === 'card')?.why ?? 'the door is not a route here' };
  }
  const contract = describeKnock(probed.ways.card.card);
  const endpoint = contract?.endpoint ?? probed.ways.card.url;
  const to = contract?.recipient ?? probed.ways.card.did;
  if (safeOrigin(endpoint) !== probed.origin) return { ...base, sent: false, why: 'the door\'s endpoint is not on the origin you dialled' };
  if (to !== probed.ways.card.did) return { ...base, sent: false, why: 'the door\'s contract names a recipient other than the card\'s DID' };

  const body = buildKnock(key, { to, text, contextId });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let status = 0;
  let doc = null;
  let retryAfter = null;
  let bodyError = null;
  try {
    const res = await f(endpoint, {
      method: 'POST', redirect: 'manual', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': `agent-web-router/${VERSION}` },
      body: JSON.stringify(body),
    });
    status = res.status;
    retryAfter = retryAfterSeconds(typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null);
    const responseBody = await readBodyCapped(res, ctrl, MAX_KNOCK_RESPONSE_BYTES);
    if (responseBody.ok) doc = parseJSON(responseBody.text);
    else bodyError = responseBody.error;
  } catch (e) {
    return {
      ...base,
      sent: true,
      door: { did: to, endpoint },
      messageId: body.params.message.messageId,
      status,
      ...(retryAfter !== null ? { retryAfter } : {}),
      verified: false,
      error: { message: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) },
    };
  } finally {
    clearTimeout(timer);
  }
  const sent = { ...base, sent: true, door: { did: to, endpoint }, messageId: body.params.message.messageId, status, ...(retryAfter !== null ? { retryAfter } : {}) };
  if (bodyError) return { ...sent, verified: false, error: { message: bodyError } };
  if (!doc) return { ...sent, verified: false, error: { message: `the door answered ${status} with no JSON-RPC body` } };
  if (doc.error && typeof doc.error === 'object') {
    return { ...sent, verified: false, error: { code: doc.error.code ?? null, message: doc.error.message ?? '', ...(doc.error.data !== undefined ? { data: doc.error.data } : {}) }, ...(contract?.howTo ? { howTo: contract.howTo } : {}) };
  }
  if (status < 200 || status >= 300) {
    return { ...sent, verified: false, error: { message: `the door answered HTTP ${status}; a non-success response cannot be a verified reply` } };
  }
  const v = verifyReply(doc.result, { doorDid: to, myDid: key.did });
  if (!v.ok) return { ...sent, verified: false, refused: v.reasons };
  return { ...sent, verified: true, reply: { text: v.text, messageId: v.messageId, contextId: v.contextId, timestamp: v.timestamp } };
}

// ================================================================ the door's contract

/**
 * What to POST at the door, lifted from the card's `securitySchemes` — the entry that
 * lists `signedFields` is the door's own description of the one message it accepts.
 * Returned for whatever holds the key; this module never signs.
 */
export function describeKnock(card) {
  if (!card || typeof card !== 'object') return null;
  const schemes = card.securitySchemes && typeof card.securitySchemes === 'object' ? Object.entries(card.securitySchemes) : [];
  for (const [name, s] of schemes) {
    if (!s || typeof s !== 'object') continue;
    // The requirement object sits either at the scheme's top level or nested under a
    // vendor key beside a standard `type`/`description` — Agent Entry serves it as
    // `securitySchemes["did-key-ed25519"].agentEntry` (measured live, 2026-08-29).
    for (const r of [s, s.agentEntry, s.muretai]) {
      if (r && typeof r === 'object' && Array.isArray(r.signedFields)) {
        const out = { scheme: name, endpoint: r.endpoint || card.url || null, recipient: r.recipient || card.did || null, signedFields: r.signedFields };
        for (const k of ['canonicalization', 'signature', 'timestamp', 'identity', 'howTo', 'exampleRequest']) if (r[k] != null) out[k] = r[k];
        return out;
      }
    }
  }
  if (typeof card.url === 'string') {
    return { scheme: null, endpoint: card.url, recipient: card.did ?? null, signedFields: null, note: 'the card declares no signed-envelope scheme; knock once and read the refusal, which teaches' };
  }
  return null;
}
