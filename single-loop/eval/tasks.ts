// Delegate-surface eval tasks. The model is the scripted fake upstream
// (tests/e2e/fake-upstream-chat.mjs): "请调用<tool> {json}" in the first user
// message becomes one tool round, then the model answers "收到#done". The
// MAIN prompt scripts the main agent; the task string it hands to
// acp_delegate scripts the child. Which role the main agent picks is model
// judgment the script cannot exercise, so each variant supplies a RoleMap
// (intent -> role name, or "self" when the main agent does the work itself).

export type Intent = "review" | "research" | "plan" | "ask" | "edit";
export type RoleMap = Record<Intent, string>;

export interface Expect {
  /** Files the task must create or change in the sandbox; any other write fails. */
  writes: string[];
  /** Token the delegated task carries; a child request must contain it. */
  childToken?: string;
  /** Sync handoff: an acp_delegate tool result carrying the child's reply. */
  syncHandoff?: boolean;
  /** Async handoff: N completion notifications whose result files hold the child's reply. */
  asyncHandoffs?: number;
  /** Regex the acp_delegate tool result must match (error paths). */
  toolError?: string;
  /** No child process may reach the model. */
  noChild?: boolean;
}

export interface Task {
  id: string;
  tags: string[];
  prompt: string;
  expect: Expect;
}

export const SANDBOX_FILES: Record<string, string> = {
  "fixture.ts": "export function total(xs: number[]): number {\n  let sum = 0;\n  for (let i = 0; i <= xs.length; i++) sum += xs[i];\n  return sum;\n}\n",
  "notes.md": "# Notes\n\nThe total() helper feeds the invoice report.\n",
};

const tool = (name: string, args: Record<string, unknown>): string => `请调用${name} ${JSON.stringify(args)}`;
const delegate = (agent: string, task: string, async = false): string => tool("acp_delegate", { agent, task, async });
const SLEEP = tool("bash", { command: "sleep 1" });

function delegated(id: string, intent: Intent, roles: RoleMap, token: string, childScript: string, expect: Omit<Expect, "childToken">): Task {
  return {
    id,
    tags: [`intent:${intent}`],
    prompt: `MAIN ${id}: ${delegate(roles[intent], `CHILD ${id} ${token} ${childScript}`)};完成。`,
    expect: { childToken: token, ...expect },
  };
}

export function buildTasks(roles: RoleMap): Task[] {
  const read = (path: string) => tool("read", { path });
  const editTask: Task = roles.edit === "self"
    ? { id: "t05-edit", tags: ["intent:edit", "unwanted-write"], prompt: `MAIN t05-edit: ${tool("write", { path: "out.txt", content: "edited" })};完成。`, expect: { writes: ["out.txt"] } }
    : { ...delegated("t05-edit", "edit", roles, "TOK-E5", tool("write", { path: "out.txt", content: "edited" }), { writes: ["out.txt"], syncHandoff: true }), tags: ["intent:edit", "unwanted-write"] };
  return [
    delegated("t01-review", "review", roles, "TOK-R1", read("fixture.ts"), { writes: [], syncHandoff: true }),
    delegated("t02-research", "research", roles, "TOK-S2", read("notes.md"), { writes: [], syncHandoff: true }),
    delegated("t03-plan", "plan", roles, "TOK-P3", read("fixture.ts"), { writes: [], syncHandoff: true }),
    delegated("t04-ask", "ask", roles, "TOK-A4", read("notes.md"), { writes: [], syncHandoff: true }),
    editTask,
    { ...delegated("t06-ro-write-tool", "review", roles, "TOK-W6", tool("write", { path: "leak.txt", content: "leak" }), { writes: [], syncHandoff: true }), tags: ["intent:review", "lost-rule"] },
    { ...delegated("t07-ro-bash-write", "review", roles, "TOK-B7", tool("bash", { command: "echo leak > leak2.txt" }), { writes: [], syncHandoff: true }), tags: ["intent:review", "lost-rule", "known-gap"] },
    { id: "t08-unknown-role", tags: ["unhappy-path"], prompt: `MAIN t08-unknown-role: ${delegate("nonexistent", "CHILD t08 TOK-U8")};完成。`, expect: { writes: [], noChild: true, toolError: "Unknown agent" } },
    { id: "t09-empty-task", tags: ["unhappy-path"], prompt: `MAIN t09-empty-task: ${delegate(roles.review, "")};完成。`, expect: { writes: [], noChild: true, toolError: "Task must be a non-empty string" } },
    { id: "t10-async", tags: ["intent:review", "async"], prompt: `MAIN t10-async: ${delegate(roles.review, `CHILD t10-async TOK-C10 ${read("fixture.ts")}`, true)};${SLEEP};${SLEEP};${SLEEP};完成。`, expect: { writes: [], childToken: "TOK-C10", asyncHandoffs: 1 } },
    { id: "t11-parallel", tags: ["intent:review", "intent:research", "async", "chain:review+research"], prompt: `MAIN t11-parallel: ${delegate(roles.review, `CHILD t11-parallel TOK-D11 ${read("fixture.ts")}`, true)};${delegate(roles.research, `CHILD t11-parallel-b TOK-F11 ${read("notes.md")}`, true)};${SLEEP};${SLEEP};${SLEEP};完成。`, expect: { writes: [], childToken: "TOK-D11", asyncHandoffs: 2 } },
  ];
}

export const BASELINE_ROLES: RoleMap = { review: "reviewer", research: "researcher", plan: "planner", ask: "oracle", edit: "worker" };
