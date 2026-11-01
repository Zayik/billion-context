import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { computeProtectedRefs } from "../src/recommend.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { computeIntegrityWithdrawals, computeSignedRuns } from "../src/turn-integrity.js";
import type { CoreMessage } from "../src/types.js";

type SignedCore = CoreMessage & { thinkingSignature?: string };

const MODULE_BODY = "export function stage(items) { return items.slice(0, 3); }\n".repeat(240);

function user(id: string): CoreMessage {
  return { id, role: "user", contentType: "text", text: `${id} read every module` };
}
function thinking(id: string, signed: boolean): SignedCore {
  return {
    id,
    role: "assistant",
    contentType: "reasoning",
    text: `think-${id} ` + "t".repeat(1800),
    ...(signed ? { thinkingSignature: `sig-${id}` } : {}),
  };
}
function call(id: string, callId: string, toolName = "read"): CoreMessage {
  return { id, role: "assistant", contentType: "tool-call", toolName, toolCallId: callId, text: `{"path":"src/${callId}.js"}` };
}
function result(id: string, callId: string, toolName = "read"): CoreMessage {
  return { id, role: "tool", contentType: "tool-result", toolName, toolCallId: callId, text: `// ${callId}\n${MODULE_BODY}` };
}

/** [thinking][4 reads][4 results] x batches: one user turn of batched reads. */
function batchedReads(batches: number, signed = true): CoreMessage[] {
  const out: CoreMessage[] = [user("u0")];
  for (let b = 0; b < batches; b++) {
    out.push(thinking(`r${b}`, signed));
    for (let c = 0; c < 4; c++) out.push(call(`c${b}-${c}`, `k${b}-${c}`));
    for (let c = 0; c < 4; c++) out.push(result(`t${b}-${c}`, `k${b}-${c}`));
  }
  return out;
}

function turn(messages: CoreMessage[]) {
  const core = createCore();
  const config = defaultConfig(1_000_000);
  const tokenCount = messages.reduce((s, m) => s + Math.ceil(String(m.text ?? "").length / 4), 0);
  const processed = core.processTurn({ messages, state: createInitialState(), config, tokenCount });
  return { core, config, processed, state: processed.state };
}

const thinkingIds = (messages: CoreMessage[]) =>
  messages.filter((m) => m.contentType === "reasoning").map((m) => m.id!);

describe("signed thinking folds with its run", () => {
  it("advertises the mass of batched signed reads", () => {
    const messages = batchedReads(8);
    const { processed } = turn(messages);
    const total = messages
      .filter((m) => m.contentType === "tool-result")
      .reduce((s, m) => s + Math.ceil(String(m.text).length / 4), 0);
    const pending = processed.nudge!.breakdown!.pendingT1 as number;
    assert.ok(pending >= total * 0.7, `pendingT1 ${pending} should approach ${total}`);
  });

  it("releases thinking only for runs with no other protected member", () => {
    const messages = batchedReads(8);
    const { config, state } = turn(messages);
    const refs = computeProtectedRefs(messages, state, config);
    const byRaw = state.messageRefs.byRaw;
    assert.equal(refs.has(byRaw["r0"]!), false, "old signed thinking leaves the zone");
    assert.equal(refs.has(byRaw["r7"]!), true, "the latest run stays protected");
  });

  it("keeps thinking protected when a member of its run is protected", () => {
    const messages = batchedReads(3);
    messages.splice(2, 1, call("c0-0", "k0-0", "edit"));
    messages.splice(6, 1, result("t0-0", "k0-0", "edit"));
    const config = { ...defaultConfig(1_000_000), preserveRecentTokens: 2_000_000 };
    const core = createCore();
    const { state } = core.processTurn({ messages, state: createInitialState(), config, tokenCount: 40000 });
    const refs = computeProtectedRefs(messages, state, config);
    assert.equal(refs.has(state.messageRefs.byRaw["c0-0"]!), true);
    assert.equal(refs.has(state.messageRefs.byRaw["r0"]!), true);
  });

  it("leaves unsigned reasoning exactly as it was", () => {
    const messages = batchedReads(8, false);
    const { config, state } = turn(messages);
    const refs = computeProtectedRefs(messages, state, config);
    assert.equal(computeSignedRuns(messages).length, 0);
    assert.equal(refs.has(state.messageRefs.byRaw["r0"]!), true, "unsigned thinking keeps zone protection");
  });

  it("still withdraws a partial split of a signed run", () => {
    const messages = batchedReads(3);
    const folded = new Set(messages.filter((m) => m.id !== "r0").map((m) => m.id!));
    const { withdrawn } = computeIntegrityWithdrawals(messages, folded);
    assert.equal(withdrawn.has("c0-0"), true, "calls left without their thinking are withdrawn");
  });

  it("folds a whole unit through the default apply path with no orphaned signature", () => {
    const messages = batchedReads(4);
    const { core, config, state } = turn(messages);
    const byRaw = state.messageRefs.byRaw;
    const res = core.applyCompression({
      state,
      messages,
      config,
      ranges: [{ startRef: byRaw["c0-0"]!, endRef: byRaw["t1-3"]!, summary: "s".repeat(400) }],
    });
    const block = res.state.blocks.find((b) => b.active)!;
    const covered = new Set(block.effectiveMessageIds);
    for (const id of ["r0", "c0-0", "t0-3", "r1", "c1-3", "t1-3"]) {
      assert.equal(covered.has(id), true, `${id} folds with its unit`);
    }
    for (const run of computeSignedRuns(messages)) {
      const hits = run.filter((id) => covered.has(id)).length;
      assert.ok(hits === 0 || hits === run.length, `run ${run[0]} is folded whole or not at all`);
    }
    assert.deepEqual(
      thinkingIds(messages).filter((id) => !covered.has(id)),
      ["r2", "r3"],
    );
  });
});
