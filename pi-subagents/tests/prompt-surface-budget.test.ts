import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDelegateTool, makeDelegateWaitTool, makeDelegateCancelTool, setDelegatePolicy } from "../src/delegate-tool.js";
import { ACP_DELEGATE_PROMPT } from "../src/system-prompt.js";
import { DEFAULT_DELEGATE_POLICY } from "../src/config.js";

// The delegate tools and their prompt section ride on EVERY main-agent call,
// whether or not the agent ever delegates. Before docs/pi-workflow-spec.md the
// surface measured 9728 chars; this pins the trimmed size and the rules the
// trim must keep.

type Measured = { description: string; parameters: unknown; promptSnippet?: string; promptGuidelines?: string[] };

function modelFacingChars(tool: Measured): number {
  return tool.description.length + JSON.stringify(tool.parameters).length + (tool.promptSnippet ?? "").length + (tool.promptGuidelines ?? []).join("\n").length;
}

function tools(): Measured[] {
  setDelegatePolicy(DEFAULT_DELEGATE_POLICY);
  const pi = { sendUserMessage: () => {} } as unknown as Parameters<typeof makeDelegateTool>[0];
  return [makeDelegateTool(pi), makeDelegateWaitTool(pi), makeDelegateCancelTool(pi)];
}

test("delegate prompt surface stays within its budget", () => {
  const total = tools().reduce((sum, tool) => sum + modelFacingChars(tool), 0) + ACP_DELEGATE_PROMPT.trim().length;
  assert.ok(total <= 4200, `delegate prompt surface is ${total} chars (budget 4200, pre-trim 9728)`);
});

test("delegate tool keeps the fold-into-main-loop rules", () => {
  const [delegate] = tools();
  const text = delegate!.description + "\n" + (delegate!.promptGuidelines ?? []).join("\n");
  assert.match(text, /Default to doing the work yourself/);
  assert.match(text, /independent review/);
  assert.match(text, /raw material you will not need afterwards/);
  assert.match(text, /disjoint files/);
  assert.match(text, /findings/, "brief with findings, not pointers");
  assert.match(text, /Do not work on that scope yourself while it runs/);
});

test("delegate tool no longer pushes fan-out or route-by-kind delegation", () => {
  const [delegate] = tools();
  const text = delegate!.description + "\n" + (delegate!.promptGuidelines ?? []).join("\n");
  assert.doesNotMatch(text, /launch several/i);
  assert.doesNotMatch(text, /Route by task kind/i);
  assert.doesNotMatch(text, /without polluting the main context/i);
});

test("the notification section keeps its heading and the not-a-user-request rule", () => {
  assert.ok(ACP_DELEGATE_PROMPT.trim().startsWith("ACP_DELEGATE NOTIFICATIONS"));
  assert.match(ACP_DELEGATE_PROMPT, /not a user request/);
  assert.match(ACP_DELEGATE_PROMPT, /account for every runId/);
});
