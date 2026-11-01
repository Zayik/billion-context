#!/usr/bin/env node
// Paid A/B: does a bigger verbatim tail (and optionally a bigger nudge step) keep
// fold quality up without costing much? Runs real pi sessions with the billion-context
// plugin against a generated fixture repo, once per arm x model x rep.
//
// Dry run unless --run is given. A dollar cap is checked while each session streams
// (the session is killed if it crosses --run-cap) and between sessions (--cap).
//
//   node scripts/fold-tuning-ab.mjs [--run] [--cap 15] [--run-cap 3]
//       [--arms baseline,tail,tail75] [--models claude-haiku-5.5,gpt-6-luna]
//       [--provider github-copilot] [--reps 2] [--modules 32] [--keep]
//       [--extension <path to billion-context dist/agent/pi-native.js>]
//       [--pi-cli <path to pi's dist/bundle/cli.js>]
//
// --pi-cli runs pi's CLI through node with no shell. Required on Windows, where pi is a
// .ps1/.cmd shim and a shell launch splits the multi-line prompt into words (and makes
// the per-session kill unreliable). Set PI_MANAGED_INSTALL_ROOT if pi's shim does.
//
// --extension loads the plugin for these sessions only (pi -e), so a build of the fork
// can be measured without touching the global pi setup. A session that shows no sign
// of the plugin (no compress call and an empty bili sessions dir) is marked invalid,
// and the run stops after it, since its numbers would be plain pi.
//
// Project rule: cheap models only (Haiku 5.5, GPT-6 Luna). Never Terra or Opus.
//
// Arms (merged over your existing billion-context config, compress block only):
//   baseline  upstream defaults (50k step, 3 messages / 5k tokens tail, read/bash unprotected)
//   tail      preserveRecentTools ["read"] + preserveRecentTokens 20000
//   tail75    tail + nudgeGrowthTokens 75000
//   canary    injectTool/injectNudge off: run once to prove the per-arm config file is
//             honoured (expect 0 compress calls); not in the default arm list
//
// Fixture: N generated modules (~3.5k tokens each), each exporting an 8-field CONFIG
// table, plus src/report.js with eight stubs that each need two fields from the first
// ~12 modules, written inline. The task does not say which fields matter, report.js
// must not be opened until every module is read, and the expected values live outside
// the workspace, so the answer depends on what folding kept or on re-reading.
//
// Per session it records: billed tokens (input, cache read, cache write, output),
// pi-reported cost, turns, compress calls, reads, re-reads of an already-read module
// (read tool or a bash command naming it), whether report.js was opened early, and
// how many of the 9 hidden tests pass. Results go to --out as JSONL plus a summary.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const RUN = args.includes("--run");
const KEEP = args.includes("--keep");
const CAP = Number(flag("--cap", "15"));
const RUN_CAP = Number(flag("--run-cap", "3"));
const REPS = Number(flag("--reps", "2"));
const MODULES = Number(flag("--modules", "32"));
const PROVIDER = flag("--provider", "github-copilot");
const MODELS = flag("--models", "claude-haiku-5.5,gpt-6-luna").split(",").filter(Boolean);
const ARM_NAMES = flag("--arms", "baseline,tail,tail75").split(",").filter(Boolean);
const PI = flag("--pi", process.env.PI_BIN ?? "pi");
const PI_CLI = flag("--pi-cli", undefined);
if (PI_CLI && !fs.existsSync(PI_CLI)) {
    console.error(`--pi-cli not found: ${PI_CLI}`);
    process.exit(2);
}
if (!PI_CLI && process.platform === "win32" && args.includes("--run")) {
    console.error("on Windows pass --pi-cli <pi dist/bundle/cli.js>: a shell launch mangles the prompt");
    process.exit(2);
}
const EXTENSION = flag("--extension", undefined);
if (EXTENSION && !fs.existsSync(EXTENSION)) {
    console.error(`--extension not found: ${EXTENSION} (build the checkout first)`);
    process.exit(2);
}
const OUT = flag("--out", path.join(os.homedir(), ".cache", "billion-context", "fold-tuning-ab"));

const BANNED = /terra|opus/i;
for (const m of MODELS) {
    if (BANNED.test(m)) {
        console.error(`refusing model ${m}: project rule is Haiku 5.5 / GPT-6 Luna only`);
        process.exit(2);
    }
}

const ARMS = {
    baseline: {},
    tail: { preserveRecentTools: ["read"], preserveRecentTokens: 20000 },
    tail75: { preserveRecentTools: ["read"], preserveRecentTokens: 20000, nudgeGrowthTokens: 75000 },
    canary: { injectTool: false, injectNudge: false },
};
for (const a of ARM_NAMES) {
    if (!ARMS[a]) {
        console.error(`unknown arm ${a} (known: ${Object.keys(ARMS).join(", ")})`);
        process.exit(2);
    }
}

// Rough per-million prices for the dry-run estimate only (an upper bound: the 2026-11-01
// Luna pilot cost $0.07 per session against a $1.19 estimate); the live cap uses pi's own cost.
const EST = { in: 1, read: 0.1, write: 1.25, out: 5 };

// ─── fixture ──────────────────────────────────────────────────────────────────

const WORDS = ("ledger anchor river copper signal harbor meadow lantern quarry orbit velvet cedar falcon prism tundra " +
    "beacon cobalt ember glacier hollow juniper kelp lattice marble nectar opal pewter quartz raven saffron " +
    "thistle umber vertex willow yonder zephyr basalt canyon delta estuary fjord grove heath inlet jetty knoll").split(" ");

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pad = (n) => String(n).padStart(2, "0");

// Each module carries an 8-field CONFIG table. Nothing in the task says which fields
// matter, and report.js plus the expected values stay hidden until all reads are done,
// so recovering a value depends on what folding kept (or on re-reading the module).
function spec(i) {
    const r = rng(1000 + i);
    const w = () => WORDS[Math.floor(r() * WORDS.length)];
    return {
        code: `${w()}-${100 + Math.floor(r() * 900)}`,
        factor: 2 + Math.floor(r() * 97),
        region: w(),
        limit: 100 + Math.floor(r() * 9900),
        ratio: Math.round(r() * 10000) / 100,
        owner: w(),
        tier: 1 + Math.floor(r() * 5),
        salt: Math.floor(r() * 0xffffff).toString(16).padStart(6, "0"),
    };
}

function moduleSource(i, targetChars = 14000) {
    const r = rng(i);
    const w = () => WORDS[Math.floor(r() * WORDS.length)];
    const s = spec(i);
    let out = `// mod_${pad(i)}: ${w()} ${w()} pipeline stage.\n\n` +
        `export const CONFIG_${pad(i)} = ${JSON.stringify(s, null, 4)};\n\n`;
    let f = 0;
    while (out.length < targetChars) {
        const name = `${w()}${w()[0].toUpperCase()}${w().slice(1)}${f++}`;
        const k = 1 + Math.floor(r() * 9);
        out += `/** ${w()} the ${w()} ${w()} for ${w()} ${w()}. */\n` +
            `export function ${name}(items, opts = {}) {\n` +
            `    const ${w()}Limit = opts.limit ?? ${Math.floor(r() * 500)};\n` +
            `    return items\n` +
            `        .filter((x) => x.${w()} !== undefined && x.weight > ${k})\n` +
            `        .map((x) => ({ ...x, ${w()}: (x.weight * ${k}) % ${7 + Math.floor(r() * 50)}, tag: "${w()}" }))\n` +
            `        .slice(0, ${w()}Limit);\n` +
            `}\n\n`;
    }
    return out;
}

// Eight stubs over fields of the first ~12 modules (folded by the time they are written).
const FIELDS = ["code", "factor", "region", "limit", "ratio", "owner", "tier", "salt"];
function reportTasks(n) {
    const r = rng(4242);
    const span = Math.min(12, n);
    const out = [];
    for (let k = 0; k < 8; k++) {
        const a = 1 + Math.floor(r() * span);
        let b = 1 + Math.floor(r() * span);
        if (b === a) b = 1 + (b % span);
        const fa = FIELDS[Math.floor(r() * FIELDS.length)];
        const fb = FIELDS[Math.floor(r() * FIELDS.length)];
        out.push({
            fn: `part${k + 1}`,
            a, b, fa, fb,
            text: `CONFIG_${pad(a)}.${fa} and CONFIG_${pad(b)}.${fb}, as a two-element array [${fa}, ${fb}]`,
            expected: [spec(a)[fa], spec(b)[fb]],
        });
    }
    return out;
}

// Tests live outside the workspace so the agent cannot read the expected values.
function writeFixture(dir, n, testFile) {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fold-fixture", type: "module", private: true }, null, 2));
    for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(dir, "src", `mod_${pad(i)}.js`), moduleSource(i));
    const tasks = reportTasks(n);
    let report = "// Build rule: this file must not import anything. Write the values inline.\n\n";
    const reportUrl = new URL(`file://${path.resolve(dir, "src", "report.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}`).href;
    let test = 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport fs from "node:fs";\n' +
        `const url = ${JSON.stringify(reportUrl)};\nconst r = await import(url);\n\n` +
        'test("report.js has no imports", () => {\n    assert.doesNotMatch(fs.readFileSync(new URL(url), "utf8"), /^\\s*import\\b|require\\(/m);\n});\n\n';
    for (const t of tasks) {
        report += `/** Return ${t.text} (see src/mod_${pad(t.a)}.js and src/mod_${pad(t.b)}.js). */\n` +
            `export function ${t.fn}() {\n    throw new Error("TODO");\n}\n\n`;
        test += `test("${t.fn}", () => {\n    assert.deepEqual(r.${t.fn}(), ${JSON.stringify(t.expected)});\n});\n\n`;
    }
    fs.writeFileSync(path.join(dir, "src", "report.js"), report);
    fs.writeFileSync(testFile, test);
}

const TASK = (n) =>
    `This repo has src/mod_01.js through src/mod_${pad(n)}.js and src/report.js.\n` +
    `Step 1: read every module from mod_01 to mod_${pad(n)} in order, one file per read call, to learn the codebase. Do not open src/report.js until you have read all of them.\n` +
    `Step 2: open src/report.js and implement every function exactly as its doc comment says. Do not add imports; write the values inline. Re-read files only if you need to.\n` +
    `Step 3: check your values, then stop. There is no test suite in this repo.`;

// ─── config per arm ───────────────────────────────────────────────────────────

function baseConfigPath() {
    if (process.env.BILI_CONFIG_FILE) return process.env.BILI_CONFIG_FILE;
    const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
    return path.join(xdg, "billion-context", "billion-context.json");
}

function readJsonLoose(file) {
    try {
        // Config may be JSONC: drop full-line // comments and trailing commas.
        const raw = fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function armConfig(arm) {
    const base = readJsonLoose(baseConfigPath());
    return { ...base, compress: { ...(base.compress ?? {}), ...ARMS[arm] } };
}

// ─── one session ──────────────────────────────────────────────────────────────

function runSession({ arm, model, rep, root }) {
    const work = path.join(root, `${arm}-${model}-${rep}`);
    const testFile = path.join(root, `${arm}-${model}-${rep}.hidden.test.mjs`);
    writeFixture(work, MODULES, testFile);
    const cfgFile = path.join(root, `${arm}-${model}-${rep}.config.json`);
    fs.writeFileSync(cfgFile, JSON.stringify(armConfig(arm), null, 2));
    const sessions = path.join(root, `${arm}-${model}-${rep}.bili-sessions`);
    fs.mkdirSync(sessions, { recursive: true });

    const env = { ...process.env, BILI_CONFIG_FILE: cfgFile, BILI_SESSIONS_DIR: sessions };
    const piArgs = ["--mode", "json", "--no-session", "--provider", PROVIDER, "--model", model, "--no-context-files",
        ...(EXTENSION ? ["-e", path.resolve(EXTENSION)] : []), TASK(MODULES)];
    const m = { arm, model, rep, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, turns: 0, compress: 0, reads: 0, rereads: 0, reportPeek: false, killed: false, started: Date.now() };
    const seen = new Set();
    const lastMod = `mod_${pad(MODULES)}.js`;
    const touch = (name) => {
        if (/^mod_\d+\.js$/.test(name)) {
            if (seen.has(name)) m.rereads++;
            seen.add(name);
        } else if (name === "report.js" && !seen.has(lastMod)) m.reportPeek = true;
    };

    return new Promise((resolve) => {
        const child = PI_CLI
            ? spawn(process.execPath, [path.resolve(PI_CLI), ...piArgs], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] })
            : spawn(PI, piArgs, { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
        let buf = "";
        const log = fs.createWriteStream(path.join(root, `${arm}-${model}-${rep}.events.jsonl`));
        child.stdout.on("data", (chunk) => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line.trim()) continue;
                log.write(line + "\n");
                let ev;
                try { ev = JSON.parse(line); } catch { continue; }
                if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message.usage) {
                    const u = ev.message.usage;
                    m.turns++;
                    m.input += u.input ?? 0;
                    m.cacheRead += u.cacheRead ?? 0;
                    m.cacheWrite += u.cacheWrite ?? 0;
                    m.output += u.output ?? 0;
                    m.cost += u.cost?.total ?? 0;
                    if (m.cost > RUN_CAP && !m.killed) {
                        m.killed = true;
                        console.error(`  run cap $${RUN_CAP} crossed ($${m.cost.toFixed(2)}), stopping session`);
                        child.kill();
                    }
                }
                if (ev.type === "tool_execution_start") {
                    if (/compress/i.test(ev.toolName)) m.compress++;
                    if (ev.toolName === "read") {
                        m.reads++;
                        touch(path.basename(String(ev.args?.path ?? ev.args?.file_path ?? "").replace(/\\/g, "/")));
                    } else if (ev.toolName === "bash") {
                        const cmd = String(ev.args?.command ?? "");
                        for (const name of new Set(cmd.match(/mod_\d+\.js|report\.js/g) ?? [])) touch(name);
                    }
                }
            }
        });
        child.stderr.on("data", (c) => fs.appendFileSync(path.join(root, `${arm}-${model}-${rep}.stderr.log`), c));
        child.on("close", () => {
            log.end();
            const t = spawnSync(process.execPath, ["--test", "--test-reporter=tap", testFile], { cwd: root, encoding: "utf8" });
            const pass = Number(/^(?:#|ℹ) pass (\d+)/m.exec(t.stdout)?.[1] ?? 0);
            const fail = Number(/^(?:#|ℹ) fail (\d+)/m.exec(t.stdout)?.[1] ?? 0);
            m.testsPass = pass;
            m.testsFail = fail;
            m.minutes = +((Date.now() - m.started) / 60000).toFixed(1);
            m.pluginSeen = m.compress > 0 || fs.readdirSync(sessions, { recursive: true }).length > 0;
            delete m.started;
            if (!KEEP) fs.rmSync(work, { recursive: true, force: true });
            resolve(m);
        });
    });
}

// ─── main ─────────────────────────────────────────────────────────────────────

function estimate() {
    // ~3.5k tokens per module read, context grows to ~boot + reads; ~2 turns per module.
    const boot = 15000, perMod = 3500, turns = MODULES * 2 + 15;
    const avgCtx = boot + (MODULES * perMod) / 2;
    const read = turns * avgCtx, write = MODULES * perMod * 2.5, out = turns * 600;
    return (read * EST.read + write * EST.write + out * EST.out + turns * 500 * EST.in) / 1e6;
}

const plan = [];
for (const model of MODELS) for (let rep = 1; rep <= REPS; rep++) for (const arm of ARM_NAMES) plan.push({ arm, model, rep });

const per = estimate();
console.log(`fold-tuning A/B: ${plan.length} sessions (${ARM_NAMES.join("/")} x ${MODELS.join("/")} x ${REPS} reps), ${MODULES} modules`);
console.log(`rough estimate ~$${per.toFixed(2)} per session, ~$${(per * plan.length).toFixed(2)} total; cap $${CAP}, per-session cap $${RUN_CAP}`);
console.log(`base config: ${baseConfigPath()}`);
console.log(`plugin: ${EXTENSION ? `pi -e ${path.resolve(EXTENSION)}` : "whatever pi has installed"}`);
for (const a of ARM_NAMES) console.log(`  ${a}: compress ${JSON.stringify(ARMS[a])}`);

if (!RUN) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-fixture-"));
    const testFile = path.join(dir, "hidden.test.mjs");
    writeFixture(dir, MODULES, testFile);
    const t = spawnSync(process.execPath, ["--test", "--test-reporter=tap", testFile], { cwd: dir, encoding: "utf8" });
    const chars = fs.readdirSync(path.join(dir, "src")).reduce((s, f) => s + fs.statSync(path.join(dir, "src", f)).size, 0);
    console.log(`dry run: fixture ${chars} chars (~${Math.round(chars / 4)} tokens); stub tests: pass ${/^(?:#|ℹ) pass (\d+)/m.exec(t.stdout)?.[1]} fail ${/^(?:#|ℹ) fail (\d+)/m.exec(t.stdout)?.[1]} (expected 1 pass, 8 fail)`);
    console.log(`fixture kept at ${dir}. Add --run to spend.`);
    process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const root = path.join(OUT, stamp);
fs.mkdirSync(root, { recursive: true });
const resultsFile = path.join(root, "results.jsonl");
let total = 0;
const results = [];
for (const p of plan) {
    if (total + Math.min(RUN_CAP, per) > CAP) {
        console.log(`stopping: next session could cross the $${CAP} cap (spent $${total.toFixed(2)})`);
        break;
    }
    console.log(`> ${p.arm} ${p.model} rep ${p.rep}`);
    const m = await runSession({ ...p, root });
    total += m.cost;
    results.push(m);
    fs.appendFileSync(resultsFile, JSON.stringify(m) + "\n");
    if (!m.pluginSeen) {
        console.log(`  INVALID: no sign the billion-context plugin loaded (0 compress calls, empty sessions dir). Stopping.`);
        console.log(`  $${m.cost.toFixed(3)} spent on a plain pi session`);
        break;
    }
    console.log(`  $${m.cost.toFixed(3)} turns ${m.turns} compress ${m.compress} reads ${m.reads} rereads ${m.rereads} tests ${m.testsPass}/${m.testsPass + m.testsFail}${m.reportPeek ? " (opened report.js early)" : ""}${m.killed ? " (killed)" : ""}`);
    if (p.arm === "canary") console.log(m.compress === 0 ? "  canary OK: compress was off, so the per-arm config file is honoured" : "  CANARY FAILED: compress ran although the arm config turned it off; per-arm results are not trustworthy");
}

console.log(`\nsummary (spent $${total.toFixed(2)}), means per arm x model:`);
console.log("arm      model               cost    cacheRead  cacheWrite  output  compress  rereads  tests");
for (const model of MODELS) for (const arm of ARM_NAMES) {
    const rs = results.filter((r) => r.arm === arm && r.model === model);
    if (!rs.length) continue;
    const avg = (k) => rs.reduce((s, r) => s + r[k], 0) / rs.length;
    console.log(`${arm.padEnd(8)} ${model.padEnd(18)} $${avg("cost").toFixed(3).padStart(6)} ${String(Math.round(avg("cacheRead"))).padStart(10)} ${String(Math.round(avg("cacheWrite"))).padStart(11)} ${String(Math.round(avg("output"))).padStart(7)} ${avg("compress").toFixed(1).padStart(9)} ${avg("rereads").toFixed(1).padStart(8)}  ${avg("testsPass").toFixed(1)}/9`);
}
console.log(`results: ${resultsFile}`);
