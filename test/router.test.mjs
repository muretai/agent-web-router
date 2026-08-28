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
import { generateKeyPairSync, sign, verify, createPublicKey, randomUUID } from 'node:crypto';
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
  const seedHex = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url').toString('hex');
  return { did, privateKey, seedHex };
}
// The fixture DOOR verifies a visitor's signature with its own independent decode.
function b58decode(s) {
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}
function publicKeyOf(did) {
  const raw = b58decode(did.slice('did:key:z'.length));
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw.subarray(2)]), format: 'der', type: 'spki' });
}
function sixFields(msg) {
  const meta = msg.metadata || {};
  return canon({ contextId: msg.contextId ?? null, from: meta.from, messageId: msg.messageId, text: (msg.parts || []).map((p) => p.text).join(''), timestamp: meta.timestamp, to: meta.to });
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
  let markdown = null;
  let door = null;          // { replyKey, refuse } — a door that verifies and answers signed
  const posts = [];
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        posts.push({ path, body });
        if (!door || path !== '/') { res.writeHead(404); res.end(); return; }
        let rpc; try { rpc = JSON.parse(body); } catch { rpc = null; }
        const msg = rpc?.params?.message;
        const meta = msg?.metadata || {};
        let ok = false;
        try { ok = !door.refuse && verify(null, Buffer.from(sixFields(msg), 'utf8'), publicKeyOf(meta.from), Buffer.from(meta.sig, 'base64')); } catch { ok = false; }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (!ok) { res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc?.id ?? null, error: { code: -32001, message: 'signature verification failed', data: { howTo: `${base}/how-to` } } })); return; }
        const reply = { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: `Hello, ${meta.from}. Ask away.` }], messageId: randomUUID(), contextId: msg.contextId ?? null };
        const ts = Math.floor(Date.now() / 1000) - (door.stale ? 1000 : 0);
        const signer = door.replyKey;
        const payload = canon({ contextId: reply.contextId, from: signer.did, messageId: reply.messageId, text: reply.parts[0].text, timestamp: ts, to: meta.from });
        reply.metadata = { timestamp: ts, from: door.claimDid ?? signer.did, to: meta.from, sig: sign(null, Buffer.from(payload, 'utf8'), signer.privateKey).toString('base64') };
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: reply }));
      });
      return;
    }
    if (path === '/' && markdown && /text\/markdown/.test(req.headers.accept || '')) {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', ...headers }); res.end(markdown); return;
    }
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
  if (parts.llmsFull) routes['/llms-full.txt'] = ['text/plain; charset=utf-8', parts.llmsFull];
  if (parts.robots) routes['/robots.txt'] = ['text/plain', parts.robots];
  if (parts.didConfig) routes['/.well-known/did-configuration.json'] = ['application/json', JSON.stringify(parts.didConfig)];
  if (parts.markdown) markdown = parts.markdown;
  if (parts.headers) headers = parts.headers;
  if (parts.door) door = { replyKey: id, ...parts.door };
  return { base, id, posts, close: () => new Promise((r) => server.close(r)) };
}

function keyFile(id, form = 'json') {
  const dir = mkdtempSync(join(tmpdir(), 'awr-key-'));
  const p = join(dir, 'visitor.key');
  writeFileSync(p, form === 'json' ? JSON.stringify({ name: 'visitor', seed: id.seedHex, did: id.did }) : id.seedHex + '\n', { mode: 0o600 });
  return p;
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

// ================================================================ 0.2: robots, markdown, json-ld, the card's other faces

const ROBOTS_MIXED = `# example
User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Allow: /
Content-Signal: ai-train=no, search=yes, ai-input=yes

User-agent: *
Disallow: /private/
Allow: /
`;

test('robots.txt is read per AI crawler name, with Content-Signal, and the * group decides for everyone else', async () => {
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), html: HTML_WITH_TOOLS, robots: ROBOTS_MIXED }));
  try {
    const { out } = await probeJSON(site.base, '--browser');
    const r = out.signposts.robots;
    assert.equal(r.found, true);
    assert.equal(r.everyoneMayFetchRoot, true);
    assert.equal(r.ai.GPTBot, 'disallow');
    assert.equal(r.ai.ClaudeBot, 'allow');
    assert.equal(r.ai.PerplexityBot, 'allow', 'an unnamed crawler falls to the * group');
    assert.deepEqual(r.contentSignal, { 'ai-train': 'no', search: 'yes', 'ai-input': 'yes' });
    assert.ok(out.route.routes.some((x) => x.kind === 'page'), 'the page is open to everyone, so a headless visit is fine');
  } finally { await site.close(); }
});

test('a robots.txt that closes the front page to everyone excludes the HEADLESS page route, not the person\'s', async () => {
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), html: HTML_WITH_TOOLS, robots: 'User-agent: *\nDisallow: /\n' }));
  try {
    const headless = await probeJSON(site.base, '--browser');
    assert.equal(headless.out.signposts.robots.everyoneMayFetchRoot, false);
    assert.ok(!headless.out.route.routes.some((x) => x.kind === 'page'));
    assert.match(headless.out.route.excluded.find((x) => x.kind === 'page').why, /robots\.txt/);
    assert.equal(headless.out.route.routes[0].kind, 'card', 'the door is for agents; robots.txt does not close it');

    const person = await probeJSON(site.base, '--person');
    assert.equal(person.out.route.routes[0].kind, 'page', 'a person in the tab is not a crawler');
  } finally { await site.close(); }
});

test('llms-full.txt, a Markdown edition on Accept: text/markdown, and JSON-LD types are reported', async () => {
  const html = '<!doctype html><html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Example Studio"},{"@type":"WebSite"}]}</script></head><body><h1>Shop</h1></body></html>';
  const site = await startSite((base, id) => ({
    card: makeCard(base, id.did), html,
    llms: '# Example Studio\n', llmsFull: '# Example Studio\n\nEverything.\n',
    markdown: '# Shop\n\nWelcome.\n',
  }));
  try {
    const { out } = await probeJSON(site.base);
    assert.equal(out.signposts.llmsFullTxt.found, true);
    assert.equal(out.signposts.markdown.offered, true);
    assert.ok(out.signposts.markdown.bytes > 0);
    assert.deepEqual(out.signposts.structuredData, ['Organization', 'WebSite']);
    assert.equal(out.ways.page.reachable, true, 'the HTML edition is still what the page route reads');
  } finally { await site.close(); }
});

test('a site with no Markdown edition reports markdown: not offered', async () => {
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), html: HTML_PLAIN }));
  try {
    const { out } = await probeJSON(site.base);
    assert.equal(out.signposts.markdown.offered, false);
    assert.deepEqual(out.signposts.structuredData, []);
  } finally { await site.close(); }
});

function jwtNaming(did) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'EdDSA', typ: 'JWT' })}.${b64({ iss: did, sub: did, vc: { credentialSubject: { id: did } } })}.c2ln`;
}

test('the card\'s other faces: A2A interfaces, extensions, domains, and whether did-configuration names the DID', async () => {
  const site = await startSite((base, id) => {
    const card = makeCard(base, id.did);
    card.preferredTransport = 'JSONRPC';
    card.additionalInterfaces = [{ url: `${base}/`, transport: 'JSONRPC' }, { url: `${base}/grpc`, transport: 'GRPC' }];
    card.capabilities = { extensions: [{ uri: 'https://example.com/ext/one', description: 'one' }] };
    card.domains = ['example.com'];
    return { card, didConfig: { '@context': 'https://identity.foundation/.well-known/did-configuration/v1', linked_dids: [jwtNaming(id.did)] } };
  });
  try {
    const { out } = await probeJSON(site.base);
    assert.deepEqual(out.ways.card.interfaces, [{ url: `${site.base}/`, transport: 'JSONRPC' }, { url: `${site.base}/grpc`, transport: 'GRPC' }]);
    assert.deepEqual(out.ways.card.extensions, ['https://example.com/ext/one']);
    assert.deepEqual(out.ways.card.domains, ['example.com']);
    assert.deepEqual(out.ways.card.domainBinding, { found: true, namesCardDid: true, verified: false });
  } finally { await site.close(); }
});

test('a did-configuration that names another DID is reported as not naming this one', async () => {
  const other = makeIdentity();
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), didConfig: { linked_dids: [jwtNaming(other.did)] } }));
  try {
    const { out } = await probeJSON(site.base);
    assert.deepEqual(out.ways.card.domainBinding, { found: true, namesCardDid: false, verified: false });
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

// ================================================================ the knock

test('knock: one signed message at the door, one signed reply, verified under the DID the card names', async () => {
  const visitor = makeIdentity();
  const site = await startSite((base, id) => { const card = makeCard(base, id.did); return { card, sig: signedCard(card, id.privateKey), door: {} }; });
  try {
    const r = await cli('knock', site.base, '--key', keyFile(visitor), '--text', 'Do you have tables tonight?', '--json');
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(out.sent, true);
    assert.equal(out.from, visitor.did);
    assert.equal(out.door.did, site.id.did);
    assert.equal(out.verified, true);
    assert.match(out.reply.text, new RegExp(`Hello, ${visitor.did}`));
    assert.equal(site.posts.length, 1, 'exactly one POST');
    const sent = JSON.parse(site.posts[0].body);
    assert.equal(sent.method, 'message/send');
    assert.equal(sent.params.message.metadata.to, site.id.did);
    assert.equal(sent.params.message.contextId, null);
    assert.deepEqual(sent.params.message.parts, [{ kind: 'text', text: 'Do you have tables tonight?' }]);
  } finally { await site.close(); }
});

test('knock: a bare 64-hex seed and the muretai key file name the same DID', async () => {
  const visitor = makeIdentity();
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), door: {} }));
  try {
    const a = JSON.parse((await cli('knock', site.base, '--key', keyFile(visitor, 'json'), '--json')).stdout);
    const b = JSON.parse((await cli('knock', site.base, '--key', keyFile(visitor, 'hex'), '--json')).stdout);
    assert.equal(a.from, visitor.did);
    assert.equal(b.from, visitor.did);
  } finally { await site.close(); }
});

test('knock without a key sends nothing and prints the door\'s own how-to', async () => {
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), door: {} }));
  try {
    const r = await cli('knock', site.base, '--json');
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.sent, false);
    assert.equal(out.knock.howTo, `${site.base}/agent-entry/how-to`);
    assert.equal(site.posts.length, 0);
  } finally { await site.close(); }
});

test('ATTACK: a reply signed by another key is refused even though it claims the door\'s DID', async () => {
  const visitor = makeIdentity();
  const impostor = makeIdentity();
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), door: { replyKey: impostor, claimDid: id.did } }));
  try {
    const r = await cli('knock', site.base, '--key', keyFile(visitor), '--json');
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.sent, true);
    assert.equal(out.verified, false);
    assert.ok(out.refused.some((x) => /signature does not verify/.test(x)), out.refused.join('; '));
  } finally { await site.close(); }
});

test('ATTACK: a reply signed by another key under its OWN DID is refused: not the DID the card names', async () => {
  const visitor = makeIdentity();
  const impostor = makeIdentity();
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), door: { replyKey: impostor } }));
  try {
    const out = JSON.parse((await cli('knock', site.base, '--key', keyFile(visitor), '--json')).stdout);
    assert.equal(out.verified, false);
    assert.ok(out.refused.some((x) => /not the DID the card names/.test(x)), out.refused.join('; '));
  } finally { await site.close(); }
});

test('ATTACK: a stale reply (outside the 300 s window) is refused', async () => {
  const visitor = makeIdentity();
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), door: { stale: true } }));
  try {
    const out = JSON.parse((await cli('knock', site.base, '--key', keyFile(visitor), '--json')).stdout);
    assert.equal(out.verified, false);
    assert.ok(out.refused.some((x) => /window/.test(x)));
  } finally { await site.close(); }
});

test('ATTACK: a substituted card means no knock at all — nothing is POSTed', async () => {
  const visitor = makeIdentity();
  const other = makeIdentity();
  const site = await startSite((base, id) => { const card = makeCard(base, id.did); return { card, sig: signedCard(card, other.privateKey), door: {} }; });
  try {
    const r = await cli('knock', site.base, '--key', keyFile(visitor), '--json');
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.sent, false);
    assert.match(out.why, /refused/);
    assert.equal(site.posts.length, 0);
  } finally { await site.close(); }
});

test('the door\'s refusal is an answer, not a crash: its code, message and how-to are shown', async () => {
  const visitor = makeIdentity();
  const site = await startSite((base, id) => ({ card: makeCard(base, id.did), door: { refuse: true } }));
  try {
    const r = await cli('knock', site.base, '--key', keyFile(visitor), '--json');
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.sent, true);
    assert.equal(out.verified, false);
    assert.equal(out.error.code, -32001);
    assert.equal(out.error.data.howTo, `${site.base}/how-to`);
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
