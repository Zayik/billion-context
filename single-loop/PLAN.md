# Single loop plan

Audit date: 2026-10-28
Repo and commit: ranxianglei/billion-context @ b08fbf36 (master)

Scope note: billion-context is a context-compression proxy, not a router system. Most
agents in its traffic belong to the hosts it sits in front of (dsh, opencode, Claude Code,
pi). This plan only covers what the repo owns: the `acp_delegate` roles shipped in
`pi-subagents/` (pi lane) and the external summarizer behind `compress`. No production
traces were found locally (no `%TEMP%/acp-delegate`, no `~/.local/state/billion-context`).
Every traffic number is inferred.

## Status

- [x] Verdicts agreed with the person (end of step 0) — 2026-10-28. Worker fold confirmed: the
  person sees parallel implementation as rare with Anthropic models, used only when work is
  fully separate. The researcher+planner+oracle merge is agreed. The person asked us to check
  that delegates don't repeat the main agent's work (see Prompt notes, "Repeated work").
- [x] Main eval agreed and baseline measured (end of step 1) — 2026-10-28: the person agreed the 11 no-model tasks, t07 expected outcome "no write" (fails today), and said go ahead with the merge.

A new session picks up at the first unticked box here, then at the first unticked item in
the worklist.

## Verdicts

| Agent | Verdict | Why, in one sentence | Evidence | Confidence |
| --- | --- | --- | --- | --- |
| pi-host-main | main | The pi host agent picks a role by name from the `acp_delegate` description. The repo owns only that injected surface, not the host prompt. | `pi-subagents/src/delegate-tool.ts:724-760` | medium |
| reviewer | as-tool | An independent check that doesn't see how the work was produced (criterion 2), launched in parallel by default. | promptGuidelines "never use worker to review"; `delegate-tool.ts:731` async default | medium |
| researcher | merge:planner,oracle | Same tools and same `restricted` flag as planner and oracle. The prompts differ only in output form. | `delegate-tool.ts:141,163-190` | medium |
| planner | merge:researcher,oracle | Same as above. | `delegate-tool.ts:175-181` | medium |
| oracle | merge:researcher,planner | Same as above. | `delegate-tool.ts:182-187` | medium |
| worker | fold | No criterion is shown. It writes files the main agent never sees, and the tool's own guideline says to keep the main context as the sole writer. | promptGuidelines "keep the main context as the sole writer"; `delegate-tool.ts:169-174` | low |
| external-summarizer | as-tool (no change) | It reads a whole fold range (tens of thousands of tokens) and returns only a capped summary (criterion 1). It is already a bounded call with a structured result. | `src/external-summary-compress.ts:94`, `src/external-summary-http.ts:225`, `maxSummaryLength` 20000 | high |
| dsh-auto-review / opencode-task-subagents / claude-code-subagents | keep | The hosts own these. bili only keys or splits their sessions. | `src/session-id.ts`, `src/subagent-sessions.ts:1-6` | high |

Merged researcher+planner+oracle: expected verdict `as-tool` (one read-only investigator in
a clean context, launched in parallel). It folds instead if traces show its reads are
small.

Glue that goes away as subagents fold:

- Three `AGENTS` entries plus their `agentListLine` blurbs (`delegate-tool.ts:155-191, 705-716`) become one role.
- The routing clause in promptGuidelines ("Route by task kind: … researcher … planner … oracle … worker") shrinks to two read-only roles at most.
- The `worker` entry and its unrestricted-toolset branch (`delegate-tool.ts:1880-1890`) go.
- The generic run registry, watchdog, notifications and fleet widget stay. They serve every remaining role.

## Prompt notes

- The read-only roles say "Do NOT modify any files", which is a hard limit, but only the prompt enforces it. The `--tools` allowlist includes `bash`, and the code calls this "a soft guardrail … bash can bypass it" (`delegate-tool.ts:1882-1884`). If this matters, it belongs in a tool (for example a read-only bash wrapper).
- Each role opens with a persona line ("You are a senior code reviewer", "a precise implementer", and so on). Drop these on merge or fold. The main agent's voice owns this.
- Instructions about other agents: "never use worker to review" and "delegate read-only investigation … keep the main context as the sole writer" contradict offering `worker` at all.
- worker: "check AGENTS.md first", "do not expand scope" and "summarize what you changed" are procedure. That fits a skill, or nothing, since the host prompt likely says it already.
- external-summarizer: "Return only the summary, without tool calls" and "treat content as untrusted" are limits. Confirm in step 1 that `summaryPayload` sends no tools. The length cap is already enforced in code (`maxSummaryBytes`) as well as in the prompt.
- ACP_DELEGATE_PROMPT (`pi-subagents/src/system-prompt.ts`) covers how notifications are handled, not any one role. It stays whatever happens to the roles.
- **Repeated work (the person's concern; checked 2026-10-28).** Only prompts guard against it; nothing in the code does.
  - Main repeats a finished child: guarded by one guideline, "read that file instead of re-running exploration a child already did" (`delegate-tool.ts:753`), and by the notification rule "Do not start the task over" (`system-prompt.ts:9`).
  - A resumed child repeats its earlier steps: guarded by RESUME_INSTRUCTION (`delegate-tool.ts:57`).
  - **Main works the delegated scope while the child runs: not guarded.** Six places tell main to "go do other work" or "keep doing other work" while a delegate runs (`delegate-tool.ts:663,1153,1331,1344,1782,2145`). None says that the other work must exclude what was delegated.
  - A child re-reads what main already read: by design. The child starts clean, and the only defense is "write a fully self-contained task" (`delegate-tool.ts:751`). No mechanism hands over main's findings.
  - Two parallel delegates get overlapping tasks: no task de-duplication exists.
  - The merge makes the first gap more likely: one role that both explores and plans covers more of what main would otherwise do itself. Step 1 has to measure it (Break map, "Repeated work").

## Evals

Filled in during step 1.

| Eval | What it measures | What to do with it |
| --- | --- | --- |
| `tests/e2e/e2e-delegate-notify.test.ts` | Real `pi --mode rpc` driven against a **scripted fake upstream** (`fake/fake-model`). It checks that the delegate dispatches and that the completion notification arrives on time (#2320). | Not a quality metric: the model is scripted. Reuse its spawn and pi-driving code as the eval runner's skeleton, pointed at a real model. |
| `tests/e2e/e2e-native-pi.test.ts` | pi + bili native lane against a fake upstream (gated `ACP_TEST_E2E_NATIVE=1`). | Same: plumbing only. Reuse it for the bili-in-pi setup. |
| `pi-subagents/tests/*`, `tests/pi-subagents-wiring.test.ts` | Unit plumbing: spawn args, tool lists, rendering, notifications. | Keep it as the no-model check for each change. |
| `tests/external-summary-live.test.ts` | Live summarizer keeps the critical facts (`ACP_TEST_SUMMARY_LIVE=1`). | Out of scope (summarizer is left as is). |

Status 2026-10-28: no end-to-end, model-graded eval exists. **Built in this step.**
Traffic: `~/.pi/agent/sessions` holds 0 session files and `%TEMP%/acp-delegate` doesn't
exist, so no local traces are available.
Local tooling: pi 1.4.0 is at `~/.pi/agent/bin/pi`. On Windows that file is a shell/.cmd
shim, so the runner calls the real cli.js with `node`. `npm ci` and `npm run build` were run
2026-10-28 (build-info `b08fbf36-dirty`, dirty only from untracked `single-loop/`).

**Decision 2026-10-28 (the person): no live model subscription; continue without one.**
So the eval built here is a **no-model structural eval**:

- **Runner:** `single-loop/eval/run.ts`, with tasks in `single-loop/eval/tasks.ts`.
  `node --import tsx single-loop/eval/run.ts --variant <name> [--reps 2] [--only ids] [--repo <checkout>] [--roles '<json>']`.
- **Entry point:** the real pi CLI 1.4.0 (`~/.pi/agent/install/releases/1.4.0/.../dist/bundle/cli.js`) in `--mode rpc`, with bili loaded from `--repo` (`settings.json packages`). The model is the repo's scripted fake upstream (`tests/e2e/fake-upstream-chat.mjs`, `fake/fake-model`, zero tokens). Prompts, tool lists, child spawn, bili interception, handoffs and file writes are real; the model's choices are scripted.
- **Why it's safe:** every task runs in a fresh temp dir with its own pi agent dir (`PI_CODING_AGENT_DIR`), XDG dirs, TEMP/TMP (delegate result files land there) and a sandbox cwd holding two fixture files. The real `~/.pi` and bili state are never touched, and no network is used. It's safe by construction; nobody else had to sign off.
- **Results:** `.claude/hillclimb/delegate-structural/<variant>/results.jsonl` plus per-task traces (full request bodies). These are git-ignored by the repo's `.claude/` rule.
- **Variant roles:** which role the main agent picks is model judgment the script can't exercise, so each variant passes a role map (intent → role name, or `self` for the edit intent once `worker` is folded).

**What it measures:** the delegate contract, graded on outcomes:
- **handoff in:** the child's request carries the task token
- **handoff out:** the result file the main agent is pointed to holds the child's final reply (sync tool result or async notification)
- **writes:** files changed in the sandbox must equal the expected list
- **error paths:** error text in the tool result, and no child spawned
- **cost:** input tokens per request, measured from the full request bodies at chars/4, with model calls and `by_agent`

**What it cannot measure:** anything that depends on the model's judgment: wrong pick, shortcut, repeated work, lost thread, and how good a review or plan is. These stay **unmeasured** until a live model is available. Every result from this eval rests on that limit.

Main metric: `complete` (all checks of a task pass) over the 11 tasks in `single-loop/eval/tasks.ts`. **Pending the person's sign-off on the task list.**

Gaps noticed:
- Without production traces, the chains are inferred from the code. The only multi-agent chains are main→one role (sync and async) and main→two parallel roles (t11).
- t07 (a read-only role writes through `bash`) is expected to fail today. The tool allowlist is a soft guardrail. Whether "no write" is the right expected outcome is the person's call.

Chains with no task (from `chain_coverage.py`): not run, because there's no trace export. Inferred chains: main+reviewer (t01, t06, t07, t10), main+researcher (t02), main+planner (t03), main+oracle (t04), main+worker (t05), main+reviewer+researcher (t11). None is left uncovered.

Break map: which tasks would notice each kind of break. "none" is a gap to raise.

| What could break | Tasks that would notice | Gap, and the task to add |
| --- | --- | --- |
| Dropped handoff | t01–t05 (sync), t10–t11 (async): handoff_in + handoff_out | none |
| Lost rule | t06 (write tool blocked for read-only role), t07 (bash write; known gap) | the role prompts' "Do NOT modify files" only bites through the model: unmeasured |
| Shortcut | none | needs a live model |
| Wrong pick | none: the role is supplied by the variant's role map | needs a live model |
| Unwanted write | every task (exact expected writes list); t05 is the only one that should write | none |
| Lost thread | none | not applicable: delegates are single-brief, no multi-turn role |
| Unhappy path | t08 (unknown role), t09 (empty task) | none |
| Repeated work (main reads or greps the same files a running or finished delegate covered) | none | needs a live model (the script never repeats work unless told to) |
| Cost creep | no task: watch `main_first_call_tokens`, `in_tokens` and `by_agent` | none |

Baseline (variant `baseline`): tasks complete, latency per task, tokens per task, model
calls per task, and how far the score moved between reps.

**Measured 2026-10-28.** Commit b08fbf36 (src and pi-subagents/src clean), pi 1.4.0, model
`fake/fake-model` (scripted). 11 tasks × 2 reps. Run metadata is in
`.claude/hillclimb/delegate-structural/baseline/run-meta-*.json`.

- **Complete: 20/22** (9/11 tasks). Both failures are t07, a known gap: the read-only reviewer wrote `leak2.txt` through `bash`.
- **Noise band:** zero. Score, tokens and model calls match exactly between reps, and latency differs by at most 0.1 s.
- **Per task (median):** latency 2.9 s (pi startup dominates), 4.4 model calls, 34.3K input tokens.

| Task | complete | in_tokens | calls | by_agent (calls / input tokens) |
| --- | --- | --- | --- | --- |
| t01-review | 2/2 | 29,660 | 4 | main 2/16.6K, reviewer 2/13.0K |
| t02-research | 2/2 | 29,642 | 4 | main 2/16.6K, researcher 2/13.0K |
| t03-plan | 2/2 | 29,644 | 4 | main 2/16.6K, planner 2/13.0K |
| t04-ask | 2/2 | 29,574 | 4 | main 2/16.6K, oracle 2/13.0K |
| t05-edit | 2/2 | 34,666 | 4 | main 2/16.6K, worker 2/18.0K (full toolset) |
| t06-ro-write-tool | 2/2 | 29,696 | 4 | main 2/16.7K, reviewer 2/13.0K |
| t07-ro-bash-write | 0/2 | 29,676 | 4 | main 2/16.6K, reviewer 2/13.0K |
| t08-unknown-role | 2/2 | 16,523 | 2 | main 2/16.5K |
| t09-empty-task | 2/2 | 16,494 | 2 | main 2/16.5K |
| t10-async | 2/2 | 49,010 | 6 | main 4/36.0K, reviewer 2/13.0K |
| t11-parallel | 2/2 | 82,808 | 10 | main 6/56.7K, reviewer 2/13.1K, researcher 2/13.0K |

- **Fixed cost on main** (first call, t01): 7,524 tokens per call. The delegate surface is about 2,420 of that (~32%), paid on every main call:
  - `acp_delegate` tool 1,259
  - `acp_delegate_wait` 312
  - `acp_delegate_cancel` 84
  - notification prompt section 515
  - promptGuidelines, including the five-role routing line, ~250
- **Token estimate vs. actual:** n/a. The run is scripted and zero-cost; the token figures measure prompt size, not spend.
- **Eval bugs fixed during the baseline:**
  1. Sync results carry only the result-file path, with no inline preview, so handoff_out reads that file.
  2. Two async finishes merge into one notification (#157), so handoff_out counts result files rather than messages. The t11 rows were rerun after this fix (second run-meta); the first t11 rows came from the buggy check and were dropped.
- **Harness note:** on Windows, temp dirs stay locked for a few seconds after pi exits. The runner retries their removal at the end of the run.
- **Failing task:** t07 is the app, not the eval. `--tools` keeps `bash`, and the code calls the allowlist "a soft guardrail" (`delegate-tool.ts:1882-1884`). The expected outcome ("no write") is the person's call.

## Worklist

Merges first, then folds, then as-tool changes. With no traffic data, the order runs from
lowest risk up.

- [x] 1. merge `researcher` + `planner` + `oracle` into one read-only role · variant: v1 · compared with: baseline · result: holds (10/11 both sides); kept
- [x] 2. fold `worker` (remove the role; the main agent edits itself) · variant: v2 · compared with: v1 · result: holds (10/11 both sides); kept
- [ ] 3. `reviewer` as-tool: structured result in place of the file path + 500-char preview (`delegate-tool.ts:37,2295`) · variant: · compared with: · result:
  - **Blocked before building (2026-10-28), waiting on the person:**
    - (a) **Conflicts with a deliberate design.** The minimal payload is on purpose: `formatPayload` puts "NO preview: the model uses `read` for details … Keeping this minimal means it stays cheap to retain in context" (`delegate-tool.ts`, above `formatPayload`; #2546 made notifications persisted session messages). An inline structured result grows every later main call.
    - (b) **The eval can't see the change.** The scripted child always replies `收到#done`, so a schema check in code would only ever exercise the malformed path, never the happy one.
    - Proposed shape: the child writes its result in the `SubagentResponse` shape into the result file; code validates it and flags a malformed one in the tool result; the inline payload stays path-only. Plus an additive "scripted final reply" directive in `tests/e2e/fake-upstream-chat.mjs`, so tasks can grade both paths.
- [ ] 4. merged investigator as-tool: structured result · variant: · compared with: · result:

Repo rules that bind every item: any `pi-subagents/src/**` change bumps
`pi-subagents/package.json` version (CI `pi-subagents-guard`), and needs an issue plus a PR,
never a push to master.

## Changes

### Item 1: merge `researcher` + `planner` + `oracle` (variant `v1`, branch `2026-10-28_merge-readonly-delegate-roles`, commit c2d3d234)

Comparison with `baseline` (`compare.py ... baseline v1 --exclude main --exclude planner --exclude oracle`):

| | baseline | v1 | change |
| --- | ---: | ---: | ---: |
| tasks complete | 10/11 | 10/11 | 0 |
| latency per task (s) | 2.8 | 4.1 | +45% (see below) |
| model calls per task | 4.4 | 4.4 | 0 |
| input tokens per task | 34,308 | 34,199 | -0.3% |

Tokens used next to the estimate: zero for both (scripted model). The figures measure prompt size, not spend.

- **Tasks that changed score:** none. t07 fails on both sides (known gap: bash write by a read-only role).
- **Tasks that changed route but not score:** t03-plan and t04-ask now run `researcher`, as intended. The researcher child costs ~6,560 input tokens per call, against ~6,520 for planner and ~6,490 for oracle: +45 tokens from the longer merged prompt. No task the change shouldn't touch moved route.
- **Latency +45%:** concentrated in t06, t07 and t08 (one t08 rep took 13.9 s). These are reviewer and unknown-role tasks the merge doesn't touch, and their tokens and model calls are identical to the baseline. The changed tasks t02–t04 kept 2.9–3.3 s. Inferred cause: slower pi process startup on this machine during the v1 run (the same cause as the t05 harness error below).
- **Reruns (latency, 2026-10-28):**
  - Variants `baseline-rerun-v1` (commit b08fbf36, in a `git worktree` at `../bc-baseline-b08fbf36`, since removed) and `v1-rerun` (commit 779392c1, whose code is identical to c2d3d234).
  - Tasks t01, t06, t07, t08, t09 × 4 reps, interleaved old/new per task and rep so machine slowness hits both sides.
  - Rerun pair: latency 2.7 s → 2.7 s (−2%). Completion 4/5 on both (t07), tokens and calls unchanged.
  - Over all reps (6 per side), the per-task median latency in seconds:

    | Task | old | new |
    | --- | ---: | ---: |
    | t01 | 3.0 | 3.0 |
    | t06 | 3.0 | 3.3 |
    | t07 | 2.9 | 3.3 |
    | t08 | 2.1 | 2.2 |
    | t09 | 2.1 | 2.5 |

    Every outlier (13.9, 6.8, 5.3, 5.0 s) is from the first v1 run.
  - Conclusion: the +45% was machine noise, not the merge. This rests on 6 reps per task per side.
- **Edited in the main agent's prompt and tool list:**
  - `acp_delegate` description: the role list is 3 lines, not 5, and the researcher blurb now reads "read-only investigation: explore code, propose a step-by-step plan, or answer a question".
  - promptGuidelines: "(reviewer/researcher/oracle)" became "(reviewer/researcher)", and the routing line became "explore code, plan multi-step work, or ask questions → researcher".
  - Effect: main's first call went from 7,524 to 7,470 tokens (-54 per call).
  - Also edited: the child prompt for `researcher` (persona dropped, covers findings / plan / answer), config doc comments (`pi-subagents/src/config.ts`, `src/config.ts`) and the pi-subagents README en/zh. Version bump 0.2.2 → 0.2.3 (package.json + root package-lock).
- **Checked with no model:**
  - `npm --prefix pi-subagents test` 262/262, including a new two-direction roster test: it passes now and fails on the old code.
  - `npm run typecheck` clean.
  - `tests/pi-subagents-wiring` 18/18 and `pi-subagent-channel` 15/15.
  - `pi-subagent-registry` 9/10: the one failure is a Windows symlink EPERM that fails identically without this change.
  - The rebuilt `dist/agent/pi-native.js` contains the new roster.
- **Harness error refilled:** t05-edit rep 2 first ran with no model call at all, because pi was slow to start and the quiet-period check counted the idle startup as finished. Eval bug fixed in `run.ts`: quiescence now only counts after streaming starts, and a run that never starts is a harness error. That rep was refilled in v1 (`--first-rep 2`). Every baseline row had started streaming (each made ≥2 model calls), so the fix doesn't change any baseline row.
- **Skipped or not measured:** wrong pick, shortcut and repeated work (no live model). Whether a real model routes "plan" and "question" asks to `researcher` as well as it routed them to planner and oracle is untested.
- **Old code:** the removed role entries live only in git; revert is `git revert c2d3d234`.
- **Compat:** `delegate.agents.planner` / `delegate.agents.oracle` config now silently stops applying, and calls naming those roles get "Unknown agent". This is open owner question 1, unresolved; no aliases were added.
- **Decision (who, when):** keep: the person, 2026-10-28 ("follow the two recommendations": keep and go on to item 2, after a free latency rerun on both sides).
- **Left open after the decision:** issue + PR not opened yet (AGENTS.md requires both). Owner question 1.

### Item 2: fold `worker` (variant `v2`, branch `2026-10-28_fold-worker-delegate-role`, commit b5de41f1, stacked on item 1)

Comparison with `v1` (`compare.py ... v1 v2 --exclude main --exclude worker`):

| | v1 | v2 | change |
| --- | ---: | ---: | ---: |
| tasks complete | 10/11 | 10/11 | 0 |
| latency per task (s) | 4.1 | 2.8 | −32% (v1's first run was the noisy one; baseline was 2.8) |
| model calls per task | 4.4 | 4.2 | −4% |
| input tokens per task | 34,199 | 32,458 | −5% |

Tokens used next to the estimate: zero (scripted model).

- **Prompt sort (step 3):** "You are a precise implementer" is persona, so it's deleted. "Minimal, focused, check AGENTS.md first" and "summarize what you changed, don't expand scope" are things pi's main agent already does: pi loads AGENTS.md itself (#815), and its own prompt owns scope. **No skill and no new tools**, since main already has read/edit/write/bash. So there is no with/without-skill run.
- **Tasks that changed score:** none. t07 fails on both sides (known gap).
- **Tasks that changed route:** only t05-edit, as intended. It went from main+worker (4 calls, 34,448 tokens) to main alone (2 calls, 16,289 tokens), and its write landed in the sandbox exactly as expected. No other route moved.
- **Edited in the main agent's prompt and tool list:**
  - `acp_delegate` description: the worker line is gone, and "focused review/investigation/implementation" became "focused review/investigation".
  - promptGuidelines: the sole-writer line became "Delegates are read-only: make code changes yourself and delegate only investigation (reviewer/researcher); the main context is the sole writer." The routing line lost "(never use worker to review)" and "making changes → worker".
  - Effect: main's first call went from 7,470 to 7,432 tokens (−38 per call; −92 against the baseline).
- **Also edited:** config doc comments (both `config.ts` files), pi-subagents README en/zh (worker row removed, plus "There is no writing role: the main agent makes code changes itself"), and `tests/e2e/e2e-delegate-notify.test.ts`, whose generic probe dispatch moved from `worker` to `researcher` (gated e2e; not run, since its `spawn("pi")` can't start pi's shell shim on Windows). Unit tests that dispatch through `execute()` moved to `reviewer` (widget-refresh, fleet-inspector). Version 0.2.3 → 0.2.4 (package.json + root lockfile).
- **Checked with no model:**
  - `npm --prefix pi-subagents test` 262/262. The roster test now also rejects `worker`, and it fails on the old code.
  - Typecheck clean; `pi-subagents-wiring` 18/18, `pi-subagent-channel` 15/15.
- **Cleanup after keep** (commit after b5de41f1): removed the `restricted` flag and the unrestricted-toolset branch, plus the two worker-only unit tests. Model/thinking resolution tests that borrowed the name `worker` now use `reviewer`. The unit suite is 260/260. Checked that nothing a model sees changed: rerun of t01, t05 and t11 (variant `cleanup-check`), and the system prompt + tool definitions of all 16 main and child requests are byte-identical to v2 (run ids, temp paths and dates masked).
- **Was kept unused until keep:** the unrestricted-toolset branch in `buildChildArgs` (`delegate-tool.ts`, "Worker and unknown agents are left on Pi's full default toolset") and its unit tests ("omits --tools for worker role", etc.). No model can reach it: `execute()` rejects unknown agents first. Delete them after keep; that is the cleanup commit.
- **Skipped or not measured:**
  - Cost creep from real edits now landing in main's own context: the scripted edit is one tiny write. This is the main risk of the fold, and it needs a live model.
  - Shortcut and wrong pick: unmeasured, same as before.
- **Decision (who, when):** keep: the person, 2026-10-28 ("keep and go on. This follows anthropics folding of subagents into the main agent"). They asked whether losing a parallel worker limits us; see the next open question.

## Open questions for owners

1. **Config surface (blocks item 1).** Users can set `delegate.agents.<role>.model` in `acp.json` (`pi-subagents/src/config.ts:77-79`). If `researcher`/`planner`/`oracle` are merged, existing per-role config for the removed names silently stops applying. Under AGENTS.md "Configuration Surface Discipline" that needs owner sign-off before it is built. Options: keep the old names as aliases, or accept the break with a doc note.
2. **Is `worker` used for parallel implementation?** If so, criterion 2 holds and its verdict becomes `as-tool`, not `fold`.
3. **Can delegate traces be pulled?** Pi session files or `acp-delegate` output dirs from real users would turn every "inferred" traffic and context number into a measured one.
4. **Read-only enforcement:** should the read-only roles get a real guardrail (no `bash`, or a read-only bash), or is a prompt-only limit acceptable?
5. **Researcher context size:** could the main agent's own `grep`/`read` return less, making `fold` better than keeping a clean-context investigator?
6. **Who signs off on pi-lane behavior changes?** No CODEOWNERS file exists, and the git authors are bots (ework-agent, awork) plus ranxianglei.
7. **"Custom role" doc drift:** `config.ts:76-77` says `delegate.agents` accepts "any custom role", but `acp_delegate` rejects any name outside the five built-ins (`delegate-tool.ts:1435-1437`). Either the comment is wrong or a feature is missing. This is a small doc fix, separate from this plan.
8. **Parallel writes (raised by the person 2026-10-28).** With `worker` folded, nothing can implement in parallel. What was lost is narrower than it looks: the old worker had no isolation. It wrote into the same cwd as main and every other worker, with no merge step, so two parallel workers could clobber each other. If traces or a live-model eval show real demand, the safer shape is a new `as-tool` implementer that works in its own git worktree and returns a patch for main to apply, so main stays the sole writer and conflicts surface at apply time. That would be a new design with its own eval tasks (two disjoint edits in parallel; two overlapping edits), not a revert.

## Left as it is, and why

- **external-summarizer:** it already earns its own context (reads whole fold ranges, returns a capped summary) and is already a bounded tool-style call with a structured result. The kernel owns its prompt (`kernel/`, human-gated).
- **dsh-auto-review, opencode-task-subagents, claude-code-subagents:** host-owned. bili only handles their session identity. Flagged, not edited.
