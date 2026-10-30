# Fold cost plan (fork-internal)

Goal: lower the dollar cost of long Pi sessions on GPT-6.1 Terra and Claude Opus 5.5 by making folds cheaper and better timed, without losing what billion-context does well (recoverable originals, stable message references, protected content, cache-stable growth). All work stays in this fork. Terms follow [GLOSSARY.md](../GLOSSARY.md).

## Why

Evidence from a recorded 689-request Terra session on GitHub Copilot and from this planning session (Opus 5.5 on Copilot):

- After 20 of 21 folds the next request's cached prefix fell to exactly the system prompt (9,046 tokens): a **cache collapse**. OpenAI's GPT-5.6+ cache only looks back about 20 message endings, and Anthropic's about 20 blocks per marker, so a fold anywhere older loses everything after the system prompt. A **cache marker** at the **fold frontier** would keep the prefix before the fold.
- Measured spend $8.27. Fold-caused rewrites cost about $1.81 of it. A calibrated replay (within about 1%) estimates:

  | Scenario | Modelled cost |
  |---|---:|
  | Billion-context as it ran | $8.18 |
  | + frontier marker | ~$7.31 (range $6.96–7.66) |
  | + marker + payback rule | ~$7.18 |
  | Large batched folds at 125K with a 20K raw tail + marker | ~$6.41 |
  | Pi native compaction, default settings | ~$37–39 (most requests above the 272K price tier) |
  | Pi native compaction tuned to 150K | ~$6.97 (lossy: no recall) |

- Waiting longer to fold costs more: re-reading cached context costs as much as fold rewrites.
- Neither billion-context keepalive nor Pi cache warming was active. On Opus via Copilot (5-minute cache, confirmed: 3-minute breaks stayed warm, 6-minute breaks did not), every break past 5 minutes rewrote the whole context. That was about $34 of $39 in cache writes in an unfolded Opus session.

Models and scripts: `D:/Development/agent-scratch/billion-context-cache-fold-01a18a04/` (`counterfactual-sim.cjs`, `before-after.cjs`, `breaks-scenario.cjs`, `opus-independent-analysis.md`). They read private session data and stay out of the repo.

## Decisions

| Area | Decision |
|---|---|
| Ownership | The fork owner approves kernel and config changes. Upstream discipline kept: kernel version bumps, kernel + host test suites, wire-contract ledger. Nothing is offered upstream for now. |
| Sync | Back up, rebase the fork's own commits onto upstream `master`, `--force-with-lease`. Upstream PRs come in by `cherry-pick -x`. |
| Upstream work | Take #4898 (signed thinking across folds). #2035 (adaptive cadence) is reference only. Skip #3001. Build on #2571 (summarizer), #3390 (keepalive), #1179 (range restore). |
| Who folds | **Cache warm:** the main agent folds in-turn; billion-context proposes a specific **batch** to fold in one call, and the agent may skip ranges it still needs. **Cache cold or idle:** an **idle fold** written by a cheap model on the same account, given the full context, applied before the user resumes. No "written but not applied" fold state. |
| Cheap model per route | Copilot routes → Copilot GPT-6 Luna (1M window). Anthropic → Haiku 5.5. openai-codex → Codex GPT-6 Luna, input capped at 272K. |
| Route profiles | Each **route** gets a **route profile**: prices and tiers, cache lifetime, marker support, billing kind. All current routes are per-token, so optimize dollars; report cache hit rate alongside cost, never alone. |
| Trigger | New mode `compress.trigger: "cost"` (default) with `"growth"` (the 50K nudge) as the switch back. Host code first. Kernel changes are allowed when they produce clearly better results, decided case by case with the owner. |
| Price tier | Tiered routes (Terra: 272K): hard ceiling around 260K. Below it, fold while warm only when the batch's **payback horizon** is short (start at ~75 requests). Fold any meaningful batch when the cache is cold. |
| Anthropic markers | Billion-context owns all 4 slots on Anthropic routes in plugin mode. Pi's separate tools and system markers are replaced: slot 1 frontier anchor (covers system and tools before any fold), slot 2 end of conversation, slots 3–4 decided by the spike. Markers stay on every request. |
| OpenAI markers | Keep implicit caching. Add an explicit marker at the frontier; test spaced checkpoints in the spike. 30-minute lifetime (12 h costs more here). Probe Copilot Terra and openai-codex separately. |
| Keepalive | Billion-context keepalive on Anthropic routes: idle up to 60 minutes, above a context-size threshold. Then stop and allow the idle fold. Pi `cacheWarming` stays at its default. |
| Kept untouched | Recall (`decompress`, `search_context`, content store), immutable message references, protected tools and recent zone, turn integrity, plugin summary carriers, append-only growth, one-call batching, pressure/emergency nudges, summary merging. |
| Paid probes | Synthetic content only, $3 cap total; ask before exceeding. |
| Quality check | A synthetic recall suite run on demand only, plus manual spot checks. Real-model runs need an approved budget. |
| Delivery | One branch (`YYYY-MM-DD_short-title`) and PR into the fork's `master` per phase, reviewed with the code-review skill, merged by the owner. |

## Phases

Each phase lists its exit criteria. Measurement comes before behaviour changes. Markers come before the trigger, because they change what every fold costs.

### P0 — Sync the fork

1. Save current uncommitted work:
   - the #4898 patch, as applied: kernel `reasoning-pairs.ts`, `turn-integrity.ts`, `unit-projection.ts`, the regression test, kernel 0.0.171 and lockfiles;
   - `GLOSSARY.md`, this plan, `docs/research/prefix-cache-folds.md`, `tests/cache-fold-economics.test.ts`.

   Keep the #4898 changes aside; P0.4 re-applies them by cherry-pick.
2. Create `backup/pre-sync-2026-10-30` from the fork's `master`.
3. Rebase the fork's 9 pi-subagents commits onto upstream `master` (231 commits ahead at planning time).
4. Cherry-pick #4898's own commits (`e41d0acc`, `ecdba07c`, `7b7c35c3`) with `-x`. Set the kernel version above upstream's (upstream 0.0.170 at planning time) and resync the lockfiles.
5. Commit the docs, glossary and research test on top.
6. Run: `npm run typecheck`, `npm --prefix kernel test`, `npm --prefix pi-subagents test`, the cache-friendly plugin/proxy suites, and the #4885, #1960 and wire-contract suites. Then `npm run build`.
7. `git push --force-with-lease`. Restart Pi to load the rebuilt extension.

Exit: fork `master` = upstream + fork commits + #4898; builds and tests green; Opus folds no longer hit the signed-thinking 400.

### P1 — Measurement

1. **Provider-accurate cache simulator** for tests:
   - OpenAI GPT-5.6+ lookup boundaries: implicit end, 20 earlier eligible message endings, end of the developer block, first 2 + latest 50 explicit markers, at most 4 writes per request;
   - Anthropic: 4 markers, 20-block lookback per marker (tool runs count as one), writes only at markers;
   - cache lifetimes.
2. Switch `tests/cache-fold-economics.test.ts` to it. It must go red on today's cache collapse.
3. Cache report additions:
   - cache-collapse flag (post-fold cached tokens equal the system/developer boundary);
   - per-batch payback horizon using the measured rewrite;
   - hit rate shown with cost;
   - cold rewrites after pauses;
   - a count of cold resumes that had no idle fold available.
4. Route profiles: read prices, tiers and windows from Pi model data, with fork defaults for cache lifetime and marker support. Copilot Opus: 5-minute cache.
5. Generalize the replay script into a local tool that replays any recorded session through a policy. It never runs in CI, and private data never enters the repo.

Exit: the simulator reproduces today's collapse; replaying a recorded session lands within a few percent of its real bill.

### P2 — Keepalive on Anthropic routes

1. Verify #3390 works in Pi plugin mode for Copilot Opus and Anthropic Opus: it replays the request billion-context actually sent, and pings never count as turns or enter the cache ledger.
2. Enable it with caps: up to 60 minutes idle, a minimum context size, and a per-ping cost check.
3. Confirm no overlap with Pi `cacheWarming`.

Exit: a scripted pause of 10 minutes resumes with a warm cache on both Anthropic routes.

### P3 — Anthropic marker spike, then implementation

1. **Probe** (counts toward the $3 cap) on Copilot Opus and Anthropic Opus with synthetic prompts:
   - markers on arbitrary blocks are honoured;
   - the 4-slot limit;
   - the 20-block lookback;
   - a frontier marker present before the fold is reused after the fold.
2. **Spike:** in the simulator, on replayed sessions, compare candidates for slots 3–4: second frontier, end of summaries, start of the recent raw zone, unused.
3. **Implement:** billion-context owns the 4 slots on Anthropic routes in plugin mode.
   - It replaces Pi's tools and system markers.
   - The frontier anchor stays at the same position on every request until the frontier moves.
   - It never sends more than 4 markers; a wire-contract ledger entry pins that.
   - Proxy mode keeps its current marks unless the spike shows a gain there too.

Exit: in the simulator and the probe, a fold of old content reuses the prefix up to the frontier.

### P4 — OpenAI Responses markers

1. **Probe** Copilot Terra and openai-codex: is `prompt_cache_breakpoint` accepted and honoured?
   - If an upstream rejects it, detect that and drop the field automatically (same pattern as #2645).
2. Implement:
   - an explicit frontier marker, with implicit caching left on;
   - spaced checkpoints if the spike shows gain, adding at most one new marker per request;
   - a 30-minute lifetime.

Exit: same as P3, for Terra routes.

### P5 — Cost trigger (`compress.trigger: "cost"`, default)

Host-side, keeping the kernel's foldability rules as the only definition of what can be folded. Kernel cadence is set low through the existing `compress.nudgeGrowthTokens`, and the host decides.

1. **Inputs:**
   - route profile;
   - current request size;
   - cache warm/cold estimate from time since the last request versus the route's cache lifetime;
   - the kernel's eligible ranges, plus eligible **uncovered runs**;
   - estimated rewrite (tokens after the frontier marker);
   - summary-merge readiness.
2. **Rules:**
   - near-full-window and emergency nudges unchanged;
   - fold before crossing a price tier (ceiling ~260K on Terra);
   - while warm, propose a batch only when its payback horizon is short (start at ~75 requests, tune by replay);
   - otherwise wait and grow the batch.
3. **Nudge content:** one specific batch, to be folded in one call; the agent may skip ranges, and skipped ranges return in a later batch.
4. **Config:** `compress.trigger` (`"cost"` | `"growth"`) documented in `CONFIGURATION.md`, with `"growth"` restoring the 50K nudge exactly.
5. Tests:
   - each rule both fires and does not fire, per `AGENTS.md`'s gate-test rule;
   - both plugin and proxy modes stay green.

Exit: on replayed sessions, cost mode beats growth mode, with no rise in overflow errors or signed-thinking errors.

### P6 — Idle fold

1. Timer per session:
   - Anthropic routes: when keepalive stops (60 minutes);
   - Terra routes: at about 30 minutes idle.

   Fire only if the eligible batch removes at least ~20K tokens net. Cancel cleanly if the user returns mid-run.
2. Summarizer, using #2571's executor:
   - same account as the route, with the cheap model from the decisions table;
   - input: full current context with the ranges marked, the same compression rules, open objectives;
   - if it doesn't fit the window, drop the oldest raw content first.
3. Apply through the normal fold path. Verify a fold applied by billion-context (no agent compress call) displays and is recallable correctly in Pi plugin mode.

Exit: in a scripted session, a pause past the cache lifetime resumes with a smaller cold write, recall still works, and nothing goes stale.

### P7 — Recall suite (on demand)

A scripted synthetic session with known facts, decisions, and later reversals, run through `growth` and `cost` modes (and the idle fold). It checks:
- facts can be recalled;
- reversed items are treated as superseded;
- open objectives survive.

It runs on the fake provider for free, and on real models only on demand within an approved budget. It is not part of CI.

## Validation and rollout

- Compare `growth` and `cost` modes on replayed sessions and the recall suite, then spot-check real work on both Terra and Opus.
- Headline: dollars per session. Guardrails: overflow errors, signed-thinking 400s, recall results. Secondary: fold-rewrite tokens, cache hit rate, cost versus Pi native compaction tuned to the same threshold.
- `cost` mode is the default once P5 passes. `growth` stays available as an instant fallback.

## Open items

- Kernel changes: allowed when they produce better results. Candidates to discuss: trigger logic inside the kernel instead of the host; marker-aware fold selection.
- Whether Copilot honours every marker placement (P3/P4 probes).
- Whether reading a longer cached prefix keeps earlier checkpoint entries alive (affects slots 3–4).
- Summarizer quality at large context; latency of large batches.
- Payback horizon and ceiling values: tune by replay, not fixed up front.

## Out of scope for now

- A "written but not applied" fold state.
- Same-model background compression (#3001).
- Offering changes upstream.
- Bitmap archives (#1422).
- Native-recall replacement (#4857).
