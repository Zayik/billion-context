# Cache probe results, 2026-10-30

Probes P1.1 A, C and D-start from [cost-plan-unified.md](../cost-plan-unified.md), run with `scripts/cache-probes.mjs` against GitHub Copilot (enterprise endpoint). All content was synthetic. Total spend **$0.57** (cap $1). Token counts below are provider-reported [measured].

## Probe A: Copilot GPT-6.1 Terra, Responses API

Setup: a ~1.5K-token developer message followed by 26 user/assistant turns (~800 tokens per user turn), ending in a short user message. Implicit caching only, unless a step says otherwise.

| Step | What changed | Input | Cached | Written |
|---|---|---:|---:|---:|
| A1 | base | 22,628 | 0 | 22,625 |
| A2 | one round appended | 22,650 | **22,625** | 22 |
| A3 | turn 7 edited (more than 20 eligible endings back) | 22,655 | **1,493** | 21,159 |
| A4 | new base, explicit `prompt_cache_breakpoint` on turn 5 | 22,567 | 0 | 22,564 |
| A5 | turn 7 edited, breakpoint still on turn 5 | 22,589 | **5,529** | 17,057 |

What this shows:

- **Lookback confirmed.** An edit more than 20 eligible message endings back drops the cached prefix to the end of the developer block (A3). That is the same signature as the 9,046-token collapse in the recorded session, so its cause moves from hypothesis to confirmed.
- **Copilot accepts and honours explicit breakpoints** in implicit mode. A5 reused the prefix through turn 5 (developer block + 5 turns) even though the edit was beyond the lookback window.
- **Copilot reports `cache_write_tokens`**, so the cache report can use measured writes instead of inferring them.

## Probe C: Copilot Claude Opus 5.5, Messages API

Setup: a ~1K-word system prompt followed by 26 user/assistant turns (~300 words per user turn).

| Step | Markers | What changed | Input | Cached | Written |
|---|---|---|---:|---:|---:|
| C1 | system, turn 5, end | base | 18,339 | 0 | 18,335 |
| C2 | system, turn 5, end | turn 7 edited | 18,357 | **5,177** | 13,176 |
| C3 | system, end | new base | 18,417 | 0 | 18,413 |
| C4 | system, end | turn 7 edited | 18,443 | **2,066** | 16,373 |
| C5 | 5 markers | — | HTTP 400: "A maximum of 4 blocks with cache_control may be provided. Found 5." | | |
| C6 | system and turn 5 at `ttl:"1h"`, end at 5m | new base | 18,340 | 0 | 5,160 (1h) + 13,176 (5m) |

What this shows:

- **Arbitrary marker positions are honoured.** The turn-5 marker preserved the prefix through turn 5 after an edit beyond the 20-block lookback (C2).
- **Collapse without it.** The control fell back to the system prompt (C4).
- **The 4-marker limit is enforced** with an HTTP 400 (C5).
- **`ttl:"1h"` is accepted.** Usage splits writes into 1h and 5m (C6), so TTL tiering (1h frontier, 5m tail) is technically possible on Copilot Opus. **Open:** the price Copilot charges for 1h writes. Its pricing page lists a single cache-write rate ($5/M). The script assumed $8/M (Anthropic's 2×). Check the Copilot usage report before relying on 1h.

## Still open

- **D-finish:** whether the Terra cache outlives 30 minutes.
  - A first re-read at 21.1 min was warm (22,655 of 22,680 cached, $0.0012). That only confirms the documented 30-minute minimum.
  - That read also refreshed the entry, so the 45-minute test restarts from 21:24 UTC. Run D-finish after 22:09 UTC; the script now measures from the last touch and refuses earlier runs.
- **B:** openai-codex. Not implemented; that route is rarely used.
- **C.4:** whether a shorter marker's entry stays alive while only longer prefixes are read. Needs a timed run of about 7 minutes and costs roughly $0.25.

## Plan impact

- P3 (OpenAI markers) is a **go** for Copilot Terra.
- P5 (Anthropic markers) is a **go** for Copilot Opus.
- The route profile for both Copilot routes gets `explicitMarkers: supported`. Copilot Opus additionally gets `ttl1h: accepted, price unverified`.
