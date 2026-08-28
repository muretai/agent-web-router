# Agent Web Router

**Pick how an AI agent enters a website.**

A site can be entered three ways, and they are not rivals:

| way | where it runs | acts as | what remains |
|---|---|---|---|
| **page** — WebMCP tools in the page | a browser tab | the browser's session; headless, nobody | nothing; it closes with the tab |
| **mcp** — an MCP server the site declares | over HTTP | whoever the token names | an account on that server |
| **card** — the Agent Card and the door it names (Agent Entry) | over HTTP | the agent's own key, a `did:key` | a counterparty the site can reach again |

Which one to take depends on **what the agent has on hand**, and that is the whole decision
this tool makes:

- **a person is in the tab** → the page. It is theirs; its tools run in their session.
- **the agent is alone** → the door first (its key is all it needs), the server if it holds a
  token, the page only if it carries a browser of its own.

The router does three things and nothing else: **probe** an origin (GET only — it never POSTs,
never runs page script, never opens a browser), **route** by what is on hand, and **check a
handoff** — a tool result that says "the rest of this happens at the door / on this page / on
this server" — against the site's own card. It does not mint keys, sign, or knock; it hands
whatever holds the key the exact thing to POST.

Zero dependencies. Node ≥ 20. MIT. Status: **0.2.0, not yet on npm.**

## Try it

```
node bin/agent-web-router.mjs probe https://shop.example
node bin/agent-web-router.mjs probe https://shop.example --person      # a person is in the tab
node bin/agent-web-router.mjs probe https://shop.example --browser     # you can run one headless
node bin/agent-web-router.mjs probe https://shop.example --token       # you hold an MCP credential
node bin/agent-web-router.mjs probe https://shop.example --no-key      # you hold no signing key yet
node bin/agent-web-router.mjs probe https://shop.example --json
```

A probe reads the origin you name with GET only: the Agent Card at
`/.well-known/agent-card.json` (falling back to the legacy `/.well-known/agent.json`) and its
signature at `/.well-known/agent-card.sig.json` (plus the card's A2A `additionalInterfaces`,
extension URIs, `domains`, and whether `/.well-known/did-configuration.json` names the card's
DID — naming only, the proof is not verified); the MCP server card at `/.well-known/mcp.json`
(SEP-2127, a draft at the time of writing); and the front page's HTML, from which it lists the
**declarative** WebMCP tools (`<form toolname=… tooldescription=…>`) and reports a hint when
the **imperative** API (`document.modelContext`) is referenced — the imperative tool list is
only observable by running the page, so the probe never claims it.

Output, for a site that runs an Agent Entry and has a couple of declarative tools:

```
agent-web-router 0.2.0 · https://shop.example

ways in
  card   did:key:z6MkExample…
         signed: yes  door: https://shop.example/  skills: 1
  mcp    not declared (404)
  page   2 declarative tool(s) (book_table, hours); imperative hint: modelContext referenced in the page

on hand: key yes  token no  browser no  person no

route  (order: default)
  1. card  the door answers one signed message; your key is all it needs

excluded
  mcp   no MCP server card (/.well-known/mcp.json answered 404)
  page  the page has tools but you carry no browser; 2 declarative form(s) name an action and could be submitted as plain HTTP

knock: POST https://shop.example/  to did:key:z6MkExample…  sign contextId,from,messageId,text,timestamp,to  how-to https://shop.example/agent-entry/how-to
```

Every way appears in exactly one of `route` and `excluded`, so "why not X" is always
answered. Exit status is 0 when there is something to take and 2 when there is not.

**Signposts.** Sites describe themselves to agents in many competing ways — `robots.txt`
(per AI-crawler verdicts and `Content-Signal`), `llms.txt` and `llms-full.txt`, a Markdown
edition on `Accept: text/markdown`, JSON-LD `@type`s, a `Link` header pointing at the card,
VOIX `<tool>` elements beside WebMCP forms. The probe reads the ones sites actually deploy
and reports them
in one `signposts` block so a visitor sees the whole of what the site put up without knowing
every convention. None of them is a way in, so none of them creates a route.

**The skill.** [`SKILL.md`](SKILL.md) is the same procedure written for an agent to follow by
hand — the GETs, the checks, the refusals — for a harness that cannot run Node. The command
line is the version that cannot get the refusals wrong.

## The rules a probe enforces

These are the checks that make the `card` route safe to take. Each is tested by actually
attempting the attack in `test/`.

- **The card must be served by the origin you dialled.** A redirect to another host is a
  substitution, not a card.
- **The card's `url` must name the origin you dialled**, or the door it points at is not this
  site's — the route is excluded.
- **A signature that is present and fails is a refusal, never "unsigned".** A card that
  fails its own signature is exactly what a substituted card looks like. An *absent*
  signature is allowed through with a note: the door's signed reply is what proves the key.
- **A probe is GET only.** Nothing here POSTs; the test suite asserts it.
- **robots.txt is honoured for a headless visit.** If the `*` group disallows the front page,
  the page is not a route for an agent alone — a headless visit is a crawl. A person in the
  tab is not a crawler, so their page route is untouched. The door is for agents and is not
  closed by robots.txt.

## The site designs the order

The order above is only the router's **default**. Which way a visitor should take first is
the site's design: whether a keyless agent should read on the page and become a counterparty
later, or knock first, is something only the site knows. The site says it in its card —
the origin's own statement, signed when the site signs it — not in the page, which any
script it loads can rewrite:

```json
{ "agentEntry": { "open_door": true,
                  "prefer": [ { "kind": "page", "when": "no-key" }, "card", "mcp" ] } }
```

An entry is a kind (`page`, `card`, `mcp`) or `{ "kind", "when" }`, with `when` one of
`person`, `alone`, `key`, `no-key`, `token`, `browser`, read against what the visitor has on
hand. The router puts the declared entries whose condition holds first, in the declared
order, then its own order for the rest; the output says `order: the site's`.

Two things a declaration cannot do: **add a route the rules exclude** (no page without a
person or a browser, no server without a token, no door that failed its signature — it only
re-orders what is on offer), and **come from a card that failed its own signature** (an
excluded card declares nothing). The rest of the path — "you read, now let's make it a
relationship" — is the site's to design too, with a handoff.

## Handoff

A tool result — from a WebMCP tool, an MCP server, or a door — can carry a **handoff**: where
the rest of the interaction happens. Neutral shape, in the slot MCP reserves for extensions:

```json
{ "_meta": { "handoff": { "v": 1, "next": [
    { "kind": "dm",  "to": "did:key:z6MkExample…", "message": "Any bundle discount?" },
    { "kind": "ui",  "url": "https://shop.example/checkout", "why": "payment needs a person" },
    { "kind": "mcp", "server": "https://shop.example/mcp" }
] } } }
```

`next` is ordered: the site's preference first; the router takes the first entry the agent can
honour. The legacy `{ "muretai": { "v": 1, "action": "dm", "to": …, "connect": …,
"suggested_message": … } }` envelope is read as a single `dm` entry.

**The one rule that makes a handoff safe to follow:** a continuation that *leaves the origin*
is honoured only if the origin's own card names where it points. A `to` must equal the card's
`did`; a URL must sit on the dialled origin or on the origin the card's `url` names; a `ui`
entry is never opened without a person. Why: a page-authored `to` is rewritable by any
third-party script on that page, and a rewritten `to` sends the visitor's signed message — and
the account it opens — to another door. The card is the origin's own statement; the page is not.

```
node bin/agent-web-router.mjs handoff result.json --origin https://shop.example
cat result.json | node bin/agent-web-router.mjs handoff - --origin https://shop.example --json
```

Exit 0 when every entry is accepted, 2 when anything is refused or there is nothing to follow.

## What it does not do, and why

It never mints a key, signs, or POSTs. A key is an identity, and where it lives — per visit,
per machine, per site — decides whether the site sees one returning visitor or a stranger
every time. That is a decision the caller owns, so the router stops at `describeKnock(card)`:
the endpoint, the recipient DID, the six signed fields and the how-to, lifted from the card's
own `securitySchemes`, for whatever holds the key.

## Library

```js
import { probe, route, parseHandoff, checkHandoff, describeKnock } from '@muretai/agent-web-router';

const result = await probe('https://shop.example');                 // GETs only
const { routes, excluded } = route(result.ways, { person: false, browser: false, token: false, key: true });
const knock = describeKnock(result.ways.card.card);                  // what to POST, for the key holder

const handoff = parseHandoff(toolResult);                            // null when malformed (fail closed)
const { accepted, refused } = checkHandoff(handoff, { origin: 'https://shop.example', card: result.ways.card.card });
```

`probe(origin, { fetch, timeoutMs })` accepts a custom `fetch` for tests and a timeout
(default 8 s). Bodies are capped (256 KiB for a card, 1 MiB for the page); over the cap is a
finding, not a crash.

## Relation to Agent Entry

[Agent Entry](https://github.com/muretai/agent-entry) is the **site's** side: one file that
makes a website answer a signed stranger in the same request. Agent Web Router is the
**visitor's** side: how an agent decides which of a site's doors to use, and how it follows a
handoff without being sent somewhere the site never named. They share one identity model — the
`did` in the card is the `to` in the envelope — and either works without the other.

Specification draft: [`spec/v0.md`](spec/v0.md). Tests: `npm test`.
