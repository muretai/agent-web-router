# Local feedback loop (this machine only)

Turn probe / handoff outcomes you already have into a proposed `SKILL.md` hunk,
and measure whether that hunk would have beaten first-match on a held-out set.

Nothing in this directory uploads, phones home, or reads another origin's
traffic. The Distiller is not on the probe hot path.

```
npm run distill                 # fixtures → rules → holdout measure → npm test
npm run distill -- --skip-m0    # skip the suite
npm run distill -- --apply-skill
npm run distill:record          # stdin: probe --json → var/traces.jsonl
```

## What gets labeled

Gold is the shipped interceptor: `route()` and `checkHandoff`. A card that
exists is not yet a door — first-match thinks it is, which is the naive arm.

Your own `probe --json` / `handoff --json` may be appended to
`var/traces.jsonl` (gitignored). Those rows stay on this disk. They are
merged into the next `distill` as extra train traces.

## Admission

A hunk is mergeable only when:

1. holdout lift > 0 against first-match
2. emptying the Distiller kills that lift
3. `npm test` stays green (the interceptor is not the Distiller)

`SKILL.md` is not auto-published. `--apply-skill` writes demonstrated gaps
only after those three hold.
