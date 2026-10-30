# Independent review of the fold cost plan

## Verdict

**Agree with changes.** The investigation identifies a real post-fold cache pattern, but it does not establish the cause or validate the projected savings. I would keep the existing behavior as the default until the model is corrected, route-specific marker behavior is measured, and recall and wire-safety gates pass.

**Constraint violation:** I mistakenly launched model-backed review delegates despite the no-paid-request constraint. The harness reports **$0.2294** in delegate usage; I cancelled the remaining delegate. No paid cache probes were made.

## Claims

`Scratch` below means `D:/Development/agent-scratch/billion-context-cache-fold-01a18a04/`.

| Claim | Assessment | Evidence |
|---|---|---|
| 1. Post-fold 9,046-token prefix and lookback cause | **Partly** | Selective parsing of `Scratch/session-before-retro.jsonl` confirms **20 × 9,046** and **1 × 9,252** cached tokens after 21 folds. [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching) and [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) document limited lookup windows. But the trace lacks upstream wire snapshots: changed-prefix location, routing and expiry remain alternatives. A frontier marker helps only if that exact prefix was previously cached, remains eligible and has not expired. |
| 2. Model calibration and counterfactuals | **Refuted as validated estimates** | Recorded usage prices to **$8.2664**, not necessarily the actual bill. `Scratch/before-after.cjs:38,57` counts observed output—including fold summaries—and adds estimated summary output again. Removing that duplicate from the observed-schedule replay gives approximately **$8.06**, not $8.18. The $7.31, $7.18 and $6.41 results also assume preserved-prefix percentages and foldability rather than measuring them. Native $37–39 and $6.97 are similarly modelled, not observed. |
| 3. Folding later or less often is not cheaper | **Refuted as a general claim** | The same flawed simulation gives **16 folds/$7.82** versus **21 folds/$8.18** without markers. Other sweeps favor earlier thresholds. Frequency, prefix rewritten, future requests and summary quality determine the outcome; neither direction is universal. |
| 4. Copilot Opus TTL; warming inactive | **Partly** | Five minutes is the documented Anthropic default, but the reported Copilot 3-/6-minute observation was not independently reproducible from the supplied trace. `src/cache-keepalive.ts:107` defaults bili keepalive off; Pi’s `docs/settings.md:20-21` defaults warming to **streaming**, not off. Current settings do not prove historical behavior. |
| 5. Marker ownership | **Partly** | Pi commonly marks system, last tool and last user; OAuth and absent/disabled components produce different counts, including four markers. Bili defers to client markers (`src/loop/cache-control.ts:23-31`). Pi Responses sends a cache key but not `prompt_cache_breakpoint`; no such field was found in bili’s Responses path. |
| 6. Decompress and summary immutability | **Partly** | Whole-block decompress normally returns content or a file without unfolding the live block (`src/decompress-shared.ts:143-160,238-277`). However, inline restore permits **in-place refolding**, which changes a summary without merging (`kernel/src/compress.ts:263-286`; `kernel/src/refold.ts:46-93`). |
| 7. Cheap full-context idle folds cost $0.02–0.40 | **Partly** | Plausible for some sizes, not an established bound or quality result. Haiku 5.5 above 100K has higher rates: a **900K-token, five-minute cache write alone is about $0.56**, before output, at published [prices](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). Account access, caching mode, window headroom and quality remain unverified. |

## Decision review

- **Warm agent folds; idle cheap-model folds:** Agree as an experiment, not a default. Require explicit route/privacy consent, complete coverage of every folded range, cancellation and identity/version checks before applying. An in-flight result necessarily exists briefly even without a persistent “written but not applied” state.
- **Cost trigger:** Keep growth mode as the default initially. Treat **75 requests**, **260K** and the batch size as provisional: 260K leaves only 12K before the tier and cannot guarantee against a large next request. Model expected remaining requests, summary output, retrieval and cache misses. Lowering `nudgeGrowthTokens` alone does not bypass kernel cadence or server gates (`kernel/src/compress.ts:1816-1876`; `src/server/lane-decisions.ts:234-238`). Record the owner-approved policy/config change.
- **Anthropic markers:** Do not unconditionally replace client markers. Try bili ownership only on explicitly enabled, validated routes; preserve disabled caching, client intent and TTL semantics. Test slots 3–4 rather than assuming a winner.
- **OpenAI markers:** Agree with a **probe-gated** frontier experiment and optional checkpoints. Retain the 30-minute default initially, but compare explicit-only and longer-retention alternatives where supported; Copilot and Codex must be tested separately.
- **Keepalive:** Make it conditional on expected return and net cost, not a blanket 60-minute policy. Enabling it alone may not arm for Pi’s TTL-less markers: configure a validated TTL/interval or the existing fallback (`src/cache-keepalive.ts:117-150,279-294`). At the default 4.5-minute cadence, roughly 13 full-prefix pings cost **$2.60/M cached tokens**, excluding output; compare Pi idle warming and Anthropic’s one-hour cache. Account for ping costs separately.
- **Phase order:** Safe sync and signed-thinking fix, then measurement **and deterministic recall/wire tests**, then route probes and opt-in markers/keepalive. Put the trigger and idle fold behind opt-in until real-model quality testing is approved and passes. P7 should not wait until after default rollout.
- **Untouched/out of scope:** Agree on protecting references, recall, turn integrity and protected ranges, and on deferring upstream work, bitmap archives and a native-recall replacement. But server-initiated folding crosses plugin ownership: prove Pi’s next resent history and carrier stay synchronized, not merely that server state looks correct (`AGENTS.md:43-46`). Compare tuned native compaction without committing to replace bili recall.

## Errors found

1. **Replay calibration:** $8.18 is artificially close to $8.2664 because summary output is counted twice. The approximate $8.06 correction is still **not** a corrected counterfactual.
2. **Fold cost attribution:** The roughly $1.81 modelled post-fold write is a **gross write cost**, not proof that $1.81 was caused by folding. Structural attribution estimates about $1.70 in write-over-read premium plus roughly $0.116 in summary output; the similar totals measure different things.
3. **Native model reproducibility:** `Scratch/native-detail.cjs` fails with `ReferenceError: U is not defined`. The existing `native-detail-run.cjs` produces **$37.92–38.99** under its reconstructed 922K scenario; its 40% summarizer-input assumption is not established by Pi’s tool-output truncation.
4. **Route switching:** Fold economics use the last stamped price profile for the session (`src/cache-ledger.ts:1993-1995,2101-2105`); mixed-route history can therefore be mispriced.

## Missing items and risks, ranked

1. **Correctness and privacy:** P6 says to drop oldest raw content if input does not fit. Never fold a range the summarizer did not see: chunk it or decline. Test reversals, open objectives, refs, retrieval, user-return races and plugin/proxy carriers. Same account does not establish equivalent data handling.
2. **Session breakage:** [#4898](https://github.com/ranxianglei/billion-context/pull/4898) addresses an Anthropic signed-thinking orphan. Test byte-identical replay and client-visible streams; do not describe the Anthropic-specific patch as covering Gemini signatures.
3. **Cost regression:** Correct the simulator and include per-request route/prices, actual summary output, expiry, ping charges and uncertainty. Compare tuned Pi compaction at matching thresholds and recall requirements.
4. **Cache stability:** A positive keepalive cache read can be only a partial-prefix hit; record writes as well as reads. Test long streams, marker movement, prewarming, routing and cache-disabled paths.

**Paid probes, if separately approved:** With synthetic data and the plan’s $3 cap, test each route’s marker acceptance and prewarmed post-fold reuse; TTL and one-hour support; streaming/ping interaction; and cheap-model recall quality and actual usage. No private conversation data is needed.

## Concrete edits to `docs/cost-plan.md`

1. **P0:** Remove `--force-with-lease` on `master`; preserve dirty work and integrate through a non-force branch/PR.
2. **Why/P1:** Label $8.27 as usage-priced; replace causal lookback wording with a hypothesis. Fix double counting, store prices per sample, report pings and uncertainty, and mark all counterfactual dollar figures provisional. Label the reported Opus $34/$39 attribution unverified.
3. **P2–P4:** Add explicit route capability, TTL and client-marker-preservation gates; compare one-hour caching and Pi warming. Require a prewarmed-prefix probe before claiming a marker saves a fold rewrite.
4. **P5:** Change cost mode from default to opt-in; specify actual kernel/server gate integration, survival-weighted payback and a burst-aware tier margin.
5. **P6:** Replace “drop the oldest raw content” with “include every covered range; chunk or decline.” Add privacy consent, cancellation, compare-and-apply, and Pi host-history synchronization requirements.
6. **P7/rollout:** Run deterministic recall and wire tests in CI **before** behavior rollout; require an approved synthetic real-model quality comparison before making idle folding or cost mode default.
