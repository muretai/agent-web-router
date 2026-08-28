/**
 * test/router.test.mjs — the router, exercised the way a user exercises it.
 *
 * Every test here obtains its artifact through the PRODUCT: it starts a small site on
 * 127.0.0.1, runs the shipped command line against it, and asserts only on what a person
 * can observe — the printed JSON and the exit status. The site fixture builds its own card
 * envelope with its own tiny canonicalizer and its own base58, on purpose: if the library
 * under test drifted, the fixture would not drift with it.
 *
 * Attack scenarios are here too, because a router that accepts a substituted card or a
 * rewritten `to` is worse than no router at all: each of them is actually attempted and
 * must be refused.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-web-router.mjs');

// ---------------------------------------------------------------- fixture: an identity

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return out;
}
function makeIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const did = 'did:key:z' + b58encode(Buffer.concat([Buffer.from([0xed, 0x01]), raw]));
  return { did, privateKey };
}
// A deliberately independent canonicalizer (sorted keys, no whitespace, integers only).
function canon(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
function signedCard(card, privateKey, ts = 1700000000) {
  const payload = canon({ card, ts, typ: 'agentcard', v: 1 });
  return { v: 1, typ: 'agentcard', card, ts, sig: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64') };
}

// ---------------------------------------------------------------- fixture: a site

function makeCard(base, did) {
  return {
    protocolVersion: '0.3.0', name: 'Example Studio', description: 'a test door', url: `${base}/`, version: '1',
    capabilities: {}, defaultInputModes: ['text'], defaultOutputModes: ['text'],
    skills: [{ id: 'chat', name: 'signed-direct-chat', description: 'signed direct messages', tags: ['chat'] }],
    did, agentEntry: { open_door: true },
    securitySchemes: {
      'signed-envelope': {
        scheme: 'signed-envelope', endpoint: `${base}/`, recipient: did,
        signedFields: ['contextId', 'from', 'messageId', 'text', 'timestamp', 'to'],
        howTo: `${base}/agent-entry/how-to`,
      },
    },
    security: [{ 'signed-envelope': [] }],
  };
}

const HTML_WITH_TOOLS = `<!doctype html><html><body>
<form toolname="book_table" tooldescription="Book a table for a party" action="/book" method="post">
  <label>Party size <input name="size" type="number"></label>
</form>
<form action="/newsletter" method="post"><input name="email"></form>
<script src="/vendor/webmcp-polyfill.js"></script>
<script>document.modelContext.registerTool({ name: "hours", description: "Opening hours", async execute() { return { text: "9-5" }; } });</script>
</body></html>`;
const HTML_PLAIN = '<!doctype html><html><body><h1>Hello</h1></body></html>';

/** Start a site. `build(base, identity)` returns { card?, sig?, mcp?, html? }; a missing
 *  key answers 404 at that path. */
async function startSite(build) {
  const id = makeIdentity();
  let routes = {};
  let headers = {};
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const hit = routes[path];
    if (!hit) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    const [type, body] = hit;
    res.writeHead(200, { 'content-type': type, ...(path === '/' ? headers : {}) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const parts = build(base, id);
  if (parts.card) routes['/.well-known/agent-card.json'] = ['application/json', JSON.stringify(parts.card)];
  if (parts.sig) routes['/.well-known/agent-card.sig.json'] = ['application/json', JSON.stringify(parts.sig)];
  if (parts.mcp) routes['/.well-known/mcp.json'] = ['application/json', JSON.stringify(parts.mcp)];
  if (parts.html) routes['/'] = ['text/html; charset=utf-8', parts.html];
  for (const [p, body] of Object.entries(parts.scripts ?? {})) routes[p] = ['application/javascript', body];
  if (parts.llms) routes['/llms.txt'] = ['text/plain; charset=utf-8', parts.llms];
  if (parts.headers) headers = parts.headers;
  return { base, id, close: () => new Promise((r) => server.close(r)) };
}

async function cli(...argv) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [BIN, ...argv]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
async function probeJSON(base, ...flags) {
  const r = await cli('probe', base, '--json', ...flags);
  return { code: r.code, out: JSON.parse(r.stdout) };
}

// ================================================================ the happy paths

test('probe finds the card, verifies its signature and names the door', async () => {
  const site = await startSite((base, id) => { const card = makeCard(base, id.did); return { card, sig: signedCard(card, id.privateKey), html: HTML_PLAIN }; });
  try {
    const { code, out } = await probeJSON(site.base);
    assert.equal(code, 0);
    assert.equal(out.ways.card.did, site.id.did);
    assert.equal(out.ways.card.signed, true);
    assert.equal(out.ways.card.originBound, true);
    assert.equal(out.route.routes[0].kind, 'card');
    assert.equal(out.knock.endpoint, `${site.base}/`);
    assert.equal(out.knock.recipient, site.id.did);
    assert.deepEqual(out.knock.signedFields, ['contextId', 'from', 'messageId', 'text', 'timestamp', 'to']);
    assert.equal(out.knock.howTo, `${site.base}/agent-entry/how-to`);
  } finally { await site.close(); }
});

test('declarative WebMCP tools are read from the HTML without a browser', async () => {
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), html: HTML_WITH_TOOLS }));
  try {
    const { out } = await probeJSON(site.base);
    assert.equal(out.ways.page.reachable, true);
    assert.deepEqual(out.ways.page.declarativeTools.map((t) => t.name), ['book_table']);
    assert.equal(out.ways.page.declarativeTools[0].action, '/book');
    assert.match(out.ways.page.imperativeHint, /modelContext|webmcp/);
  } finally { await site.close(); }
});

test('the imperative API is hinted from a same-origin script, not only from inline HTML', async () => {
  const html = '<!doctype html><html><body><h1>Shop</h1><script src="/agent-tools.js" data-page="home"></script><script src="https://analytics.example/tag.js"></script></body></html>';
  const site = await startSite((base, id) => ({
    card: makeCard(base, id.did), html,
    scripts: { '/agent-tools.js': 'document.modelContext.registerTool({ name: "hours", description: "Opening hours", async execute() { return { text: "9-5" }; } });' },
  }));
  try {
    const { out } = await probeJSON(site.base, '--browser');
    assert.equal(out.ways.page.imperativeHint, 'modelContext referenced in /agent-tools.js');
    assert.deepEqual(out.route.routes.map((r) => r.kind), ['card', 'page']);
  } finally { await site.close(); }
});

test('the door\'s contract is read when it is nested under the scheme\'s vendor key', async () => {
  const site = await startSite((base, id) => {
    const card = makeCard(base, id.did);
    card.securitySchemes = {
      'did-key-ed25519': {
        type: 'did-key-ed25519', description: 'sign every message/send with your did:key',
        agentEntry: { scheme: 'did-key-ed25519', endpoint: base, recipient: id.did, signedFields: ['contextId', 'from', 'messageId', 'text', 'timestamp', 'to'], howTo: `${base}/how-to` },
      },
    };
    card.security = [{ 'did-key-ed25519': [] }];
    return { card };
  });
  try {
    const { out } = await probeJSON(site.base);
    assert.equal(out.knock.scheme, 'did-key-ed25519');
    assert.equal(out.knock.endpoint, site.base);
    assert.equal(out.knock.signedFields.length, 6);
    assert.equal(out.knock.howTo, `${site.base}/how-to`);
  } finally { await site.close(); }
});

test('a person in the tab goes to the page first; an agent alone goes to the door', async () => {
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), html: HTML_WITH_TOOLS }));
  try {
    const person = await probeJSON(site.base, '--person');
    assert.equal(person.out.route.routes[0].kind, 'page');
    assert.equal(person.out.route.routes[1].kind, 'card');

    const alone = await probeJSON(site.base);
    assert.equal(alone.out.route.routes[0].kind, 'card');
    assert.ok(!alone.out.route.routes.some((r) => r.kind === 'page'), 'no browser on hand: the page is not a route');
    const why = alone.out.route.excluded.find((x) => x.kind === 'page').why;
    assert.match(why, /no browser/);
    assert.match(why, /plain HTTP/);

    const browser = await probeJSON(site.base, '--browser');
    assert.deepEqual(browser.out.route.routes.map((r) => r.kind), ['card', 'page']);
  } finally { await site.close(); }
});

test('an MCP server card is a route only with a token, or when it says it needs none', async () => {
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), mcp: { name: 'example', transport: { type: 'streamable-http', url: `${base}/mcp` } } }));
  try {
    const alone = await probeJSON(site.base);
    assert.equal(alone.out.ways.mcp.declared, true);
    assert.equal(alone.out.ways.mcp.url, `${site.base}/mcp`);
    assert.ok(!alone.out.route.routes.some((r) => r.kind === 'mcp'));
    assert.match(alone.out.route.excluded.find((x) => x.kind === 'mcp').why, /no token/);

    const token = await probeJSON(site.base, '--token');
    assert.deepEqual(token.out.route.routes.map((r) => r.kind), ['card', 'mcp']);
  } finally { await site.close(); }

  const open = await startSite((base, id) => ({ card: makeCard(base, id.did), mcp: { url: `${base}/mcp`, authentication: { required: false } } }));
  try {
    const { out } = await probeJSON(open.base);
    assert.ok(out.route.routes.some((r) => r.kind === 'mcp'), 'open access needs no token');
  } finally { await open.close(); }
});

test('a site with nothing offers no route, and says so in valid JSON with exit 2', async () => {
  const site = await startSite(() => ({ html: HTML_PLAIN }));
  try {
    const { code, out } = await probeJSON(site.base);
    assert.equal(code, 2);
    assert.deepEqual(out.route.routes, []);
    assert.deepEqual(out.route.excluded.map((x) => x.kind).sort(), ['card', 'mcp', 'page']);
  } finally { await site.close(); }
});

test('the legacy /.well-known/agent.json is read when the current path is absent', async () => {
  // A hand-built server: the fixture helper wires only the current card path.
  const id = makeIdentity();
  let base = '';
  const server = http.createServer((req, res) => {
    if (req.url === '/.well-known/agent.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(makeCard(base, id.did))); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { out } = await probeJSON(base);
    assert.equal(out.ways.card.found, true);
    assert.equal(out.ways.card.path, '/.well-known/agent.json');
    assert.equal(out.ways.card.signed, 'absent');
    assert.equal(out.route.routes[0].kind, 'card');
    assert.match(out.route.routes[0].note, /unsigned/);
  } finally { await new Promise((r) => server.close(r)); }
});

// ================================================================ attacks

test('ATTACK: a signed card signed by another key is refused, not ignored', async () => {
  const other = makeIdentity();
  const site = await startSite((base, id) => { const card = makeCard(base, id.did); return { card, sig: signedCard(card, other.privateKey), html: HTML_PLAIN }; });
  try {
    const { code, out } = await probeJSON(site.base);
    assert.equal(out.ways.card.signed, false);
    assert.ok(!out.route.routes.some((r) => r.kind === 'card'), 'a present-but-invalid signature must not become "unsigned"');
    assert.match(out.route.excluded.find((x) => x.kind === 'card').why, /refused/);
    assert.equal(code, 2);
  } finally { await site.close(); }
});

test('ATTACK: a signed card that differs from the plain card is refused', async () => {
  const site = await startSite((base, id) => {
    const card = makeCard(base, id.did);
    const swapped = { ...card, url: 'https://elsewhere.example/' };
    return { card, sig: signedCard(swapped, id.privateKey), html: HTML_PLAIN };
  });
  try {
    const { out } = await probeJSON(site.base);
    assert.equal(out.ways.card.signed, false);
    assert.ok(!out.route.routes.some((r) => r.kind === 'card'));
  } finally { await site.close(); }
});

test('ATTACK: a card whose url names another origin is not this site\'s door', async () => {
  const site = await startSite((base, id) => { const card = makeCard(base, id.did); card.url = 'https://elsewhere.example/'; return { card, html: HTML_PLAIN }; });
  try {
    const { out } = await probeJSON(site.base);
    assert.equal(out.ways.card.originBound, false);
    assert.ok(!out.route.routes.some((r) => r.kind === 'card'));
    assert.match(out.route.excluded.find((x) => x.kind === 'card').why, /another origin/);
  } finally { await site.close(); }
});

// ================================================================ signposts

test('signposts are reported in one place and never become a route', async () => {
  const site = await startSite((base, id) => ({
    card: makeCard(base, id.did),
    html: '<!doctype html><html><body><h1>Shop</h1></body></html>',
    llms: '# Example Studio\n\n> A studio.\n\n- [Hours](/hours.md)\n',
    headers: { link: `<${base}/.well-known/agent-card.json>; rel="agent-card", <${base}/style.css>; rel="stylesheet"` },
  }));
  try {
    const { out } = await probeJSON(site.base);
    assert.equal(out.signposts.llmsTxt.found, true);
    assert.equal(out.signposts.llmsTxt.title, 'Example Studio');
    assert.deepEqual(out.signposts.link, [{ url: `${site.base}/.well-known/agent-card.json`, rel: 'agent-card' }]);
    assert.deepEqual(out.route.routes.map((r) => r.kind), ['card'], 'signposts add no route');
  } finally { await site.close(); }
});

test('VOIX <tool> elements are listed beside WebMCP forms, each with its dialect', async () => {
  const html = '<!doctype html><html><body>'
    + '<form toolname="book_table" tooldescription="Book a table" action="/book" method="post"></form>'
    + '<tool name="add_to_cart" description="Add a product to the cart"><prop name="sku" type="string"></prop></tool>'
    + '</body></html>';
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), html }));
  try {
    const { out } = await probeJSON(site.base);
    assert.deepEqual(out.ways.page.declarativeTools.map((t) => [t.dialect, t.name]), [['webmcp', 'book_table'], ['voix', 'add_to_cart']]);
    assert.ok(!out.route.routes.some((r) => r.kind === 'page'), 'a VOIX tool still needs a browser');
  } finally { await site.close(); }
});

// ================================================================ the site's own order

test('a site can put its server ahead of its door for a visitor holding a token', async () => {
  const site = await startSite((base, id) => {
    const card = makeCard(base, id.did);
    card.agentEntry.prefer = ['mcp', 'card'];
    return { card, sig: signedCard(card, id.privateKey), mcp: { url: `${base}/mcp` } };
  });
  try {
    const { out } = await probeJSON(site.base, '--token');
    assert.equal(out.route.order, 'site');
    assert.deepEqual(out.route.routes.map((r) => r.kind), ['mcp', 'card']);
    assert.equal(out.route.routes[0].by, 'site');
  } finally { await site.close(); }
});

test('a site can say "read on the page first if you have no key; the door is for when you have one"', async () => {
  const site = await startSite((base, id) => {
    const card = makeCard(base, id.did);
    card.agentEntry.prefer = [{ kind: 'page', when: 'no-key' }, 'card'];
    return { card, html: HTML_WITH_TOOLS };
  });
  try {
    const keyless = await probeJSON(site.base, '--browser', '--no-key');
    assert.equal(keyless.out.route.order, 'site');
    assert.deepEqual(keyless.out.route.routes.map((r) => r.kind), ['page', 'card']);

    const keyed = await probeJSON(site.base, '--browser');
    assert.deepEqual(keyed.out.route.routes.map((r) => r.kind), ['card', 'page']);
    assert.equal(keyed.out.route.siteOrderSkipped[0].when, 'no-key');
  } finally { await site.close(); }
});

test('ATTACK: a site\'s order cannot add a route the rules exclude', async () => {
  const site = await startSite((base, id) => {
    const card = makeCard(base, id.did);
    card.agentEntry.prefer = ['page', 'mcp', 'card'];   // the site would love the page first
    return { card, html: HTML_WITH_TOOLS, mcp: { url: `${base}/mcp` } };
  });
  try {
    const { out } = await probeJSON(site.base);          // no browser, no token
    assert.deepEqual(out.route.routes.map((r) => r.kind), ['card']);
    assert.deepEqual(out.route.excluded.map((x) => x.kind).sort(), ['mcp', 'page']);
    assert.equal(out.route.siteOrderSkipped.length, 2);
  } finally { await site.close(); }
});

test('ATTACK: the order declared by a card that fails its signature is ignored', async () => {
  const other = makeIdentity();
  const site = await startSite((base, id) => {
    const card = makeCard(base, id.did);
    card.agentEntry.prefer = ['page', 'mcp'];
    return { card, sig: signedCard(card, other.privateKey), html: HTML_WITH_TOOLS, mcp: { url: `${base}/mcp` } };
  });
  try {
    const { out } = await probeJSON(site.base, '--browser', '--token');
    assert.equal(out.route.order, 'default');
    assert.deepEqual(out.route.routes.map((r) => r.kind), ['mcp', 'page']);
  } finally { await site.close(); }
});

test('an unknown kind or condition in the site\'s order is dropped, not guessed', async () => {
  const site = await startSite((base, id) => {
    const card = makeCard(base, id.did);
    card.agentEntry.prefer = ['teleport', { kind: 'mcp', when: 'full-moon' }, 'card'];
    return { card, mcp: { url: `${base}/mcp` } };
  });
  try {
    const { out } = await probeJSON(site.base, '--token');
    assert.deepEqual(out.ways.card.prefer, [{ kind: 'card' }]);
    assert.deepEqual(out.route.routes.map((r) => r.kind), ['card', 'mcp']);
  } finally { await site.close(); }
});

// ================================================================ handoff

function tmpJSON(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'awr-'));
  const p = join(dir, 'result.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('a handoff to the DID the card names is accepted; to any other DID it is refused', async () => {
  const stranger = makeIdentity();
  const site = await startSite((base, id) => { const card = makeCard(base, id.did); return { card, sig: signedCard(card, id.privateKey) }; });
  try {
    const good = tmpJSON({ text: 'ask the desk', _meta: { handoff: { v: 1, next: [{ kind: 'dm', to: site.id.did, message: 'Hi' }] } } });
    const ok = await cli('handoff', good, '--origin', site.base, '--json');
    assert.equal(ok.code, 0, ok.stderr);
    const okOut = JSON.parse(ok.stdout);
    assert.equal(okOut.accepted.length, 1);
    assert.equal(okOut.refused.length, 0);

    const bad = tmpJSON({ text: 'ask the desk', _meta: { handoff: { v: 1, next: [{ kind: 'dm', to: stranger.did, message: 'Hi' }] } } });
    const no = await cli('handoff', bad, '--origin', site.base, '--json');
    assert.equal(no.code, 2);
    const noOut = JSON.parse(no.stdout);
    assert.equal(noOut.accepted.length, 0);
    assert.match(noOut.refused[0].reason, new RegExp(site.id.did.slice(0, 20)));
  } finally { await site.close(); }
});

test('ATTACK: a handoff is not vouched for by a card that fails its signature', async () => {
  const other = makeIdentity();
  const site = await startSite((base, id) => { const card = makeCard(base, id.did); return { card, sig: signedCard(card, other.privateKey) }; });
  try {
    // `to` equals the (unverified) card's DID — the card cannot vouch, so it is refused.
    const file = tmpJSON({ _meta: { handoff: { v: 1, next: [{ kind: 'dm', to: site.id.did }] } } });
    const r = await cli('handoff', file, '--origin', site.base, '--json');
    assert.equal(r.code, 2);
    assert.match(JSON.parse(r.stdout).refused[0].reason, /no card/);
  } finally { await site.close(); }
});

test('a ui continuation on the origin is accepted but flagged: never opened without a person', async () => {
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did) }));
  try {
    const file = tmpJSON({ _meta: { handoff: { v: 1, next: [
      { kind: 'ui', url: `${site.base}/checkout`, why: 'payment needs a person' },
      { kind: 'ui', url: 'https://elsewhere.example/checkout' },
    ] } } });
    const r = await cli('handoff', file, '--origin', site.base, '--json');
    const out = JSON.parse(r.stdout);
    assert.equal(out.accepted.length, 1);
    assert.equal(out.accepted[0].requiresPerson, true);
    assert.equal(out.refused.length, 1);
    assert.match(out.refused[0].reason, /leaves the origin/);
    assert.equal(r.code, 2);
  } finally { await site.close(); }
});

test('the legacy muretai envelope is read as a dm handoff', async () => {
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did) }));
  try {
    const file = tmpJSON({ text: 'Message the shop', muretai: { v: 1, action: 'dm', to: site.id.did, suggested_message: 'Any bundle discount?' } });
    const r = await cli('handoff', file, '--origin', site.base, '--json');
    const out = JSON.parse(r.stdout);
    assert.equal(r.code, 0);
    assert.equal(out.handoff.legacy, 'muretai');
    assert.equal(out.accepted[0].entry.kind, 'dm');
    assert.equal(out.accepted[0].entry.message, 'Any bundle discount?');
  } finally { await site.close(); }
});

test('a malformed handoff is nothing to follow (fail closed)', async () => {
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did) }));
  try {
    const file = tmpJSON({ _meta: { handoff: { v: 1, next: [{ kind: 'dm' }, { kind: 'teleport', to: site.id.did }, { kind: 'mcp', server: 'ftp://x' }] } } });
    const r = await cli('handoff', file, '--origin', site.base, '--json');
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stdout).handoff, null);
  } finally { await site.close(); }
});

// ================================================================ the command line itself

test('the command line refuses bad input with exit 1 and never POSTs', async () => {
  const posts = [];
  const server = http.createServer((req, res) => { if (req.method !== 'GET') posts.push(req.method); res.writeHead(404); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await cli()).code, 1);
    assert.equal((await cli('probe')).code, 1);
    assert.equal((await cli('probe', 'not a url')).code, 1);
    assert.equal((await cli('handoff', '/nonexistent/result.json', '--origin', base)).code, 1);
    await cli('probe', base);
    assert.deepEqual(posts, [], 'a probe is GET only');
  } finally { await new Promise((r) => server.close(r)); }
});
