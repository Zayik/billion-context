# Contributing to the acp_delegate surface

The pi lane's main agent sees one delegate surface on every call: the `acp_delegate`,
`acp_delegate_wait` and `acp_delegate_cancel` tool descriptions, their promptGuidelines,
and the `ACP_DELEGATE NOTIFICATIONS` prompt section (all in `pi-subagents/src/`). About a
third of the main agent's fixed per-call prompt is this surface (`single-loop/PLAN.md`,
Baseline), so every line here is paid on every call of every session.

## Who owns what

| Thing | Owner |
| --- | --- |
| The delegate surface the main agent sees (tool descriptions, guidelines, prompt section) | pi-subagents maintainers. Not yet named: PLAN.md owner question 6 |
| The shared delegate eval (`single-loop/eval/`) | Same owners |
| Each role's child prompt and tool allowlist (`AGENTS` in `delegate-tool.ts`) | Same owners, with one named person per role |
| The result-shape contract (`result-shape.ts`) | Same owners |

## Adding or changing a role

A role is ready for review when all of these are true:

- [ ] It earns its own context: it reads far more than the main agent needs afterwards, or it
      checks work independently, or it runs in parallel. A role that only changes the answer's
      form belongs in an existing role's prompt instead (that is how planner and oracle were
      merged into researcher).
- [ ] It does not write. The main agent is the sole writer. A parallel implementer needs its own
      design first (PLAN.md owner question 8), not a new entry in `AGENTS`.
- [ ] Its child prompt has no persona aimed at the user. It is called by another agent.
- [ ] The eval has tasks for it: handoff in, handoff out, expected writes (none), and its
      unhappy path. The roster test in `pi-subagents/tests/delegate-tool.test.ts` lists it.
- [ ] The shared eval was run (`node --import tsx single-loop/eval/run.ts --variant <name>`) and
      `compare.py` against the last kept variant shows nothing worse and no unintended route change.
- [ ] Main's first-call tokens were compared, with the change in the PR description.
- [ ] `pi-subagents/package.json` version is bumped (CI `pi-subagents-guard`).

## Changing the surface the main agent sees

Open the request with the eval task or trace that motivates it. Try a clearer tool result or a
deletion first; a new sentence is the last resort. One round of surface edits is one eval
variant with its own comparison.

## Retiring things

At every model upgrade, rerun the shared eval. When a live model is available, also run the
judgment checks this eval cannot make (wrong pick, shortcut, repeated work, JSON-format
adherence for `reviewer`) and retire rules the model no longer needs.
