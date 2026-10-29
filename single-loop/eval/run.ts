// No-model eval runner for the acp_delegate surface. Drives the REAL pi CLI
// (rpc mode) with bili loaded from --repo, against the repo's scripted fake
// upstream, so prompts, tool lists, child spawning, handoffs and sandbox
// writes are all real; only the model's choices are scripted.
//
//   node --import tsx single-loop/eval/run.ts --variant baseline [--reps 2]
//        [--only t01-review,t05-edit] [--repo <checkout>] [--roles '<json>']
//
// Writes .claude/hillclimb/delegate-structural/<variant>/results.jsonl in the
// layout single-agent-loop's compare.py reads, plus run-meta.json.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { BASELINE_ROLES, SANDBOX_FILES, buildTasks, type RoleMap, type Task } from "./tasks.ts";

const { values: opts } = parseArgs({
  options: {
    variant: { type: "string" },
    reps: { type: "string", default: "2" },
    only: { type: "string" },
    repo: { type: "string", default: path.resolve(import.meta.dirname, "../..") },
    roles: { type: "string" },
    out: { type: "string", default: path.resolve(import.meta.dirname, "../../.claude/hillclimb/delegate-structural") },
    "pi-cli": { type: "string", default: process.env.E2E_PI_CLI ?? defaultPiCli() },
  },
});

if (!opts.variant) throw new Error("--variant is required");
const REPO = path.resolve(opts.repo!);
const FAKE_UPSTREAM = path.join(REPO, "tests/e2e/fake-upstream-chat.mjs");
const PI_CLI = opts["pi-cli"]!;
const ROLES: RoleMap = opts.roles ? { ...BASELINE_ROLES, ...JSON.parse(opts.roles) } : BASELINE_ROLES;
const QUIET_MS = 5_000;
const ASYNC_QUIET_MS = 10_000;
const TASK_TIMEOUT_MS = 180_000;
const SAMPLE_MS = 400;
const DONE_TEXT = "收到#done";

function defaultPiCli(): string {
  const root = path.join(os.homedir(), ".pi", "agent", "install");
  const version = fs.readFileSync(path.join(root, "current-version"), "utf8").trim();
  const pkgDir = path.join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
  const bin = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).bin;
  return path.join(pkgDir, typeof bin === "string" ? bin : bin.pi);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const estTokens = (text: string): number => Math.round(text.length / 4);
const stripAcp = (text: string): string => text.replace(/\x3cacp\b[^>]*\x3e[\s\S]*?\x3c\/acp\x3e/g, "").trimStart();

function flat(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("");
  return "";
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address !== "string") server.close(() => resolve(address.port));
      else reject(new Error("freePort: no address"));
    });
    server.on("error", reject);
  });
}

function waitForHttp(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", () => (Date.now() > deadline ? reject(new Error(`timeout waiting for ${url}`)) : setTimeout(tick, 200)));
    };
    tick();
  });
}

function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(path.relative(dir, full).replace(/\\/g, "/"), createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
    }
  };
  walk(dir);
  return files;
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [file, hash] of after) if (before.get(file) !== hash) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

function killBiliInstances(stateHome: string): void {
  const instancesDir = path.join(stateHome, "billion-context", "instances");
  if (!fs.existsSync(instancesDir)) return;
  for (const file of fs.readdirSync(instancesDir)) {
    const record = JSON.parse(fs.readFileSync(path.join(instancesDir, file), "utf8")) as { pid?: unknown };
    if (typeof record.pid !== "number") continue;
    try { process.kill(record.pid, "SIGKILL"); } catch { /* instance already exited */ }
  }
}

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(BILI|BILLION_CONTEXT|ACP_|PI_)/.test(key)) delete env[key];
  }
  for (const key of ["NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_TEST_CONTEXT"]) delete env[key];
  return { ...env, ...extra };
}

class Rpc {
  readonly proc: ChildProcess;
  readonly states: Array<{ isStreaming?: boolean; pendingMessageCount?: number }> = [];
  stderr = "";
  private buffer = "";
  private seq = 0;

  constructor(cwd: string, env: NodeJS.ProcessEnv) {
    this.proc = spawn(process.execPath, [PI_CLI, "--mode", "rpc", "--model", "fake/fake-model"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "response" && event.command === "get_state" && event.success) this.states.push(event.data);
        } catch { /* non-JSON log line from the host */ }
      }
    });
    this.proc.stderr!.on("data", (chunk: Buffer) => { this.stderr += chunk.toString(); });
  }

  send(command: Record<string, unknown>): void {
    this.proc.stdin!.write(JSON.stringify({ id: `cmd_${++this.seq}`, ...command }) + "\n");
  }

  kill(): void {
    try { this.proc.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

interface WireRequest {
  agent: string;
  firstUser: string;
  inTokens: number;
  toolResults: string[];
  users: string[];
}

function readRequests(dumpFile: string, tokenRole: Map<string, string>): WireRequest[] {
  if (!fs.existsSync(dumpFile)) return [];
  return fs.readFileSync(dumpFile, "utf8").split("\n").filter(Boolean).flatMap((raw) => {
    let body: { messages?: Array<{ role?: string; content?: unknown }> };
    try { body = JSON.parse(raw); } catch { return []; }
    const messages = body.messages ?? [];
    const users = messages.filter((m) => m.role === "user").map((m) => stripAcp(flat(m.content)));
    const firstUser = users[0] ?? "";
    if (/title/i.test(firstUser) && !firstUser.startsWith("MAIN") && !firstUser.startsWith("CHILD")) return [];
    const token = firstUser.match(/^CHILD \S+ (TOK-\w+)/)?.[1];
    const agent = firstUser.startsWith("CHILD") ? (token && tokenRole.get(token)) || "child" : "main";
    return [{
      agent,
      firstUser,
      inTokens: estTokens(raw),
      toolResults: messages.filter((m) => m.role === "tool").map((m) => stripAcp(flat(m.content))),
      users,
    }];
  });
}

function grade(task: Task, requests: WireRequest[], writes: string[]): { pass: boolean; checks: Record<string, boolean>; notes: string[] } {
  const checks: Record<string, boolean> = {};
  const notes: string[] = [];
  const main = requests.filter((r) => r.agent === "main");
  const children = requests.filter((r) => r.agent !== "main");
  const mainToolResults = main.flatMap((r) => r.toolResults);
  const { expect } = task;

  const unexpected = writes.filter((file) => !expect.writes.includes(file));
  const missing = expect.writes.filter((file) => !writes.includes(file));
  checks.writes = unexpected.length === 0 && missing.length === 0;
  if (!checks.writes) notes.push(`writes: unexpected=[${unexpected}] missing=[${missing}]`);

  checks.main_reached_model = main.length > 0;
  if (expect.childToken) checks.handoff_in = children.some((r) => r.firstUser.includes(expect.childToken!));
  if (expect.noChild) checks.no_child = children.length === 0;
  if (expect.toolError) checks.tool_error = mainToolResults.some((text) => new RegExp(expect.toolError!).test(text));
  // One notification can merge several finished runs (#157), so count result
  // files, not messages.
  const repliesIn = (texts: string[]): number => {
    const files = new Set(texts.flatMap((text) => [...text.matchAll(/Full result: `([^`]+)`/g)].map((m) => m[1]!)));
    return [...files].filter((file) => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(DONE_TEXT)).length;
  };
  if (expect.syncHandoff) checks.handoff_out = repliesIn(mainToolResults) >= 1;
  if (expect.asyncHandoffs) {
    const notices = (main.at(-1)?.users ?? []).filter((text) => text.startsWith("[acp_delegate"));
    const delivered = repliesIn(notices);
    checks.handoff_out = delivered >= expect.asyncHandoffs;
    if (!checks.handoff_out) notes.push(`async notices=${notices.length} result files with reply=${delivered}`);
  }
  return { pass: Object.values(checks).every(Boolean), checks, notes };
}

const lockedWorkDirs: string[] = [];

async function runTask(task: Task, rep: number, variantDir: string): Promise<Record<string, unknown>> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `bili-delegate-eval-${task.id}-`));
  const sandbox = path.join(work, "sandbox");
  const agentDir = path.join(work, "pi-agent");
  const xdg = { XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", XDG_DATA_HOME: "data" };
  for (const dir of [sandbox, agentDir, ...Object.values(xdg).map((d) => path.join(work, d))]) fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(SANDBOX_FILES)) fs.writeFileSync(path.join(sandbox, file), content);
  const dumpFile = path.join(work, "fake-dump.jsonl");
  const fakePort = await freePort();
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [REPO] }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { fake: { baseUrl: `http://127.0.0.1:${fakePort}/v1`, api: "openai-completions", apiKey: "e2e-fake-key", models: [{ id: "fake-model", name: "Fake", input: ["text"], contextWindow: 60000, maxTokens: 4096 }] } },
  }));

  const fake = spawn(process.execPath, [FAKE_UPSTREAM], {
    env: { ...process.env, FAKE_PORT: String(fakePort), FAKE_HOST: "127.0.0.1", FAKE_REQLOG: path.join(work, "fake-reqlog.jsonl"), FAKE_DUMP: dumpFile },
    stdio: "ignore",
  });
  const before = snapshot(sandbox);
  const started = Date.now();
  let status = "ok";
  let error: string | undefined;
  let rpc: Rpc | undefined;
  try {
    await waitForHttp(`http://127.0.0.1:${fakePort}/v1/models`, 15_000);
    const tmp = path.join(work, "tmp");
    fs.mkdirSync(tmp);
    const env = cleanEnv({
      PI_CODING_AGENT_DIR: agentDir,
      PI_CLI_PATH: PI_CLI,
      TEMP: tmp,
      TMP: tmp,
      TMPDIR: tmp,
      ...Object.fromEntries(Object.entries(xdg).map(([key, dir]) => [key, path.join(work, dir)])),
    });
    rpc = new Rpc(sandbox, env);
    rpc.send({ type: "prompt", message: task.prompt });
    const quietMs = task.tags.includes("async") ? ASYNC_QUIET_MS : QUIET_MS;
    let lastActive = Date.now();
    const deadline = Date.now() + TASK_TIMEOUT_MS;
    while (Date.now() < deadline && rpc.proc.exitCode === null) {
      await sleep(SAMPLE_MS);
      rpc.send({ type: "get_state" });
      const state = rpc.states.at(-1);
      if (state?.isStreaming || (state?.pendingMessageCount ?? 0) > 0) lastActive = Date.now();
      if (rpc.states.length > 3 && Date.now() - lastActive >= quietMs) break;
    }
    if (Date.now() >= deadline) { status = "error"; error = "task timeout"; }
    if (rpc.proc.exitCode !== null) { status = "error"; error = `pi exited ${rpc.proc.exitCode}: ${rpc.stderr.slice(-400)}`; }
  } catch (e) {
    status = "error";
    error = e instanceof Error ? e.message : String(e);
  } finally {
    rpc?.kill();
    try { fake.kill("SIGKILL"); } catch { /* already gone */ }
  }
  const latency = (Date.now() - started) / 1000 - (task.tags.includes("async") ? ASYNC_QUIET_MS : QUIET_MS) / 1000;
  await sleep(500);

  const tokenRole = new Map<string, string>();
  for (const match of task.prompt.matchAll(/"agent":"([^"]+)","task":"CHILD \S+ (TOK-\w+)/g)) tokenRole.set(match[2]!, match[1]!);
  const requests = readRequests(dumpFile, tokenRole);
  const writes = changedFiles(before, snapshot(sandbox));
  const result = grade(task, requests, writes);
  const byAgent: Record<string, { calls: number; input_tokens: number }> = {};
  for (const request of requests) {
    const slot = (byAgent[request.agent] ??= { calls: 0, input_tokens: 0 });
    slot.calls += 1;
    slot.input_tokens += request.inTokens;
  }
  const mainRequests = requests.filter((r) => r.agent === "main");
  const traceDir = path.join(variantDir, "traces", `${task.id}-r${rep}`);
  fs.mkdirSync(traceDir, { recursive: true });
  for (const file of ["fake-dump.jsonl", "fake-reqlog.jsonl"]) {
    if (fs.existsSync(path.join(work, file))) fs.copyFileSync(path.join(work, file), path.join(traceDir, file));
  }
  if (rpc) fs.writeFileSync(path.join(traceDir, "pi.stderr.txt"), rpc.stderr);
  killBiliInstances(path.join(work, xdg.XDG_STATE_HOME));
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch {
    lockedWorkDirs.push(work);
  }
  return {
    prompt_id: task.id,
    rep,
    tags: task.tags,
    status,
    ...(error ? { error } : {}),
    model: "fake/fake-model",
    grade: { complete: status === "ok" && result.pass ? 1 : 0 },
    checks: result.checks,
    notes: result.notes,
    latency_s: Math.round(latency * 10) / 10,
    in_tokens: requests.reduce((sum, r) => sum + r.inTokens, 0),
    out_tokens: 0,
    model_calls: requests.length,
    main_first_call_tokens: mainRequests[0]?.inTokens ?? 0,
    by_agent: byAgent,
    actions: writes.map((file) => ({ name: "write", path: file })),
  };
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(REPO, "dist/agent/pi-native.js"))) throw new Error(`no build at ${REPO}: run npm run build there first`);
  if (!fs.existsSync(PI_CLI)) throw new Error(`pi CLI not found at ${PI_CLI}`);
  const only = opts.only ? new Set(opts.only.split(",")) : undefined;
  const tasks = buildTasks(ROLES).filter((task) => !only || only.has(task.id));
  const variantDir = path.join(opts.out!, opts.variant!);
  fs.mkdirSync(variantDir, { recursive: true });
  const resultsFile = path.join(variantDir, "results.jsonl");
  const commit = spawnSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"]).stdout.toString().trim();
  const dirty = spawnSync("git", ["-C", REPO, "status", "--porcelain", "--", "src", "pi-subagents/src"]).stdout.toString().trim() !== "";
  const meta = { variant: opts.variant, commit, dirty, repo: REPO, roles: ROLES, reps: Number(opts.reps), only: opts.only ?? null, pi_cli: PI_CLI, model: "fake/fake-model (scripted, zero tokens)", started: new Date().toISOString(), ended: "" };
  for (const task of tasks) {
    for (let rep = 1; rep <= Number(opts.reps); rep++) {
      const row = await runTask(task, rep, variantDir);
      fs.appendFileSync(resultsFile, JSON.stringify(row) + "\n");
      console.log(`${task.id} r${rep}: ${row.status} complete=${(row.grade as { complete: number }).complete} ${JSON.stringify(row.checks)} ${(row.notes as string[]).join("; ")}`);
    }
  }
  await sleep(5_000);
  for (const dir of lockedWorkDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (e) {
      console.warn(`could not remove ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  meta.ended = new Date().toISOString();
  fs.writeFileSync(path.join(variantDir, `run-meta-${Date.now()}.json`), JSON.stringify(meta, null, 2));
}

await main();
