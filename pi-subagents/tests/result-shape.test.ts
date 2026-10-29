import assert from "node:assert/strict";
import { test } from "node:test";
import { checkResultShape, resultShapeLine } from "../src/result-shape.js";
import { formatSyncResult } from "../src/delegate-tool.js";

const good = {
  conclusion: "Off-by-one in total(): the loop reads xs[xs.length].",
  evidence: ["fixture.ts:3 loops with i <= xs.length"],
  actions_taken: [],
  confidence: "high",
  caveats: ["read, not run"],
};
const fenced = (value: unknown): string => "Review notes first.\n\n```json\n" + JSON.stringify(value) + "\n```\n";

function result(over: Partial<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }>) {
  return { code: 0, signal: null as NodeJS.Signals | null, stdout: "", stderr: "", timedOut: false, ...over };
}

test("checkResultShape accepts a fenced SubagentResponse and a bare JSON reply", () => {
  const fencedCheck = checkResultShape(fenced(good));
  assert.equal(fencedCheck.ok, true);
  assert.equal(checkResultShape(JSON.stringify(good)).ok, true);
});

test("checkResultShape reads the LAST json block", () => {
  const reply = fenced({ draft: true }) + fenced(good);
  assert.equal(checkResultShape(reply).ok, true);
});

test("checkResultShape rejects every malformed reply with a reason", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["plain text", "looks fine to me", /no json block/],
    ["broken json", "```json\n{\"conclusion\": \n```", /does not parse/],
    ["array", fenced([good]), /not a JSON object/],
    ["missing field", fenced({ ...good, caveats: undefined }), /missing field "caveats"/],
    ["extra field", fenced({ ...good, verdict: "ok" }), /unexpected field "verdict"/],
    ["empty conclusion", fenced({ ...good, conclusion: " " }), /"conclusion" is not a non-empty string/],
    ["non-string evidence", fenced({ ...good, evidence: [3] }), /"evidence" is not a list of strings/],
    ["bad confidence", fenced({ ...good, confidence: "certain" }), /"confidence" is not high, medium or low/],
  ];
  for (const [label, reply, reason] of cases) {
    const check = checkResultShape(reply);
    assert.equal(check.ok, false, label);
    if (!check.ok) assert.match(check.reason, reason, label);
  }
});

test("resultShapeLine: checked summary, flagged reason, and no line for unstructured roles", () => {
  assert.equal(resultShapeLine("reviewer", fenced(good)), "Result shape: checked (confidence high; 1 evidence item, 1 caveat).");
  assert.match(resultShapeLine("reviewer", "looks fine") ?? "", /^Result shape: NOT checked — .*\(no json block\)\. Treat its findings as low confidence and unverified\.$/);
  assert.equal(resultShapeLine("researcher", fenced(good)), undefined);
});

test("formatSyncResult carries the shape line for completed reviewer runs only", () => {
  const checked = formatSyncResult("reviewer", "del_x", "task", result({ stdout: fenced(good) }), "/out.out");
  assert.match(checked, /Result shape: checked/);
  assert.doesNotMatch(checked, /Output:/, "the payload stays path-only: no inline reply");
  assert.match(formatSyncResult("reviewer", "del_x", "task", result({ stdout: "looks fine" }), "/out.out"), /Result shape: NOT checked/);
  assert.doesNotMatch(formatSyncResult("researcher", "del_x", "task", result({ stdout: fenced(good) }), "/out.out"), /Result shape/);
  assert.doesNotMatch(formatSyncResult("reviewer", "del_x", "task", result({ code: 1, stderr: "boom" }), "/out.out"), /Result shape/, "failed runs keep their error excerpt, no shape line");
});
