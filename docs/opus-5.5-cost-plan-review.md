# Review of docs/cost-plan.md (Claude Opus 5.5)

Independent review, written before reading the GPT-6.1 Terra review. Terms follow [GLOSSARY.md](../GLOSSARY.md). Labels used throughout: **[measured]** = read from session usage records, code or provider docs; **[model]** = output of the local cost scripts; **[assumption]** = an input nobody has measured.

Private data stayed local. Only aggregate numbers appear here. Scratch scripts used for this review are under `D:/Development/tmp-opus-review/`.

## 1. Verdict

**Agree with changes.** The diagnosis holds: post-fold cache collapse to the 9,046-token developer block is real, and both providers' lookback rules explain it. Batching, price-tier awareness, keepalive and idle folds are the right tools. Four things need to change:

- The headline comparison is not like-for-like. At a matched 125K threshold, tuned Pi native compaction ($6.57 [model]) comes within about 2.5% of the plan's best scenario ($6.41 [model]).
- Most of the provider-independent saving comes from batching and threshold, not markers. On Copilot, markers depend on a field nobody has shown Copilot honours.
- Two plan facts are wrong: fold summaries can be rewritten later (refold), and Pi uses all 4 Anthropic slots on the owner's OAuth Anthropic route.
- The phase order should put the cheap probes first. The provider-independent trigger work should not wait for marker work.

## 2. Claims table

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1a | After 20 of 21 folds the next request's cached prefix was exactly 9,046 | **Verified** [measured] | `folds.cjs` over `session-before-retro.jsonl`: 21 successful compress calls. The request after each of folds 2–21 read exactly 9,046 cached (requests 41, 52, 60, 88 … 666). The request after fold 1 read 9,252 (system + first user message). The bili restart at request 79 also read 9,046. |
| 1b | Cause is provider lookback, not folding itself | **Partly** (strongly supported, not proven) | OpenAI guide, "How prefix matching works": for GPT-5.6+, implicit-mode lookup boundaries are "the implicit breakpoint, up to 20 earlier eligible message endings, and the endpoint of the initial consecutive block of developer messages". Cached-token reporting is the "exact eligible boundary". Anthropic guide: "The lookback window is 20 blocks … a run of consecutive tool_use blocks counts as one position". No request bodies were recorded, so an early rewrite would produce the same 9,046 signature. A probe settles it (§5, probe A). |
| 1c | A marker at the fold frontier would preserve the prefix before the fold | **Partly** | True by provider semantics when the marker existed on an earlier request, its entry is still alive, and the route honours it. Not shown on Copilot: Pi's Copilot and Codex Terra entries lack `supportsExplicitPromptCacheMode` (models-store.json), so nothing has ever sent the field there. 3 of 21 folds started *before* the previous fold's earliest range (folds 3, 12 and 18: m85 < m100, m1069 < m1157, m1992 < m2073). A single frontier marker would not have saved those. |
| 2a | Model reproduces $8.27 within ~1% | **Verified, but weak evidence** | [model] $8.176 against [measured] $8.266 (−1.1%). Reads: 65.22M modelled, 65.05M measured. Writes: 2.66M modelled, 2.83M measured (−6%). The calibration replays the measured per-request sizes, so it checks price arithmetic and TTL handling, not counterfactual dynamics. |
| 2b | Pi native default ≈ $37–39 | **Partly** | [model] $36.95 (`counterfactual-sim.cjs`) and $36.57 + $0.40 compaction call (`before-after.cjs`), with 532 of 689 requests above 272K. "≈ $37" is the supported figure; $41.25 is *no* compaction. All of these assume the agent behaves the same at 900K. |
| 2c | Native tuned to 150K ≈ $6.97 | **Verified [model], but cherry-picked** | Same script: native 125K = **$6.57**, 100K = **$6.30**. The plan's table omits both. The plan compares native at 150K against batched bili at 125K. |
| 2d | Frontier marker ≈ $7.31 | **Partly** | [model] value with **[assumption]** "marker keeps 50% of the post-fold view" (`replay(0.5)`), not derived from the data. A rough structural check (fold ranges mapped to Responses items) puts the kept share at ~5–10% for folds 1–3 and well above 30% for most later folds. The acp_status snapshot at 689 shows ~33K uncovered + 23K summary tokens before the live compressible zone. 50% is plausible and the $6.96–7.66 band is honest. Conditional on Copilot support. |
| 2e | Marker + payback ≈ $7.18 | **Verified [model]** | Scenario C in `before-after.cjs` (N=75, 256K cap). The deferral sweep gives $7.14–7.16 for N=50–100. |
| 2f | Batched folds at 125K, 20K tail, marker ≈ $6.41 | **Verified [model], fragile** | Same function without a marker: **$6.87**. With an 8% summary ratio instead of 5.3%: $6.77. The model assumes every eligible message down to a 20K raw tail folds each time; any residue that never folds (uncovered runs) raises cost sharply (my `sim2.cjs` variant thrashes). |
| 3 | Folding later or less often is not cheaper | **Partly refuted** | *Later* (higher threshold): verified. With a 20K tail the cost rises monotonically from 125K ($6.41) to 256K ($8.16). Too *early* thrashes: 100K with a 40K tail costs $8.66. *Less often*: refuted by the plan's own payback rule, which cuts folds 21 → 16 and lowers cost $8.18 → $7.82 [model]. Batching (fewer, larger folds) is the main win. |
| 4a | Copilot Opus has a 5-minute cache | **Verified** [measured] | Planning session `01a18bc6`, Opus requests: gaps of 2.1–3.3 min hit 100%; gaps of 5.4, 6.2, 7.0, 7.4, 7.7 and 8.9 min hit 0%. |
| 4b | Neither keepalive nor Pi warming was active | **Verified** | Pi warming needs `model.promptCache` (`pi-coding-agent/dist/core/cache-warmer.js:26-33, 129-133`). Copilot `claude-opus-5.5` has none in models-store.json, and the session files contain no `cache_warm` usage entries. Bili keepalive defaults to off (`src/cache-keepalive.ts:107`, `lvl("enabled") === true`). |
| 4c | ≈$34 of $39 cache writes in an unfolded Opus session | **Stale** | Full session now [measured]: Opus $67.57 total, $52.65 of it writes, **$47.34** on requests after >5-min gaps, plus ~$4.4 on model switches. |
| 5a | Pi uses 3 of 4 Anthropic slots | **Partly** | True on Copilot: system (`anthropic-messages.js:944-951`), last tool (`:1325`), last user/tool_result block (`:1216-1238`). On the owner's direct Anthropic route, auth.json holds an OAuth token, so Pi takes the Claude Code path (`:780-781`, `:928-942`): **2** system markers + tools + last message = **4**. |
| 5b | Billion-context defers to client markers | **Verified** | `src/loop/cache-control.ts:27-30`; `src/server/prepare-anthropic.ts:470-472` (any client mark → `undefined` bili marks). |
| 5c | On Responses, neither Pi nor bili sends `prompt_cache_breakpoint` | **Verified** | `grep` finds no occurrence in `src/`, `kernel/src/` or pi-ai dist. Pi sends `prompt_cache_options` only when `compat.supportsExplicitPromptCacheMode` is set (`openai-responses.js:95-104`), and it is unset on Copilot and Codex. |
| 6a | decompress copies content and never unfolds | **Verified** | `kernel/src/decompress.ts:160-166` (the block stays folded), `src/decompress-shared.ts:250-266` (file or tool-result path). `deactivateBlock` has no non-test callers. |
| 6b | Summaries are never edited later; contradictions reconcile only on merge | **Refuted** | After an inline whole-block restore the block is flagged `restoredInline`, and a later `compress` **refolds it in place with a new summary** (#398: `kernel/src/compress.ts:263-282`, `kernel/src/refold.ts:70`, `src/decompress-shared.ts:258-275`). That rewrites an old position, which is a frontier event with full rewrite cost. |
| 7 | A cheap model writes idle folds for ~$0.02–0.40 | **Verified as arithmetic; feasibility open** | Copilot pricing page and models-store: Luna $0.10/M (≤272K), $0.20/M above. Haiku 5.5 $0.10/M (≤100K), **$0.50/M above 100K**. 150K: Luna ≈ $0.02, Haiku ≈ $0.08. 800K: Luna ≈ $0.16, Haiku ≈ $0.40, plus reasoning output (Haiku $2.50/M above 100K). Open: the #2571 executor uses static credential refs, while Copilot uses short-lived OAuth tokens held by Pi. #2670's field data shows ~15 s per range and 180 s timeouts on large batches. Summary quality is unmeasured. |

## 3. Decision review

| Decision | Verdict | Reason / change |
|---|---|---|
| Ownership | Agree | — |
| Sync | Agree, with fixes | No `upstream` remote is configured (`git remote -v` shows only origin). Add it before P0.3. #4898 is still **open** upstream (checked via the GitHub API), so expect a conflict when upstream merges its own version. Record the PR head SHA. |
| Upstream work | Agree, with caveats | #3390 keepalive replays the stored request **headers** (`src/cache-keepalive.ts:315, 414-425`). If Copilot's short-lived token expires mid-idle, pings 401 and disarm after 3 failures. The default `maxDurationMs` is 24 h (`:31`); cap it explicitly. #2571: see claim 7. |
| Who folds (warm) | Agree | A specific batch proposal is the right lever; batching is where the money is (claim 3). |
| Who folds (cold/idle) | Partly | Sound in principle: a cold fold carries no rewrite premium. On Terra (the owner's main model) the value is small: 1 gap over 30 min in 689 requests, $0.13 of TTL rewrites [model]. It is valuable on Opus after long breaks. In plugin mode the summary carrier is the agent's own compress call, so a fold applied by bili has *no carrier* in Pi's history. That is a design gap, not a verification item; Pi's `context_edit`/custom-message entries are the natural carrier. |
| Cheap model per route | Partly | Direct Anthropic has no quota right now (owner), so use Copilot Haiku 5.5 or Luna. Haiku's 100K tier makes it 5× pricier on large contexts, so prefer Luna. The Codex Luna 272K cap needs the "drop oldest raw" rule from P6.2. |
| Route profiles | Agree | Owner confirms every route is treated per-token, and Copilot usage is past the allowance. Add data-driven fields: `supportsExplicitPromptCacheMode` (absent on Copilot today), Copilot Opus `promptCache` (absent), 1h-TTL support (unknown on Copilot). |
| Trigger | Partly | Cost mode is right. Two changes: (a) it must not depend on markers existing; take R (rewrite after the usable boundary) from the route profile. (b) Make it the default only after it beats *both* growth mode *and* tuned native at the same threshold, on a holdout session and a live Terra A/B. |
| Price tier | Agree | It rarely binds once batching sits at ~125–150K; keep it as a safety. |
| Anthropic markers | Partly | Owning the slots is fine. Spell out the **frontier hand-off**: on the request after a fold, keep the old frontier marker (read) *and* place the new one (write); that is what slot 3 is for. Never put `cache_control` on thinking blocks (Anthropic docs: "Thinking blocks cannot be cached directly"). Consider **TTL tiering**: 1h on the frontier anchor, 5m on the end marker (1h must precede 5m). Moving markers is safe: Pi re-places its last-message marker every request and warm Copilot Opus requests hit ~100% [measured]. |
| OpenAI markers | Agree, with additions | OpenAI's own multi-turn agent example puts an explicit breakpoint **after every tool result**. With "first 2 + latest 50" explicit lookup boundaries, that covers any fold within the last ~50 tool results with no frontier logic, and the frontier marker covers the rest. Implicit mode spends one of the 4 write slots. Probe Copilot first. |
| Keepalive | Partly | Ping cost / miss cost = r / (w−r) = 0.2/4.8 = **1/24** on Opus, at any context size. A ping pays only if P(user returns within the next ~4.5 min) > ~4%. In the observed Opus gaps, a **20–30 min** cap beats 60 min: at 800K, 20 min ≈ $30 net saved against ≈ $26 for 60 min [model, rough]. Pi itself caps idle warming at 30 min with p = 0.15. Start at 30 min, make the stop rule hazard-based, and disarm when the session ends; reviewer sub-agent sessions never resume. |
| Kept untouched | Agree | Note that summary merging (tier-2) and refold rewrite old positions, so they are frontier events the cost trigger must price. |
| Paid probes | Agree | My estimate for the full probe set (§5) is under $1. Copilot only (no Claude quota). |
| Quality check | Partly | Put the free fake-provider plumbing checks (recall round-trip, superseded flags, open objectives carried) into CI. Real-model quality runs stay on demand. |
| Delivery | Agree | — |
| "Markers before the trigger" (phase rule) | **Disagree; needs owner decision** | Batched 125K/20K without a marker = $6.87 against $8.18 as ran (−$1.31) [model], provider-independent. A marker on top adds −$0.46 and depends on unverified Copilot support. Run the probe first, then the trigger, in parallel with markers. |

## 4. Errors found (with corrected numbers)

1. **Native comparison is not like-for-like.** Add native at 125K = $6.57 and 100K = $6.30 [model]. At matched 125K, bili with marker is $6.41 (−2.4%) and bili without marker is $6.87 (+4.6%). On cost alone the plan's best case is within model error of tuned native; the argument for bili is recall and summary quality.
2. **"Summaries are never edited later"** is false: refold after inline restore (#398) replaces a summary in place.
3. **"Pi uses 3 of 4 slots"** holds only on Copilot. The owner's direct Anthropic (OAuth) path uses 4.
4. **"$34 of $39"** is stale: $47.34 of $52.65 in writes; Opus total $67.57 [measured].
5. **"Pi native default ≈ $37–39"** should read ≈ $37 [model]. $41.25 is the no-compaction figure.
6. **"Folding less often is not cheaper"** is wrong. The payback rule *is* folding less often and saves $0.36–0.41 [model]. Correct statement: a higher threshold costs more; fewer, larger batches cost less.
7. **Model carrier factor.** The scripts assume carrier = 2× summary. Measured compress receipts total ~0.43× the call-argument size (43.7K vs 102.3K chars), so the carrier is ≈1.4×. Small effect on the totals.
8. **P1 exit criterion** ("replay within a few percent of the real bill") is met by construction. See §5, item 8.

## 5. Missing items and risks

Ranked by expected dollar impact for the owner's mix (mostly Terra, some Opus, Opus as Terra reviewer), then by severity.

1. **Copilot marker support is the hinge, and it is untested.** Run the probes before any marker code.
   - **Probe A (Copilot Terra, ~$0.10):** a ~2K developer block plus ~30 user/tool turns of ~1.5K each.
     1. Repeat the request with one new turn appended; expect a full hit.
     2. Edit turn 3 (more than 20 eligible endings back); expect `cached_tokens` = developer-block end. This confirms lookback.
     3. Repeat with `prompt_cache_breakpoint` on turn 2's last block in every request; expect cached through turn 2. Record whether Copilot accepts or rejects the field, plus `cache_write_tokens`.
   - **Probe B:** the same on openai-codex.
   - **Probe C (Copilot Opus, ~$0.3–0.5):**
     1. A marker on an arbitrary block more than 20 blocks back, with content changed after it; expect reuse up to it.
     2. 5 markers; expect a 400.
     3. `ttl:"1h"`: is it accepted, and how is it billed?
     4. Does a shorter marker's entry survive while only longer prefixes are read? Read the long prefix at t = 0 and t = 4 min, then only the short prefix at t = 7 min.
   - **Probe D (Copilot Terra, ~$0.05):** a 45-min idle, then the same request. Does the cache outlive the 30-min minimum? This decides whether a 30-min idle fold destroys a warm cache.
2. **Batching and threshold come before markers** (§3). Worth −$1.3/session on Terra [model], independent of the provider.
3. **Uncovered runs conflict with the frontier marker.** P5 sweeps "eligible uncovered runs" into batches, but those runs are the *oldest* raw content (33K across 19 runs at request 689 [measured, acp_status]). Including them moves the frontier back toward the system block and erases the marker's benefit. Rule: sweep uncovered runs on cold folds, or place checkpoints at uncovered-run boundaries.
4. **Backward-reaching folds, merges and refolds** (3 of 21 folds; tier-2 merges; #398 refold) defeat a single frontier marker. Spaced checkpoints are a requirement on OpenAI, not a "test in the spike": up to 50 recent explicit boundaries are cheap.
5. **Tuned native compaction as an explicit A/B arm and fallback.** Pi supports per-model `reserveTokens` (compaction.md:440-457), so it costs nothing to configure. Decision gate: if cost mode does not beat native at a matched threshold, recall quality must justify the gap.
6. **Keepalive economics and lifetime** (§3). Copilot token expiry may cap stored-header pings; check free by reading token-expiry intervals, never the token. Reviewer sub-agent sessions end without resuming, so keepalive must disarm on session end or it pays for nothing.
7. **TTL-tiered Anthropic markers** (1h frontier, 5m tail). If Copilot honours 1h, a break of up to 60 min rewrites only the tail, with no pings. Probe C.3.
8. **Single-session overfitting.** Every number comes from one 689-request session. P1 needs a holdout (for example `01a18b8d`, a Terra/Opus mix) and must predict *per-request cached tokens* (all 20 collapses, warm-hit tokens), not just dollars.
9. **Summary quality on large batches.** One agent call summarizing ~100K tokens; the summary ratio may move from 5.3% to 8%+ ($6.41 → $6.77). The agent's "skip ranges I still need" grows the effective tail (20K → 40K costs +$0.76 at 125K [model]).
10. **Idle fold in plugin mode** has no carrier (§3), and #2571 uses static credentials while Copilot tokens are short-lived (claim 7). High effort, low Terra value: do it after the rest.
11. **Signed thinking.** Markers must avoid thinking blocks. #4898 INV3 withdraws partially folded signed runs, so Opus sessions will show more uncovered runs, which the batch and frontier logic must expect.
12. **Bili's own Anthropic marks freeze after 3 requests** (`cache-control.ts:33, 54-56`: no new mark once 3 are kept). In proxy mode with a client that sends no markers, the growing tail is never written. The stated premise ("removing a marker mutates bytes") contradicts the measured ~100% hits with Pi's rolling marker. Out of scope for Pi plugin mode; file it as a separate issue.
13. **Smaller items.** Explicit-only OpenAI mode avoids writing content unlikely to be reused. CCR at-arrival offload of large `read` results (28% of tool tokens at 689) is potentially large but changes agent behaviour, so it needs its own design. Shorter compress receipts save ≈ $0.1–0.2 per session.

**Phase order I recommend:** P0 → probes A–D (≤ $1) → P1 (simulator + report + holdout) → P5 (trigger with batching; R from the route profile) in parallel with P4 (Terra markers, if probe A is positive) → P2 (keepalive, 30-min hazard cap, Copilot Opus only) → P3 (Anthropic markers on Copilot Opus) → P6 (idle fold, Opus first) → P7.

## 6. Open questions for the owner

| Question | Answer |
|---|---|
| The `anthropic` route uses an OAuth token. Is it a subscription or per-token? | "Purely token based, enterprise. We have no claude quota atm so please use either github copilot or open ai models for this." → Probes and tests run on Copilot or OpenAI only; Anthropic-direct exits are deferred. |
| `openai-codex` is a ChatGPT sign-in. How should it be optimized? | Treat as per-token. |
| Opus vs Terra spend split? | "Mostly terra with some sessions using opus, and opus as a reviewer of terra sessions. For most of our testing of the billion-context, utilize terra." → Terra track first; keepalive must handle short reviewer sessions. |
| Past the Copilot allowance? | Yes, so marginal dollars are real. |

Still open (owner decision): reorder phases so the trigger does not wait for marker work (§3, last row).
