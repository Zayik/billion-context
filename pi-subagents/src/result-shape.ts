// Structured delegate results: roles listed in STRUCTURED_RESULT_ROLES end
// their reply with one SubagentResponse JSON object. The reply still goes to
// the result file verbatim; this module only checks it, so the payload the
// main agent keeps in context stays a single line.

export const STRUCTURED_RESULT_ROLES: ReadonlySet<string> = new Set(["reviewer"]);

export const CALLER_NOTE = `You are called by another agent, not by a person. Your reply goes back to that agent and never reaches the user directly, so do not greet or address the user.`;

export const RESULT_FORMAT_INSTRUCTION = `End your reply with exactly one JSON object in a \`\`\`json fenced block, with exactly these fields:
- "conclusion": string — the answer to the task, in a few sentences the calling agent can act on;
- "evidence": string[] — what the conclusion rests on (file:line, values, counts), specific enough to check;
- "actions_taken": string[] — anything you changed; empty if you only read;
- "confidence": "high" | "medium" | "low";
- "caveats": string[] — what you could not check, or what would change the conclusion.`;

const RESULT_FIELDS = ["conclusion", "evidence", "actions_taken", "confidence", "caveats"] as const;
const CONFIDENCE = new Set(["high", "medium", "low"]);

export interface SubagentResponse {
  conclusion: string;
  evidence: string[];
  actions_taken: string[];
  confidence: "high" | "medium" | "low";
  caveats: string[];
}

export type ShapeCheck = { ok: true; result: SubagentResponse } | { ok: false; reason: string };

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** Check the reply's LAST ```json block (or the whole reply when it is bare JSON) against SubagentResponse. */
export function checkResultShape(reply: string): ShapeCheck {
  const blocks = [...reply.matchAll(/```json\s*\n([\s\S]*?)\n?```/g)];
  const candidate = blocks.length > 0 ? blocks[blocks.length - 1]![1]! : reply.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: blocks.length > 0 ? "the json block does not parse" : "no json block" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "not a JSON object" };
  const record = parsed as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !(RESULT_FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) return { ok: false, reason: `unexpected field ${extra.map((key) => `"${key}"`).join(", ")}` };
  const missing = RESULT_FIELDS.filter((key) => !(key in record));
  if (missing.length > 0) return { ok: false, reason: `missing field ${missing.map((key) => `"${key}"`).join(", ")}` };
  if (typeof record.conclusion !== "string" || record.conclusion.trim() === "") return { ok: false, reason: `"conclusion" is not a non-empty string` };
  for (const key of ["evidence", "actions_taken", "caveats"] as const) {
    if (!isStringArray(record[key])) return { ok: false, reason: `"${key}" is not a list of strings` };
  }
  if (typeof record.confidence !== "string" || !CONFIDENCE.has(record.confidence)) return { ok: false, reason: `"confidence" is not high, medium or low` };
  return { ok: true, result: record as unknown as SubagentResponse };
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** One payload line for a completed run of a structured-result role; undefined for other roles. */
export function resultShapeLine(agent: string, reply: string): string | undefined {
  if (!STRUCTURED_RESULT_ROLES.has(agent)) return undefined;
  const check = checkResultShape(reply);
  if (check.ok) {
    const { confidence, evidence, caveats } = check.result;
    return `Result shape: checked (confidence ${confidence}; ${plural(evidence.length, "evidence item")}, ${plural(caveats.length, "caveat")}).`;
  }
  return `Result shape: NOT checked — the reply is not the expected JSON result (${check.reason}). Treat its findings as low confidence and unverified.`;
}
