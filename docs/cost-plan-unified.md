# Fold cost plan, unified (fork-internal)

This merges [docs/cost-plan.md](cost-plan.md) with the [Opus 5.5 review](opus-5.5-cost-plan-review.md) and the [Terra 6.1 review](terra-6.1-high-cost-plan-review.md). It takes the best-supported position on each point. Terms follow [GLOSSARY.md](../GLOSSARY.md).

Change tags: **[Δ Opus]**, **[Δ Terra]**, **[Δ both]** mark a change from cost-plan.md, with a one-line reason. **[Owner 2026-10-30]** marks a point the owner decided after the reviews (sync, phase order, per-model keepalive, cheap summarizer). Evidence labels: **[measured]** (usage records, code, provider docs), **[model]** (local scripts), **[assumption]**.

## Goal

Lower the dollar cost of long Pi sessions on GPT-6.1 Terra and Claude Opus 5.5 by making folds cheaper and better timed. Keep what billion-context does well: recoverable originals, stable message references, protected content and cache-stable growth. All work stays in this fork.

**Priority** [Δ Opus; owner answer]: Terra on Copilot first, since it is the owner's main model and the test model for billion-context. Opus second: some sessions, plus Opus as reviewer of Terra sessions. Every route is treated as per-token (owner), and Copilot usage is past the allowance, so marginal dollars are real. Direct Anthropic has no quota right now: all probes and tests run on Copilot or OpenAI routes.

## Evidence

From the recorded 689-request Terra session on Copilot (`01a18a04`) and the Opus/Terra planning session (`01a18bc6`).

- **Cache collapse** [measured]: after 20 of 21 folds, the next request read exactly 9,046 cached tokens, the developer-block boundary. After fold 1 it read 9,252.
  - Cause, **confirmed by probes A and C on 2026-10-30** ([results](research/cache-probe-results-2026-10-30.md), $0.57): GPT-5.6+ implicit caching looks up only the implicit breakpoint, up to 20 earlier eligible message endings and the developer-block end. Anthropic looks back 20 blocks per marker.
    - A synthetic edit beyond the window collapsed the cache to the developer block on Copilot Terra and to the system prompt on Copilot Opus.
    - An explicit marker before the edit preserved the prefix on both: Copilot accepts and honours `prompt_cache_breakpoint` and arbitrary `cache_control` positions, enforces the 4-marker limit, and accepts `ttl:"1h"` (price unverified).
- **Measured spend:** $8.27, priced from per-request usage records, not an invoice [Δ Terra]. Breakdown: reads $3.25 (65.05M), writes $3.54 (2.83M), output $1.47.
  - Fold-caused writes cost $1.81 gross. The premium over reading the same tokens is ≈ $1.70–1.74 [Δ both: gross is not the premium].
- **Model calibration:** $8.06 after removing summary output that the scripts count twice, against $8.27 measured (−2.5%) [Δ Terra: the old "$8.18, within ~1%" double-counted ≈ $0.12]. The double count is about the same in every bili scenario below, so *relative* comparisons hold. The calibration replays measured request sizes, so it checks pricing and TTL handling, not counterfactual dynamics [Δ Opus].

  | Scenario (same 689 requests) | Modelled cost | Notes |
  |---|---:|---|
  | Billion-context as it ran | $8.18 ($8.06 corrected) | |
  | + frontier marker | ~$7.31 ($6.96–7.66) | **[assumption]** marker keeps 30/50/70% of the post-fold view; needs Copilot support |
  | + marker + payback rule | ~$7.14–7.18 | |
  | Batched folds at 125K, 20K raw tail, **no** marker | **$6.87** | [Δ Opus] provider-independent |
  | Batched folds at 125K, 20K raw tail + marker | ~$6.41 | $6.77 if summaries run at 8% instead of 5.3%; rises sharply if uncovered runs never fold |
  | Pi native compaction tuned to **100K / 125K** / 150K | **$6.30 / $6.57** / $6.97 | [Δ Opus] matched thresholds were missing; lossy, no recall |
  | Pi native compaction, default settings | ~$37–39 | $36.6–39.0 across scripts; 532–542 requests above the 272K tier |

- **What the table says** [Δ both]:
  - On cost alone, at a matched 125K threshold, the best bili scenario is within ~2.5% of tuned native compaction, which is inside model error. Bili's case rests on recall and summary quality, not cost. Tuned native compaction is therefore a required comparison arm.
  - Most of the provider-independent gain comes from **batching and threshold** (−$1.3). A marker on top adds −$0.46.
  - A higher threshold costs more (from 125K up). **Fewer, larger batches cost less**: the payback rule alone cuts folds 21 → 16 and cost $8.18 → $7.82 [Δ both: corrects "folding less often is not cheaper"].
  - 3 of 21 folds started *before* the previous fold's earliest range [Δ Opus], so one frontier marker is not enough.
- **Opus breaks** [measured, Δ Opus: replaces the stale $34/$39]:
  - Copilot Opus cache lifetime is 5 min. Gaps of 2.1–3.3 min hit 100%; gaps of 5.4–8.9 min hit 0%.
  - In the planning session, Opus cost $67.57: $52.65 of it writes, of which $47.34 came after breaks over 5 min.
  - Pi warming was inactive because Copilot Opus has no `promptCache` entry. Bili keepalive is off by default.
- **Warm-hit check** [measured, Δ Opus]: Pi moves its last-message marker on every request and warm Opus requests hit ~100%, so moving markers does not break the prefix.

Models and scripts: `D:/Development/agent-scratch/billion-context-cache-fold-01a18a04/` (private, never committed). Review scratch: `D:/Development/tmp-opus-review/`.

## Decisions

| Area | Decision |
|---|---|
| Ownership | Unchanged: the fork owner approves kernel and config changes. Upstream discipline is kept: kernel version bumps, kernel + host suites, wire-contract ledger. Nothing goes upstream for now. |
| Sync | Back up, rebase the fork's commits onto upstream `master`, cherry-pick upstream PRs with `-x`. **[Owner 2026-10-30]**: agents may push directly to the fork's `master`; the owner explicitly overrides AGENTS.md §4's force-push rule for this fork. Method: do the rebase on a branch `2026-10-30_upstream-sync`, run the full P0 test list there, then move `master` with `git push --force-with-lease` only after the tests pass. The backup branch stays. Add an `upstream` remote first; record #4898's head SHA, since it is still open upstream. |
| Upstream work | Take #4898 (Anthropic signed thinking only, not Gemini [Δ Terra]). #2035 reference only. Skip #3001. Build on #2571, #3390, #1179, with the caveats in P4/P6 [Δ both]. |
| Who folds | **Warm:** the main agent folds in-turn; billion-context proposes one specific batch, and the agent may skip ranges. **Cold/idle:** an idle fold by a cheap model, applied before the user resumes. Opus first; low value on Terra (1 cold gap in 689 requests) [Δ Opus]. No persistent "written but not applied" state. An in-flight result exists briefly and is applied by compare-and-apply [Δ Terra]. |
| Cheap model per route | **[Owner 2026-10-30]**: either Haiku 5.5 or GPT-6 Luna, chosen per route from what is available. Cross-vendor summarizing on the same account is approved.<br>• Haiku 5.5 may summarize better; Luna is cheaper, by about 5× above 100K input, where Haiku's long-context tier applies.<br>• Each route lists both in order of preference and falls back to the other.<br>• Copilot routes start with Luna for cost. P7 compares the quality of both, so the default can move to Haiku if it summarizes clearly better.<br>• openai-codex: Codex GPT-6 Luna, input ≤ 272K. Direct Anthropic: Haiku 5.5 once quota exists. |
| Route profiles | Per route: prices and tiers, cache lifetime, marker support, TTL options, billing kind (all per-token, owner). Add fields from the data [Δ Opus]: explicit-breakpoint support (Pi's Copilot/Codex entries lack `supportsExplicitPromptCacheMode`), Copilot Opus `promptCache` (absent), 1h-TTL support (unknown). Report hit rate alongside cost, never alone. The fold-economics price profile must be per sample, not per session; today it is stamped per session (`src/cache-ledger.ts:1993, 2101-2105`) and misprices mixed-route sessions [Δ Terra]. |
| Trigger | New mode `compress.trigger: "cost"`, with `"growth"` (the 50K nudge) as the exact fallback. The trigger takes R (tokens rewritten after the usable cache boundary) from the route profile, so it works with or without markers [Δ Opus]. Host code first. Integrate with the real gates (kernel `minGrowthFloor` 20K, `nudgeOn` in `src/server/lane-decisions.ts:234-238`); lowering `nudgeGrowthTokens` alone does not do it [Δ Terra]. Default once P2's exit and the P7 real-model check pass (owner's decision kept, with stronger gates [Δ both]). |
| Price tier | Terra's tier starts at 272K. The ceiling is **burst-aware**: fold when the view plus a margin for the largest plausible next step (initially the session's 95th-percentile per-request growth) would cross the tier, not at a fixed 260K [Δ Terra: 12K headroom is smaller than one large tool result]. Below it, fold while warm only when the batch's payback horizon is short (start ~75 requests, tune by replay). Fold any meaningful batch when cold. |
| Uncovered runs | [Δ Opus] Sweeping old uncovered runs into a warm batch moves the frontier back toward the system block and erases the marker's saving. Sweep them on cold or idle folds, or when a cache checkpoint sits at the run's start. |
| Anthropic markers (Copilot Opus now; direct Anthropic later) | Billion-context owns the 4 slots in plugin mode, **only on routes whose profile marks markers as validated by probe** [Δ Terra]. Pi's own markers are replaced (on the OAuth Anthropic route Pi uses all 4 [Δ Opus]). Layout: slot 1 frontier anchor; slot 2 end of conversation; slot 3 the **hand-off** (on the request after a fold, keep the old frontier marker for the read and place the new one for the write) [Δ Opus]; slot 4 by spike. Never mark thinking blocks [Δ Opus]. Preserve the client's cache-disabled state and TTL choice [Δ Terra]. If probe C shows 1h support, test **TTL tiering**: 1h on the frontier, 5m on the end [Δ Opus]. |
| OpenAI markers | Keep implicit caching. Add explicit breakpoints at the frontier **and after each tool result** (OpenAI's own agent pattern; the latest 50 explicit boundaries stay eligible), plus checkpoints at summary and uncovered-run boundaries so backward-reaching folds still hit [Δ Opus]. At most 3 new writes per request (implicit uses the 4th). 30-minute lifetime. Probe Copilot Terra and openai-codex separately; drop the field on rejection (#2645 pattern). |
| Keepalive | Bili keepalive on Copilot Opus (direct Anthropic later). Requires `assumeTtl: "5m"` or an interval, because Pi's markers carry no TTL and keepalive will not arm without one (`src/cache-keepalive.ts:279-294`) [Δ Terra]. **Per-model settings [Owner 2026-10-30]**: the existing `providers[<route>].models[<model>].cacheKeepalive` fields (`enabled`, `assumeTtl`, `intervalMs`, `maxDurationMs`) already resolve per model (`src/cache-keepalive.ts:95-115`), so each model gets its own duration with no new config surface. Starting value: **30 min** for Copilot Opus, replacing the settled 60 min. Data: break-even is a ~4% chance (r/(w−r) = 0.2/4.8) that the user returns within the next ~4.5 min, and in the observed Opus gaps a 20–30 min cap saved more than 60 min [Δ both]. **Savings statistics** (P1/P4): log pauses, pings, ping cost and avoided rewrites per model, so caps can be tuned from data. A return-probability stop rule and a minimum-context field are proposed only after that data exists, with a config-surface section. Disarm on session end (reviewer sub-agents never resume) [Δ Opus]. Handle Copilot token expiry; stored headers are replayed [Δ Opus]. Count ping cost and writes, not just `cache_read > 0` [Δ Terra]. Pi `cacheWarming` stays at its default; its pings would pass through the bili pipeline. |
| Kept untouched | Recall (`decompress`, `search_context`, content store), immutable message references, protected tools and recent zone, turn integrity, plugin summary carriers, append-only growth, one-call batching, pressure/emergency nudges, summary merging. Summary merging and **refold after inline restore** (#398) rewrite old positions, so the trigger prices them as frontier events [Δ both: corrects "summaries are never edited later"]. |
| Paid probes | Synthetic content only, $3 cap total, ask before exceeding. Copilot and OpenAI routes only for now (owner). Estimated total for P1 probes: under $1 [Δ Opus]. |
| Quality check | Deterministic recall and wire tests (fake provider: recall round-trip, superseded items, open objectives, refs, carriers in both modes) run **in CI from P1** [Δ both]. Real-model quality runs need an approved budget and must pass before cost mode or idle folds become default [Δ Terra]. |
| Delivery | One branch (`YYYY-MM-DD_short-title`) and PR into the fork's `master` per phase, reviewed with the code-review skill, merged by the owner. |

## Phases

Measurement and cheap probes come first. **[Owner 2026-10-30: reviewer's judgement]** [Δ Opus]: the settled rule "markers before the trigger" is replaced by "probes before both; the trigger does not wait for markers". The trigger's main saving does not depend on any provider, and markers depend on an untested Copilot field. P2 (trigger) and P3 (OpenAI markers) can run in parallel when probe A is positive.

### P0 — Sync the fork

1. Save uncommitted work: the #4898 patch as applied (kernel `reasoning-pairs.ts`, `turn-integrity.ts`, `unit-projection.ts`, `kernel/tests/issue4885-signed-thinking-split.test.ts`, kernel 0.0.171 and lockfiles), `GLOSSARY.md`, the plan and review docs, `docs/research/prefix-cache-folds.md`, `tests/cache-fold-economics.test.ts`.
2. Create `backup/pre-sync-2026-10-30` from fork `master`. Add the `upstream` remote [Δ Opus].
3. On branch `2026-10-30_upstream-sync`, rebase the fork's commits onto upstream `master` (see Sync).
4. Cherry-pick #4898's commits (`e41d0acc`, `ecdba07c`, `7b7c35c3`) with `-x`. Set the kernel version above upstream's and resync lockfiles. Record the PR head SHA [Δ Opus].
5. Commit the docs, glossary and research test.
6. Run `npm run typecheck`, `npm --prefix kernel test`, `npm --prefix pi-subagents test`, the cache-friendly plugin/proxy suites, the #4885, #1960 and wire-contract suites, and `npm run build`.
7. Once green, move fork `master` to the sync branch with `git push --force-with-lease` (owner-approved for this fork). Restart Pi.

Exit: fork `master` = upstream + fork commits + #4898. Builds and tests green. A synthetic Copilot Opus fold over a signed-thinking run no longer returns the 400. Byte-identical replay of thinking blocks is tested on the re-request and the client stream [Δ Terra].

### P1 — Probes and measurement

1. **Probes** [Δ Opus; moved from P3/P4], synthetic, ≤ $1 in total:
   - **A, Copilot Terra (~$0.10).** Setup: a developer block plus ~30 tool turns.
     1. Append one turn; expect a full hit.
     2. Edit turn 3 (more than 20 eligible endings back); expect `cached_tokens` = developer-block end. This confirms the lookback hypothesis.
     3. Repeat with `prompt_cache_breakpoint` on turn 2 in every request; expect cached through turn 2. Record whether Copilot accepts or rejects the field, and `cache_write_tokens`.
   - **B, openai-codex.** Same as A.
   - **C, Copilot Opus (~$0.3–0.5).**
     1. A marker more than 20 blocks back, with later content changed; expect reuse up to the marker.
     2. 5 markers; expect a 400.
     3. Is `ttl:"1h"` accepted, and how is it billed?
     4. Does a short-prefix entry survive while only longer prefixes are read? Read the long prefix at t = 0 and t = 4 min, then only the short prefix at t = 7 min.
   - **D, Copilot Terra (~$0.05).** After 45 min idle, is the cache still warm? This sets the Terra idle-fold timer.
   - Free check: Copilot token lifetime (inspect expiry intervals, never the token).
2. **Provider-accurate cache simulator** for tests:
   - OpenAI GPT-5.6+ lookup boundaries;
   - Anthropic's 4 markers and 20-block lookback;
   - lifetimes;
   - per-sample route prices [Δ Terra].

   Switch `tests/cache-fold-economics.test.ts` to it. It must go red on today's collapse.
3. **Fix the cost scripts** [Δ Terra]: remove the double-counted summary output; price per sample; add ping charges and uncertainty bands. Mark every counterfactual as provisional until replayed on a holdout.
4. **Cache report additions:**
   - cache-collapse flag;
   - per-fold **measured earliest-divergence offset and kept-prefix tokens**, which turns the 50% marker assumption into a measurement on every future session [Δ Opus];
   - per-batch payback horizon from the measured rewrite;
   - hit rate shown with cost;
   - cold rewrites after pauses;
   - cold resumes with no idle fold available;
   - keepalive pings with their reads *and* writes [Δ Terra].
5. **Route profiles** read from Pi model data, with fork defaults and probe results.
6. **Local replay tool** for any recorded session through a policy (never in CI; private data never enters the repo). It includes a tuned native-compaction arm [Δ both].
7. **Deterministic recall and wire tests** in CI (see Quality check) [Δ both].

Exit:
- probes A–D answered and recorded in route profiles;
- the simulator reproduces all 20 collapses and predicts per-request cached tokens within a few percent on the Terra session **and on a holdout session** (for example `01a18b8d`) [Δ Opus: the dollar-only criterion was met by construction];
- the recall and wire tests are green in CI.

### P2 — Cost trigger (`compress.trigger: "cost"`) [Δ Opus: moved ahead of markers; Owner 2026-10-30]

Host-side. The kernel's foldability rules stay the only definition of what can be folded.

1. **Inputs:**
   - route profile (including marker support and R);
   - current request size and recent growth distribution;
   - warm/cold estimate from lifetime and the probe D result;
   - the kernel's eligible ranges and eligible uncovered runs;
   - summary-merge and refold readiness.
2. **Rules:**
   - near-full-window and emergency nudges unchanged;
   - burst-aware tier ceiling;
   - warm: propose a batch only when its payback horizon is short (start ~75 requests, survival-weighted by the expected remaining requests [Δ Terra]);
   - cold: fold any meaningful batch, including uncovered runs;
   - otherwise wait and grow the batch.
3. **Nudge content:** one specific batch in one call. The agent may skip ranges; skipped ranges return later.
4. **Gate integration:** a host decision path through `nudgeOn` and the kernel's `minGrowthFloor`, not just a lower `nudgeGrowthTokens` [Δ Terra].
5. **Config:** `compress.trigger` (`"cost"` | `"growth"`) in CONFIGURATION.md en/zh under a "config surface" heading. `"growth"` restores the 50K nudge exactly.
6. **Tests:** each rule fires and does not fire (AGENTS.md gate-test rule). Plugin and proxy modes stay green.

Exit:
- on the Terra session and the holdout, cost mode beats growth mode **and** tuned native compaction at the matched threshold, or the recall-suite advantage is documented [Δ both];
- a live Terra A/B on real work shows lower dollars per session;
- no rise in overflow errors or signed-thinking errors.

### P3 — OpenAI Responses markers (go for Copilot Terra: probe A positive)

1. Explicit breakpoints at the frontier, after each tool result, and at summary and uncovered-run boundaries. Implicit caching stays on. At most 3 new writes per request. 30-minute lifetime.
2. Detect rejection and drop the field automatically (#2645 pattern), per route.
3. Never on reasoning items. A wire-contract ledger entry pins the marker count and placement rules.

Exit: in the simulator and a repeat of probe A, a fold of old content reuses the prefix up to the nearest earlier breakpoint, including backward-reaching folds.

### P4 — Keepalive on Copilot Opus

1. Verify #3390 in Pi plugin mode: it replays the request billion-context actually sent; pings never count as turns or enter the cache ledger as hits; `assumeTtl: "5m"` or an interval is configured [Δ Terra].
2. Per-model settings through the existing `cacheKeepalive` fields: Copilot Opus starts at `maxDurationMs` = 30 min with `assumeTtl: "5m"` (see Keepalive). Disarm on session end; handle Copilot token expiry [Δ Opus]. Log per-model statistics: pauses, pings, ping cost, avoided rewrites, net saving [Owner 2026-10-30].
3. Confirm Pi `cacheWarming` stays inactive on this route (no `promptCache`), so there is no overlap.

Exit: a scripted 10-minute pause on Copilot Opus resumes warm. A finished reviewer session stops pinging within one interval. The cache report shows per-model keepalive statistics and the net dollars saved. Direct Anthropic is deferred until quota exists [Δ owner].

### P5 — Anthropic marker spike, then implementation (Copilot Opus)

1. **Spike** in the simulator, using probe C: compare candidates for slot 4 (second frontier, end of summaries, start of the recent raw zone, unused). Test TTL tiering if 1h is supported.
2. **Implement** on validated routes in plugin mode:
   - replace Pi's markers;
   - frontier hand-off on the request after a fold;
   - never more than 4 markers, pinned by a wire-contract ledger entry;
   - never on thinking blocks;
   - preserve the client's cache-disabled state and TTL choice.

   Proxy mode keeps its current marks unless the spike shows a gain. Note: bili's own proxy-mode marks freeze after 3 requests (`src/loop/cache-control.ts:54-56`); track that as a separate fork issue [Δ Opus].

Exit: in the simulator and a repeat of probe C, a fold of old content reuses the prefix up to the frontier, with no 400s.

### P6 — Idle fold (Opus first; Terra after probe D)

1. **Timer per session:**
   - Copilot Opus: when keepalive stops;
   - Terra: at the lifetime measured by probe D, not a fixed 30 min [Δ Opus].

   Fire only if the batch removes at least ~20K tokens net. Cancel cleanly if the user returns. Apply only if the session is unchanged since the snapshot (compare-and-apply) [Δ Terra].
2. **Summarizer:** #2571's executor, the cheap model from the decisions table, the same compression rules, open objectives. **It must see every range it folds**: if the input doesn't fit, drop context *outside* the ranges, then chunk the ranges or decline. Never drop the folded ranges themselves [Δ Terra]. Credentials: Copilot's short-lived OAuth token must reach the executor (or run the summarizer from the Pi side) [Δ Opus].
3. **Carrier:** a fold applied without an agent compress call has no carrier in Pi's history. Design one (for example a Pi `context_edit` or custom entry) and prove that Pi's next resent history and the server state stay in sync in plugin mode [Δ both].

Exit: in a scripted session, a pause past the cache lifetime resumes with a smaller cold write; recall works; nothing goes stale; a mid-run user return cancels cleanly.

### P7 — Recall suite

- The deterministic part runs in CI from P1 [Δ both].
- A scripted synthetic session with known facts, decisions and later reversals, run through `growth` and `cost` modes, the idle fold and tuned native compaction. It checks recall, superseded items and open objectives.
- Real-model runs need an approved budget and **must pass before** cost mode or idle folds become default [Δ Terra]. They include a Haiku 5.5 vs GPT-6 Luna comparison of idle-fold summaries (recall score and dollars per fold), which sets each route's preferred summarizer [Owner 2026-10-30].

## Validation and rollout

- Compare `growth`, `cost` and tuned native compaction at the matched threshold on replayed sessions (Terra session + holdout) and the recall suite, then spot-check real work on Terra (main) and Opus.
- Headline: dollars per session. Guardrails: overflow errors, signed-thinking 400s, recall results, wire-contract ledger. Secondary: fold-rewrite tokens, measured kept-prefix per fold, cache hit rate, ping cost.
- `cost` becomes the default once P2's exit and the real-model P7 run pass. `growth` stays an instant fallback.

## Open items

- Owner decisions of 2026-10-30, now applied:
  - sync: agents may push the fork's `master`; sync goes through a branch, then `--force-with-lease`;
  - phase order: trigger before markers;
  - keepalive: per-model settings, starting at 30 min, tuned from savings statistics;
  - summarizer: Haiku 5.5 or Luna by availability; cross-vendor approved.
- Keepalive statistics: once enough pauses are logged, decide per-model caps and whether to propose a return-probability stop rule (a new config field, so it needs a config-surface section).
- ~~Copilot support for `prompt_cache_breakpoint` and arbitrary `cache_control` placement~~: answered yes (probes A, C).
- Copilot's price for 1h writes: accepted, but the price is unverified. Check the Copilot usage report before TTL tiering.
- openai-codex marker support (probe B, not yet built; low priority).
- Whether reading a longer prefix keeps shorter checkpoint entries alive (probe C.4, about $0.25, timed).
- Terra cache lifetime beyond 30 min (probe D, re-read pending).
- Kernel changes, discussed case by case: trigger logic inside the kernel; marker-aware fold selection.
- Summarizer quality on large batches; latency of large batches (#2670 field data: ~15 s per range, 180 s timeouts).
- Payback horizon, tier margin, threshold and raw-tail values: tune by replay, not fixed up front.
- Bili proxy-mode Anthropic marks freeze after 3 requests: file as a fork issue [Δ Opus].
- Not adopted: Terra's proposal to keep cost mode opt-in indefinitely. Kept the owner's "default after P2" with stronger gates. Revisit if the P7 real-model run is not approved.

## Out of scope for now

- A persistent "written but not applied" fold state.
- Same-model background compression (#3001).
- Offering changes upstream.
- Bitmap archives (#1422).
- Native-recall replacement (#4857).
- CCR at-arrival offload of large tool results: potentially large, but it changes agent behaviour and needs its own design [Δ Opus].
- Shorter compress receipts: ≈ $0.1–0.2 per session [Δ Opus].

## Review comparison

| Point | Opus | Terra | Resolution |
|---|---|---|---|
| 9,046 collapse after 20/21 folds | Verified | Verified | Agreed [measured]. |
| Cause = provider lookback | Strongly supported, not proven | Hypothesis; routing, expiry or prefix change remain alternatives | Same position; probe A settles it. Wording changed to "hypothesis". |
| Calibration "within ~1%" | Verified but tautological; reported −1.1% | Summary output double-counted, ≈ $8.06 | **Terra right**: `sideCalls` = $0.116 is added to measured output that already includes it; corrected error −2.5%. Opus right that it is tautological. Relative comparisons hold (same offset everywhere). |
| Native default $37–39 | Said ≈ $37 | $37.92–38.99 from `native-detail-run.cjs`; `native-detail.cjs` crashes | **Both partly**: scripts span $36.6–39.0, so the plan's range stands. Opus's "≈$37" correction withdrawn. |
| Native at matched thresholds | Computed: 100K $6.30, 125K $6.57 | Asked for the comparison | Opus numbers adopted; tuned native becomes an A/B arm and fallback. |
| Marker $7.31 / batched $6.41 | Assumption-driven (50% kept); 3/21 folds reach back; batching without a marker = $6.87 | Assumption-driven | Agreed; P1 now measures kept-prefix per fold. |
| "Later or less often not cheaper" | Later: true; less often: refuted | Refuted as general | Agreed. |
| Copilot Opus 5-min TTL | Verified from planning session `01a18bc6` (3.3 min hit, 5.4 min miss) | Not reproducible from the supplied scratch trace | **Opus**: the evidence is in the planning session file, which Terra didn't inspect. |
| Pi warming inactive | Inactive because Copilot Opus lacks `promptCache` | Pi default is "streaming", not off | Both facts true; Pi warming was inactive for that reason. |
| Pi marker count | 3 on Copilot; 4 on the owner's OAuth Anthropic route | Commonly 3; OAuth can give 4 | Agreed; Opus confirmed the owner's route is OAuth. |
| Summaries never edited | Refuted (refold #398) | Refuted (refold) | Agreed. |
| Idle fold $0.02–0.40 | Arithmetic OK; Haiku ≈ $0.40 at 800K; credentials and latency open | Haiku 900K ≈ $0.56 with cache write | Both: the bound is exceeded on Haiku above ~800K. Prefer Luna; quality unverified. |
| P6 "drop oldest raw content" | Missed | Never fold a range the summarizer didn't see | **Terra right**; adopted. |
| Force-push sync | Missed | Remove force-push on `master` | **Owner 2026-10-30**: agents may push the fork's `master`. Sync goes through a branch with full tests, then `--force-with-lease`. |
| Cost mode default | Default only after holdout + native + live A/B | Opt-in until real-model quality passes | Combined: owner's default kept, gated on P2 exit **and** P7 real-model run. |
| Trigger integration | `minGrowthFloor` 20K noted | `nudgeGrowthTokens` alone doesn't bypass gates (`lane-decisions.ts:234-238`) | Agreed; explicit gate integration in P2. |
| Tier ceiling 260K | Kept as safety | 12K margin too small for bursts | **Terra**: burst-aware margin adopted. |
| Keepalive arming | Not caught | Pi markers lack a TTL, so keepalive won't arm without `assumeTtl`/interval | **Terra right** (`cache-keepalive.ts:279-294`); adopted. |
| Keepalive duration | 30-min hazard rule; token expiry; disarm on session end | Conditional on expected return and net cost | **Owner 2026-10-30**: per-model settings (existing fields), starting at 30 min for Copilot Opus, tuned from logged savings statistics. |
| Keepalive verdict uses reads only | Missed | Partial hits possible; record writes | Terra adopted. |
| Anthropic slot ownership | Hand-off design, thinking-block ban, TTL tiering | Only on validated routes; preserve client TTL/disabled | Both adopted. |
| Phase order | Probes first; trigger not waiting for markers | Measurement + deterministic recall/wire tests first; trigger and idle fold opt-in | Combined: P1 = probes + measurement + CI recall/wire tests; trigger next (**owner 2026-10-30**: reviewer's call). |
| Batching vs markers | Batching is the bigger, provider-independent lever | — | Opus point stands (model data); drives the order change. |
| Uncovered runs vs frontier | Sweeping them erases the marker gain | — | Adopted as a decision row. |
| Route mispricing | — | Per-session price stamp misprices mixed routes | Verified (`cache-ledger.ts:1993, 2101-2105`); adopted. |
| Privacy of cross-vendor summarizer | — | Same account ≠ same data handling | **Owner 2026-10-30**: approved. Haiku 5.5 or Luna by availability; P7 compares their quality. |
| Proxy-mode marks freeze after 3 | Found; out of scope | — | Separate fork issue. |
| Owner answers (billing, quota, model mix) | Asked and applied | Not asked | Applied throughout: Copilot/OpenAI only for now; Terra first. |
| Paid-request constraint | Respected ($0) | Violated: $0.2294 in delegate usage | Recorded; no impact on findings. |
| **Missed by both** | | | (1) Neither review re-derived the kept-prefix share exactly. The per-fold divergence offset is now in P1.4 so future sessions measure it. (2) The agent's own reasoning tokens on large batch folds (latency and output cost) are not modelled; P2's live A/B must report them. (3) Reviewer sub-agent sessions on Opus are short and never resume, so idle folds should not fire on them either; P6 timers apply to interactive sessions only. |
