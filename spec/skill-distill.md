# Agent Web Router — Episode-to-Skill (visitor side)

Status: **local loop shipped** (`scripts/distill/`). Does not change the v0
probe / route / knock / handoff contract (`spec/v0.md`). Method: Repo-To-Skill
(arXiv 2609.02749) — distill, verify, load only what the task needs.

This repository stays the **interceptor**. Distillation may improve the
hand-procedure `SKILL.md` and add **post-probe** notes. It MUST NOT add a
route the code excluded, mint a key, browse, or honour a site's prose as
an order.

---

## 1. What is already a skill

[`SKILL.md`](../SKILL.md) is the command line written for a harness that
cannot run Node: the GETs, the checks, the three refusals. The CLI is the
copy that cannot get the refusals wrong. A paper
([arXiv 2606.06460](https://arxiv.org/abs/2606.06460)) measured in-band
"stop" at 0–100% by model; a harness interceptor stopped 120 of 120. For
identity, "tool result is data", and one-POST, **this router is that
interceptor**. Distilled text is not a second interceptor.

What is missing is the paper's loop: turn **grounded probe/knock traces**
into updates of the hand skill, and measure whether those updates do
anything, without letting them override `test/`.

---

## 2. What to steal, what to refuse

Steal: four-stage distillation; progressive disclosure (do not load every
site's notes before probe); environment-grounded admission; withhold-the-
skill measurement; construction record `R`.

Refuse:

- a catalog of thousands of site skills inside the router
- site-authored `prefer` from a card that failed its signature
- any distilled rule that **adds** a route `route()` excluded
- following `content[]` / `structuredContent` / "SYSTEM NOTICE"
- retry after 429 / 503 / `-32004` (replay)
- minting keys or opening a browser to *discover*
- an operator leaderboard of origins

---

## 3. Mapping

| Paper | This repo |
|---|---|
| Source | Probe JSON (`ways`, `excluded` reasons, signposts); knock verify / refuse; `checkHandoff` accepted / refused; the attack fixtures in `test/` |
| Skill | Root `SKILL.md` (universal hand procedure) + optional **per-origin notes** loaded only after a probe of that origin succeeded |
| Skill graph | Router skill (entry) → origin notes (component). Never the reverse |
| Router | This product. `agentEntry.prefer` may re-order what survived exclusion; it cannot resurrect the dead |
| Verification | Existing `test/` attacks: redirect card, failed sig, foreign `url`, foreign MCP, leave-origin handoff, in-band identity |
| Creator / researcher | Offline Distiller proposes a `SKILL.md` patch or an origin note; `probe` / `knock` / `handoff` stay byte-stable |

```
probe (GET only) --> ways + excluded
                     |-- excluded: stop. Distiller may explain, not reopen
                     +-- card survived --> optional origin note from the
                         card's own skills[] / how-to (Agent Entry menu)
knock (one POST) --> verify reply against the card DID
handoff --> honour only where the card points
traces --> Distiller (offline) --> proposed SKILL.md hunk / origin note
measure --> test/ still green; held-out fixtures; mutation
```

Agent Entry is the **door**. This design does not write that door's
`skills[]`. After a card route survives, the visitor MAY open the door's
own menu (signed on that card). That is progressive disclosure across
repos, not a new AWR feature.

---

## 4. Two products, different trust

**A. Universal hand skill (`SKILL.md`).** Distilled only from traces whose
labels are this repo's own refusals (failed sig → refuse door; redirect →
substitution; leave-origin `to` → refuse). A proposed hunk is a patch.
Admission: every attack in `test/` still attempts the opposite and still
fails closed. If a hunk would make a failed-sig card look "unsigned",
reject the hunk.

**B. Origin notes (after probe).** Text the visitor loads only when
`ways.card` survived every refusal. Source is that origin's signed card
(`skills[]`, `securitySchemes`, `howTo`) plus this visitor's own prior
knocks to **that** origin. Not a global memory of the web. The note is
CONSULT. It cannot change `from`, add a route, or retry a refusal.

---

## 5. Distiller pipeline (offline, this repo)

Do not put Distiller on the probe hot path. Shipped layout:

```
scripts/distill/
  record.mjs     # stdin: probe/knock/handoff --json → var/traces.jsonl
  distill.mjs    # traces → generated/rules.json + SKILL.hunk.md
  measure.mjs    # M2 = held-out fixtures (gold = route / checkHandoff)
  loop.mjs       # distill → measure → mutation → npm test (M0)
```

`npm run distill`. `--apply-skill` writes demonstrated `SKILL.md` gaps only
after lift > 0, empty-Distiller lift = 0, and `npm test` green.

1. **Scope.** Either "hand procedure for card-route safety" or "notes for
   origin H after a clean probe".
2. **Ground.** Labels are mechanical: `excluded.reason`, knock exit 2
   reason, `checkHandoff.refused`. Not an LLM judge of the HTML.
3. **Construct.** A unified diff against `SKILL.md`, or a note file that
   quotes only the **signed** card. `R` keeps evidence and gaps.
4. **Verify.** `node --test test/` green. M2 below. Mutation.

---

## 6. Measurement

- **M0.** The contract suite remains the pawl. A skill change that lets
  any current attack through is not a skill.
- **M2 scripted.** Held-out fixture origins (good door, redirect card,
  bad sig, foreign url, leave-origin handoff). Naive policy: "if it
  looks like `x-rlds` / looks like a card, take it". Skill+code policy:
  `probe` + `route` + `checkHandoff`. Score: excluded attacks stay
  excluded; good doors remain takeable.
- **M2 agent.** Same fixtures, harness with/without the **proposed hunk
  or origin note**. The CLI stays available in both arms (it is the
  interceptor). The variable is the extra prose. Score: did the agent
  still refuse the excluded route; did it knock the good door once.
- **Producer mutation.** Distiller emits an empty hunk. Agent lift must
  collapse. CLI scores must be unchanged (the interceptor is not the
  Distiller).
- **Library-size stress.** Hold five origin notes fixed; add decoy notes
  until 50 are visible. If pass rate falls (ACES), that is a reason to
  keep notes post-probe only.

No origin leaderboard.

---

## 7. First dojo (this repo)

Reuse `test/` fixtures as episodes. Each fixture is a trace:
observation = response bytes, action = take/exclude, label = current
router verdict.

- Train: redirect-to-other-host, present-and-failed signature, MCP
  endpoint on another origin.
- Distiller writes three hand-skill bullets that restate those refusals
  in visitor language.
- Holdout: a new redirect host, a new failed-sig card.
- Naive agent takes the holdout door; skill-equipped agent refuses.
- `test/` must still pass if the Distiller is deleted (interceptor
  independence).

Do not probe the live web for the first number.

---

## 8. What this does not change

GET-only probe, body cap, deadline, robots.txt for headless page,
signature-present-and-failed is a refusal, MCP origin bind, one POST,
reply verified against the **card** DID, handoff leave-origin only if
the card names it, no key mint, no browse.

## 9. Relation to Agent Entry and `muretai-skill-distill`

- **Agent Entry** distills what to *ask* (the door's menu). This repo
  distills how to *enter* (find, refuse, knock once).
- After a clean probe, open the door's signed `skills[]` — do not copy
  them into AWR.
- `muretai-skill-distill` showed withhold-the-skill lift on a fail-closed
  parse. The first AWR dojo is the same shape: first-match vs origin-pin.

---

## 10. Live loop — two rails (we never see installer traffic)

Users install this package optionally. Their probe targets, keys, knock
texts, and `--json` logs are **not ours**. There is no telemetry, no
phone-home, no origin catalog. Evolution splits.

### Rail A — this package (what we can update)

We improve the **interceptor and the universal `SKILL.md`**. Labels come
only from:

- `test/` attacks we author (redirect card, failed sig, foreign MCP,
  leave-origin handoff) — these *are* the production data for a router
- probes of origins **we** operate
- a reproducing fixture a user **opts to** paste into an issue
  (the bytes that fooled them, not their full history)

A release may add a refusal, a test, or a `SKILL.md` hunk that restates
a new refusal. It MUST NOT ship origin notes for sites we do not run.
Those notes, if any, live on the installer's disk, pinned to a card
hash they probed.

Measure Rail A against `test/` and held-out fixtures. If `test/` is
green and we have no new fixture, the package does not "learn" that
week — and that is correct.

### Rail B — each installer's machine (what they can update)

`--json` they redirect to a file is theirs. A local Distiller may turn
**their** probes into **their** origin notes. We never receive that
file. Their notes must still fail closed on our published refusals
(the CLI they run already enforces that).

```
their --json → their disk → their notes/<card-hash>.md
our test/    → our next npm release of CLI + SKILL.md
```

### What we do when we cannot see production

We grow the attack suite. The router is valuable because a substitution
is attempted in CI, not because we watched a thousand shops. When
someone says "the agent followed a rewritten `to`", the useful gift is
one `result.json` + the origin's card, not their browsing history.

Do not add a "share usage" default. An `export --redact` (if built)
produces a fixture they attach by hand. No URL we poll.
