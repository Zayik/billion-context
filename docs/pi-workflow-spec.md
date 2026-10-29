# pi + billion-context + Pocock skills: one main loop

Status: decided 2026-10-29, implementation on branch `2026-10-29_pi-fold-subagents` (this repo and the `Zayik/skills` fork).

## Goal

One agentic coding environment built from three parts that work together:

- **pi**: the harness. Stays minimal.
- **billion-context (bili)**: context management for pi. Compression (`compress` / `decompress` / `search_context` / `acp_status`) keeps the main context lean and recoverable. Delegation (`acp_delegate`, `pi-subagents/`) is kept only where a subagent condition holds.
- **Matt Pocock's skills** (fork `D:\GitHub\skills`): the workflow, adapted to pi and to bili.

The governing rule comes from Anthropic's "Building agents: When to fold subagents into your main agent loop": one main loop does the work, procedure lives in skills, capabilities live in tools, both load progressively. A subagent is kept only when one of three conditions holds:

1. measurable degradation from context bloat;
2. parallel tasks needing fresh, discardable contexts;
3. an agent that struggles with tool choice or has conflicting instructions.

Kept subagents are called as tools and hand back a compact result.

## Findings that motivated the change (pre-change code)

All five suspected causes of duplicated delegate work were confirmed:

| Defect | Evidence (pre-change) |
|---|---|
| Double reading by design | Child is a fresh `pi` process told it "does NOT see this conversation"; the only anti-duplication guideline covered the reverse direction; a successful run returned only a file path, so the main agent paid an extra `read` (`pi-subagents/src/delegate-tool.ts` `formatSyncResult` / `formatRunResult`). Each child also reloaded the full fixed surface (AGENTS.md alone is ~60 KB here). |
| Prompt over-delegates | Guidelines said "Prefer async=true and launch several" and routed every task kind (review, explore, plan, advise, change) to a role. |
| No scope boundary | Nothing forbade overlapping work; the wait-timeout text said "go do other work now". |
| Unlimited fan-out | `DEFAULT_DELEGATE_POLICY.maxConcurrent = Infinity`. |
| Nested delegation | `worker` ran unrestricted, its child loaded bili and re-registered `acp_delegate`, and `maxDepth: 2` let it spawn one more level. Read-only roles could not nest (their `--tools` allowlist excludes `acp_delegate`). |

The skills were the larger offender: `/implement-spec` delegated exploration, every ticket and every merge; `/code-review` always used two subagents; `grilling` delegated every fact lookup; and all of them assumed Claude Code's Skill tool, subagent tool, `/clear` and `/compact`.

## Decisions

### Delegate surface (`pi-subagents/`)

| # | Decision |
|---|---|
| D1 | Roles: `reviewer` (fresh, independent review), `researcher` (only large lookups whose raw material is disposable), `worker` (only parallel, disjoint, pre-scoped edits). `planner` and `oracle` are removed: planning and advice need the main agent's context. |
| D2 | `maxDepth` default 2 → 1. A child at or past the limit does not register `acp_delegate` (or wait/cancel) at all, so it cannot nest and does not pay their prompt cost. |
| D3 | `maxConcurrent` default unlimited → 3 (two review axes plus headroom). Extra launches queue as before. |
| D4 | Scope boundary is a soft guard: the brief names the delegate's scope, the tool guideline forbids working on a running delegate's scope, and `/implement-spec` builds only tickets no worker holds. A hard path guard is deferred until the live run shows models drifting past the soft one. |
| D5 | A successful run returns the delegate's final reply inline (capped, ~6k chars), keeping the file path for the full text. |
| D6 | The tool description and guidelines are rewritten around the three conditions: no "launch several", no route-by-kind table, and "brief with findings, not pointers: the child must not re-read what you already read". Description, parameter descriptions and the `ACP_DELEGATE_PROMPT` section are trimmed to roughly half; before/after sizes are recorded below and pinned by a test. |
| D7 | bili's compression tools are untouched (golden-pinned, kernel-owned). Making the delegate tools `deferred` behind pi's `tool_search` is a follow-up. |

### Where each phase runs

| Phase | Context | Delegation |
|---|---|---|
| `/grill-with-docs` | Main loop. | Facts are looked up by the main agent; a `researcher` only for large, disposable lookups, while independent frontier questions are still asked. |
| `/to-spec`, `/to-tickets` | Same session as grilling. | None. Folded decisions are recovered with `search_context` / `decompress` before writing; files are not re-read and the user is not re-asked. |
| `/implement` | One unit of work (a ticket, or small work with no tickets). Continue in the same session by default; `/new` is the user's choice for isolation. | None during the build. |
| `/implement-spec` | Continue in the planning session by default; start fresh from the spec file when that session is unavailable or irrelevant. | One main loop walks the ticket frontier. A `worker` per ticket only when two or more sizable frontier tickets are independent and touch disjoint files; each in its own worktree, briefed with findings. No exploration or merger subagents. |
| `/code-review` | Whatever session calls it. | Two `reviewer` delegates in parallel (Standards, Spec). The main agent checks only `git diff --stat`, never the full diff, and aggregates without re-reviewing. |
| `/handoff` | Unchanged: user-invoked, for portability only. | None. |

### Long runs, compression and handoff

- The original skills never trigger a handoff (`handoff` is `disable-model-invocation: true`; `implement-spec` mentions neither handoff nor `/compact`). None is added.
- `/implement-spec` folds each finished ticket at its boundary (one summary: commit, what changed, mid-build decisions, gotchas). It does not fold mid-ticket unless bili nudges.
- Before each ticket it recovers the ticket's decisions and any still-valid earlier reading from folds with narrow `search_context` queries, re-folds what it decompressed, and reads only what is missing or stale. A file changed since it was folded (per `git diff` / `git log`) is re-read, never decompressed and edited against.
- No token cap triggers anything. Pi's auto-compaction is already cancelled by bili (`src/agent/pi.ts`, #535); manual `/compact` is not used during skill runs.
- With bili, "continue" covers far more than Pocock's ~150k smart zone; `/new` is for isolation, `/handoff` for portability. `ask-matt` is updated to say so.

### Skills fork

- Pi-specific and bili-aware throughout: `/skill:<name>`, "load the `<name>` skill" instead of the Skill tool, `/new` instead of `/clear`, `acp_delegate` by name. bili tool use is unconditional, with one fallback clause: if the tools are missing, bili is not running, so tell the user.
- Scope: the two paths and their direct dependencies: `grill-with-docs`, `grilling`, `domain-modeling` (no change needed), `to-spec`, `to-tickets`, `implement`, `implement-spec`, `tdd`, `code-review`, `handoff`, `ask-matt` (+ `PHASE-BOUNDARIES.md`). The fork's own rules are followed in full: docs pages re-synced, `ask-matt` updated, one changeset, no em-dashes.
- Decision note: `.agents/adr/0003-pi-and-billion-context.md` in the fork.

## Config surface

Per AGENTS.md "Configuration Surface Discipline". The owner of this fork signed off in the design session that produced this spec.

- **Changed defaults, no new fields:** `pi.subagents.maxDepth` (and `delegate.maxDepth` in the deprecated acp.json) 2 → 1; `pi.subagents.maxConcurrent` unlimited → 3. Env overrides `PI_ACP_DELEGATE_MAX_DEPTH` / `PI_ACP_DELEGATE_MAX_CONCURRENT` keep their semantics. Users who want the old behavior set the fields explicitly.
- **Removed role names:** `planner`, `oracle`. A `pi.subagents.agents.planner` entry is now ignored; calling `acp_delegate` with a removed role returns the existing "Unknown agent" error listing the valid roles.
- **Why the existing surface could not express it:** it could (both are existing fields); the change is to the defaults, which are a product decision.
- CONFIGURATION.md (en + zh) and `pi-subagents/README.md` are updated in the same commits.

## Fixed prompt surface: before / after

Measured as characters of the model-facing text (tool `description` + JSON-serialized `parameters` + `promptSnippet` + `promptGuidelines`, and the prompt section text).

| Item | Before | After |
|---|---|---|
| `acp_delegate` (description 2593, parameters 2335, guidelines 1068, snippet 84) | 6080 | _tbd_ |
| `acp_delegate_wait` | 1365 | _tbd_ |
| `acp_delegate_cancel` | 285 | _tbd_ |
| `ACP_DELEGATE_PROMPT` section | 1998 | _tbd_ |
| **delegate surface total** | **9728** | _tbd_ |
| bili compression tools (unchanged, for reference; Anthropic manifest JSON) | ~5440 | ~5440 |
| model-invoked skill descriptions in the fork (11 skills) | 2156 | _tbd_ |

"Before" was measured on the pre-change code with the default policy (`maxConcurrent` unlimited, so the tool description carried no concurrency note).

## Known edges, not fixed here

- A third-party `pi-subagents` package installed at **user** scope stays active beside `acp_delegate` (only a project-scope install stands it down, #415), and bili's lane does not warn.
- `pi-subagents` develops against pi 0.83.0; the target machine runs pi 1.4.0. Structural checks are run against 1.4.0.
- Skills outside the two paths (`research`, `retro`, `triage`, `wayfinder`, `codebase-design`, `improve-codebase-architecture`, `grill-me`, `writing-for-agents`, in-progress and misc) still carry Claude Code wording. `ask-matt` still routes to `research`'s background-agent model.

## Verification

- **Now (no model):** `pi-subagents` and bili unit tests and typecheck; a scan of the adapted skills for Claude Code-only dependencies; the before/after sizes above; pi 1.4.0 loading the skills and bili together without errors; existing scripted fake-model harnesses for structural checks only.
- **Later (live, on pi with quota):** `docs/pi-workflow-live-test-plan.md`. Only the live run can show whether models stop duplicating reads, still delegate when they should, and load the skills at the right time.
