# Prefix caching and context folds

## Scope

This note uses public provider documentation, repository source, and synthetic data only. It does not characterize any real session or establish actual prices or bills.

## Provider semantics

Anthropic's [prompt-caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) states that a breakpoint hashes the entire prefix through that block, ordered tools, system, messages. Changing content before a later breakpoint changes its prefix hash. Breakpoints written before the change can preserve a shorter unchanged prefix; they cannot reuse the old suffix after a changed prefix. A new prefix may be written and reused later, subject to eligibility, lookback, expiry and pricing.

OpenAI's [prompt-caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching) likewise requires the rendered prefix to match and explicitly notes that compaction can prevent reuse from the first changed token onward. Breakpoint support, cache minimums, boundaries, retention, routing and prices depend on model and API. A routing key does not make different prefixes equal. A different provider architecture could offer different semantics; neither provider documents generic reuse of a suffix behind a changed prefix here.

Keeping the original content verbatim in the model's prompt would preserve the prefix, but it does not free the context window and is not equivalent to compression.

## Synthetic experiment

`tests/cache-fold-economics.test.ts` exercises the real OpenAI-chat plugin projection and compression tool against a deterministic local fake provider. It warms a prefix, folds selected ranges, and measures the outgoing request before and after the fold. The meter treats each UTF-16 code unit in a synthetic canonical request stream as one token and matches the longest previous prefix. It intentionally ignores actual tokenization, provider-internal rendering, lookup boundaries, TTL, cache minimums and routing. Values below are synthetic units, not provider tokens or bills.

| Scenario | First input after fold | Cached prefix | Cache miss | Next cached prefix |
|---|---:|---:|---:|---:|
| No fold | 174,191 | 174,191 | 0 | 174,191 |
| Early two-message fold | 168,438 | 19,677 | 148,761 | 168,438 |
| Later two-message fold | 167,142 | 133,243 | 33,899 | 167,142 |
| Three ranges in one early-anchored batch | 152,756 | 19,677 | 133,079 | 152,756 |

The early and later source ranges have different sizes, so this is not a controlled comparison of equal-sized folds. The batch shares the earliest changed prefix, but it is not proof that arbitrary ranges should be folded together. The test checks untouched-message order and bytes, summary presence, and retrieval of originals; it cannot judge semantic summary quality. Existing `tests/cache-friendly-plugin.test.ts` and `tests/cache-friendly-proxy.test.ts` cover both carriers on four wire shapes, but do not model provider billing.

## Design implications

- Select only live eligible ranges and retain the shared application/projection checks in `kernel/src/unit-projection.ts`; a later range must still be consumed and safe to summarize. Cache position is a tie-breaker, not permission to fold protected or needed content.
- When multiple ranges are already safe and needed, one batch can share the one-time prefix rewrite. The existing kernel `ONE_CALL_HINT` already asks agents to batch; plugin agents own their own selection, while proxy mode uses a server-side carrier and decision path. Neither a hint nor the synthetic result proves all hosts comply.
- A cost decision needs projected view/headroom including output reserve, candidate benefit and summary cost, expected continued reuse, and batch-level estimated cache replay, compared with a safe no-fold option. Treat cache-report re-pay as a structural allocation of observed misses, not independently measured causal re-pay. Do not rely on paid-back counts as ground truth when folds overlap, are later retrieved or regrow.
- Urgent pressure and availability override optional cost savings. Preserve the existing emergency and protected-content behavior. No single session establishes a safe general horizon, headroom threshold, summary-quality policy, or provider pricing; changing default selection or nudge policy is a product decision, not a consequence of this experiment.

## Related work and candidates

The existing plugin nudge already asks the agent to batch independent ranges into one compress call ([#2302](https://github.com/ranxianglei/billion-context/issues/2302)); this is a hint, not a guarantee of how many calls an agent makes. Preflight's [#2678](https://github.com/ranxianglei/billion-context/issues/2678) is different: it groups viable ranges and runs separate summaries concurrently, rather than producing one combined model response. The repository deliberately pins the ordinary growth cadence at a flat 50K; [#1997](https://github.com/ranxianglei/billion-context/issues/1997) and [PR #2035](https://github.com/ranxianglei/billion-context/pull/2035) explore optional throughput-based pacing, not a new unconditional cache or window-percentage gate.

A cost-aware experiment should compare later eligible ranges, multi-range batches and deferral only where projected headroom remains safe. Compute a batch's shared earliest divergence once, account for model-specific pricing tiers, and present uncertainty: a cache miss attributed structurally to a fold is not a measured no-fold counterfactual. User-chosen folds and emergency/availability behavior cannot be silently vetoed. Any change to policy or the kernel requires the repository's owner approval and boundary rules.

[CCR v2 (#1179)](https://github.com/ranxianglei/billion-context/issues/1179) provides selective, original-content retrieval where the CCR and host/wire gates permit it; its one-shot range injection differs from an ordinary whole-block tool result. Whole-block `decompress` returns content without unfolding the historical prefix, and large results are normally written to a file. A later fold of an appended restore can still rewrite the prefix. Retrieval is not a guarantee that every original remains in model context or survives every storage and native-compaction boundary.

[Issue #4831](https://github.com/ranxianglei/billion-context/issues/4831) proposes preparing and validating a fold in the background; [#2670](https://github.com/ranxianglei/billion-context/issues/2670) covers idle convergence. These can reduce latency or coordinate work, but preparing a fold does not by itself avoid the cache write when it is applied. [Issue #4857](https://github.com/ranxianglei/billion-context/issues/4857) tracks a more ambitious native-recall approach. Compare these against native compaction plus retrieval in a controlled benchmark before claiming a cost win.
