# Live test plan: pi + billion-context + Pocock skills

Companion to [pi-workflow-spec.md](pi-workflow-spec.md). Everything here needs a real model and real quota. The structural checks that run without a model are listed in the spec's Verification section and were run on 2026-10-29.

## What only a live run can answer

1. Do models stop duplicating reads: does a delegate re-read files the main agent already read, and does the main agent re-read files it already read and that billion-context folded?
2. Do models still delegate when a condition holds (independent review, large disposable lookup, parallel disjoint edits), and only then?
3. Do the skills trigger and load at the right time, and do they recover folded decisions instead of re-asking or re-reading?
4. Does a long `/implement-spec` run degrade, and if so, at what live-context size?

## Setup (once)

1. Install: `npm run build` in billion-context, then `bili plugin install pi` (adds the package entry to `~/.pi/agent/settings.json`). Run pi through `bili pi` so the proxy is up.
2. Skills: run `scripts/link-skills.sh` in the skills fork, on branch `2026-10-29_pi-fold-subagents`, so pi finds them in `~/.agents/skills`. On Windows, check the links are real symlinks (`ls -l ~/.agents/skills`), not copies.
3. Confirm with `/skill:ask-matt` that the skills load, and with `acp_status` that billion-context is attached.
4. Use one fixed model for the whole plan, and record its id. Note pi's version (`pi --version`).
5. Target repo: a scratch clone of a small TypeScript project with tests and an `AGENTS.md`. Run `/skill:setup-matt-pocock-skills` once with a **local markdown** tracker, so nothing needs GitHub.

## What to record per run

| Signal | Where to read it |
|---|---|
| Files read by main and by each delegate | pi session JSONL (main) and `$TMPDIR/acp-delegate/<runId>.session.jsonl` (each delegate): every `read` call's `path`, plus `bash` commands that `cat`/`grep` files |
| Duplicate reads | Same path read by main and a delegate in the same task, or by main twice with no edit between |
| Delegations | Every `acp_delegate` call: role, brief length, whether the brief carries findings (`file:line`) or only pointers |
| Folds and recoveries | `compress`, `search_context`, `decompress` calls in the main session |
| Phase context | Which session (id) each phase ran in, and whether `/new` was used |
| Tokens and turns | `bili` panel or `/__bili/status`: input/output/cache tokens per session, plus delegate usage (separate block); turn count from the session JSONL |
| Live context | `acp_status` at each ticket boundary on the long runs |

Run each task **twice**, in a fresh scratch clone each time. Two runs show whether a behavior is stable or luck.

## Tasks, most informative first

Stop when quota runs out; the order puts the cheapest high-signal tasks first.

### T1. Code review, independent and without double reading (cheap)

Prepare a branch with a ~150-line diff against `main` plus a 10-line spec file. In a fresh session: `/skill:code-review main`, pointing at the spec.

Check:
- Two `acp_delegate` calls with agent `reviewer`, in the same turn.
- The main agent ran `git diff --stat` only, never the full diff and never `read` on the changed files.
- Both replies arrived inline. The main agent made no `read` of `acp-delegate/*.out`.
- The report keeps `## Standards` and `## Spec` separate.

Expected: 2 delegations, 0 duplicate reads by main.

### T2. Grilling looks facts up itself (cheap)

`/skill:grill-with-docs` on a small feature idea that needs two facts from the code (for example, "where is X validated?"). Answer two or three rounds, then stop.

Check:
- The facts were looked up with the main agent's own `read`/`grep`, with no `researcher` delegation.
- Rounds keep the frontier format with recommendations.

Expected: 0 delegations.

### T3. Researcher only for a disposable lookup (cheap)

In the same kind of grilling session, ask a question whose answer sits in a large dependency or doc the project does not need afterwards (for example, "what does library Y's config option Z default to?" with Y vendored in `node_modules`).

Check:
- The main agent either looks it up directly (acceptable for a small lookup) or launches one `researcher`, and keeps asking the rest of the frontier.
- If a researcher ran, the main agent did not read the same dependency files afterwards.

This is a "should still delegate" probe. A model that never delegates here is fine for a small lookup; note the size of the lookup.

### T4. Spec path, short: grill → to-spec → implement-spec → review (medium)

A feature that splits into three tickets: two independent tickets on disjoint files, and one ticket blocked by both. All in **one session**: `/skill:grill-with-docs`, `/skill:to-spec`, `/skill:to-tickets`, `/skill:implement-spec`.

Check:
- `/to-spec` and `/to-tickets` ran `search_context` (or had nothing folded yet; record which) and did not re-ask settled questions.
- `/implement-spec` ran in the same session (same session id) and did not re-read the spec or tickets from disk.
- Files read during grilling or `/to-tickets` were not read again by `/implement-spec`, unless they changed in between.
- For the two disjoint tickets: either both built sequentially in main, or **one** `worker` with a worktree `cwd` and a brief containing `file:line` findings. The worker read only the files it edited. The main agent did not touch the worker's files while it ran.
- Each finished ticket shows one `compress` naming its commit.
- `/code-review` at the end used two reviewers (T1's checks).

Expected: at most 1 worker plus 2 reviewers; 0 files read by both the main agent and the worker.

### T5. Ticket path: implement per ticket (medium)

Same feature shape as T4, but after `/to-tickets` run `/skill:implement` per ticket, **continuing in the same session**. On the second run of this task, use `/new` between tickets instead, to compare.

Check:
- Continuing: the second ticket recovers earlier reading with `search_context` instead of re-reading; any re-read is of a file that changed.
- With `/new`: the expected re-reads happen once per ticket. Record the token difference against the continuing run.
- `/implement` never delegates the build; its closing `/code-review` uses two reviewers.

### T6. Recover a folded decision, not re-ask it (medium)

A long grilling session (15+ rounds, enough for at least one billion-context fold; confirm with `acp_status`). Make one early decision distinctive ("the cache key is the tenant id, not the user id"). Then `/skill:to-spec`.

Check:
- The spec states the early decision with its original wording and reason.
- The agent ran `search_context` or `decompress` for it, and did not ask the user again.

### T7. Long `/implement-spec` run (expensive, run last, once if quota is short)

A spec with 6 to 8 tickets, mostly sequential, in the planning session.

Check, at each ticket boundary:
- Live context from `acp_status`, total session tokens, and whether the agent shows any degradation signal: re-asking settled decisions, repeating a failed fix, losing conventions, confusing which tickets are done.
- Whether degradation, if any, correlates with live context size. This sets whether the skills ever need a handoff rule (the spec deliberately has none).

### T8. Old-behavior regression probe (cheap, optional)

Ask directly: "review this repository's auth module for bugs" with no skill. The model should do it in the main loop or use one `reviewer`, not fan out several delegates, and never use `planner`/`oracle` (they no longer exist).

## Pass criteria

| Question | Pass |
|---|---|
| Duplicate reads | No file read by both main and a delegate in T1, T4, T5 (barring changed files); no re-read of unchanged folded files in T4/T5-continue |
| Delegates still used when they should be | T1 and T4's review always use two reviewers; T4 uses a worker only for the disjoint pair, or none |
| Right phase, right context | T4 is one session id from grilling to review; T5-continue is one session id |
| Skills trigger | Every `/skill:` run loads the named skill, and nested loads (`tdd`, `code-review`, `grilling`, `domain-modeling`) appear as `read` of their `SKILL.md` |
| Folds recovered | T6's early decision appears verbatim in the spec without a re-ask |

Record results in a table per task and run (tokens, turns, delegations, duplicate reads, pass or fail per check), and add them to the spec's Verification section.
