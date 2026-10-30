# Billion-context

Context management for long-lived agent sessions: replacing consumed conversation with summaries while keeping the provider's prompt cache as warm, and the session as cheap, as possible.

## Folding

**Fold**:
Replacing a range of past conversation with a summary in what the model sees, while the originals stay recoverable.
_Avoid_: Compression (for the act on one range), compaction

**Compaction**:
A host's own whole-history summarization that keeps only a summary and a recent tail; the originals are no longer reachable by the model.
_Avoid_: Fold

**Batch**:
The set of ranges folded together in one prefix change, so they share a single cache rewrite.
_Avoid_: Fold group

**Fold frontier**:
The earliest position in the conversation that the next fold could change; everything before it stays identical.
_Avoid_: Fold point, fold start

**Nudge**:
A prompt asking the agent to fold; it is advice to the agent, not the fold itself.

**Idle fold**:
A fold applied while the user is away and the prompt cache has expired, written by a cheaper model so the next request starts from the smaller context.

**Uncovered run**:
A stretch of older conversation outside every fold and outside the current fold suggestions, sent to the model raw on every request.
_Avoid_: Leftover run, dust

**Keepalive**:
A cheap replay of the last request during a pause, sent before the prompt cache expires so it stays warm.
_Avoid_: Cache warming (Pi's separate feature)

**Payback horizon**:
The number of later requests a batch needs before its savings outweigh its cache rewrite and summary cost.
_Avoid_: Breakeven turns

## Prompt cache

**Cache marker**:
An explicit position where the provider stores a reusable prefix of the request (Anthropic `cache_control`, OpenAI `prompt_cache_breakpoint`).
_Avoid_: Cache breakpoint (except when quoting a provider), cache mark

**Cache collapse**:
A request after a fold whose cached prefix falls back to the system prompt because no stored prefix exists between the system prompt and the fold frontier.

## Routes

**Route**:
One provider-and-wire path a model is reached through (for example Opus through GitHub Copilot, or Opus through Anthropic directly).
_Avoid_: Lane (except for host integrations), vendor

**Route profile**:
What a route charges and how its prompt cache behaves: prices and price tiers, cache lifetime, cache-marker support and how usage is billed.
