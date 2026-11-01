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
//   canary    injectNudge off: run once and check bili.log shows ARMED-SUPPRESSED with no
//             nudge INJECT, which proves the per-arm config file is honoured (verified
//             2026-11-01). The pi lane always registers compress, so the model may
//             still call it unprompted. Not in the default arm list
//
// Fixture: N generated modules (~3.5k tokens each), each exporting an 8-field CONFIG
// table, plus src/report.js with eight stubs that each need two fields from the first
// ~12 modules, written inline. The task does not say which fields matter, report.js
// must not be opened until every module is read, and the expected values live outside
// the workspace, so the answer depends on what folding kept or on re-reading.
//
// Per session it records: billed tokens (input, cache read, cache write, output),
// pi-reported cost, turns, compress calls, reads, re-reads of an already-read module
// (read tool, or a bash command naming, brace-listing, globbing or searching across
// modules), recovery commands after the first pass, whether report.js was opened early, and
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

// Eight stubs. part1-4 use the first ~12 modules (folded under every arm); part5-8 use
// the last ~8 modules before the end (inside a 20k verbatim tail, but foldable under
// baseline's 5k tail), so the "recent" parts test what the tail setting protects.
const FIELDS = ["code", "factor", "region", "limit", "ratio", "owner", "tier", "salt"];
function reportTasks(n) {
    const r = rng(4242);
    const span = Math.min(12, n);
    const recentLo = Math.max(1, n - 7);
    const out = [];
    for (let k = 0; k < 8; k++) {
        const lo = k < 4 ? 1 : recentLo, width = k < 4 ? span : n - recentLo + 1;
        const a = lo + Math.floor(r() * width);
        let b = lo + Math.floor(r() * width);
        if (b === a) b = lo + ((b - lo + 1) % width);
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

// Module files a bash command touches: literal names, brace lists (mod_{02,03}.js),
// globs (mod_*.js, mod_0?.js), and whole-directory searches of src/ (rg/grep/cat src).
const MOD_NAMES = Array.from({ length: MODULES }, (_, i) => `mod_${pad(i + 1)}.js`);
function expandBraces(word) {
    const m = /\{([^{}]*)\}/.exec(word);
    if (!m) return [word];
    const range = /^(\d+)\.\.(\d+)$/.exec(m[1]);
    const alts = range
        ? Array.from({ length: Math.abs(+range[2] - +range[1]) + 1 }, (_, i) => String(Math.min(+range[1], +range[2]) + i).padStart(range[1].length, "0"))
        : m[1].split(",");
    return alts.flatMap((alt) => expandBraces(word.slice(0, m.index) + alt + word.slice(m.index + m[0].length)));
}
function bashTargets(cmd) {
    const out = new Set();
    let named = false;
    for (const tok of cmd.split(/[\s'"|;&()<>]+/)) {
        for (const w of expandBraces(tok)) {
            const base = w.replace(/\\/g, "/").split("/").pop();
            if (base === "report.js") out.add(base);
            if (!/^mod_/.test(base)) continue;
            named = true;
            const re = new RegExp("^" + base.replace(/[.+^$()|[\]]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + (base.endsWith(".js") || base.endsWith("*") ? "$" : ""));
            for (const n of MOD_NAMES) if (re.test(n)) out.add(n);
        }
    }
    // A search over the source directory with no module named reads every module.
    if (!named && /\b(rg|grep|cat|head|sed|awk|findstr|Select-String)\b/.test(cmd) && /(^|[\s'"/])src\/?(\s|$|['"])/.test(cmd)) for (const n of MOD_NAMES) out.add(n);
    return [...out];
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

    // Own state dir per session: bili's proxy registry and bili.log live there, so a
    // proxy left over from the previous session is never found and attached to (it
    // would carry the previous arm's config), and the log is this session's alone.
    const state = path.join(root, `${arm}-${model}-${rep}.state`);
    fs.mkdirSync(state, { recursive: true });
    const env = { ...process.env, BILI_CONFIG_FILE: cfgFile, BILI_SESSIONS_DIR: sessions, XDG_STATE_HOME: state };
    const piArgs = ["--mode", "json", "--no-session", "--provider", PROVIDER, "--model", model, "--no-context-files",
        ...(EXTENSION ? ["-e", path.resolve(EXTENSION)] : []), TASK(MODULES)];
    const m = { arm, model, rep, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, turns: 0, compress: 0, reads: 0, rereads: 0, recoveryCmds: 0, wentBackEarly: false, wentBackRecent: false, reportPeek: false, killed: false, started: Date.now() };
    const seen = new Set();
    let summaries = "";
    const lastMod = `mod_${pad(MODULES)}.js`;
    const recentLo = Math.max(1, MODULES - 7);
    const touch = (name) => {
        if (/^mod_\d+\.js$/.test(name)) {
            if (seen.has(lastMod) && name !== lastMod) {
                // Went back to a module after the first full pass: the yes/no signal.
                if (Number(name.slice(4, 6)) >= recentLo) m.wentBackRecent = true;
                else m.wentBackEarly = true;
            }
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
                    if (/compress/i.test(ev.toolName)) {
                        m.compress++;
                        summaries += JSON.stringify(ev.args ?? {}) + "\n";
                    }
                    if (ev.toolName === "read") {
                        m.reads++;
                        touch(path.basename(String(ev.args?.path ?? ev.args?.file_path ?? "").replace(/\\/g, "/")));
                    } else if (ev.toolName === "bash") {
                        const cmd = String(ev.args?.command ?? "");
                        const names = bashTargets(cmd);
                        if (names.some((n) => n.startsWith("mod_")) && seen.has(lastMod)) m.recoveryCmds++;
                        for (const name of names) touch(name);
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
            m.failedParts = [...t.stdout.matchAll(/^not ok \d+ - (part\d+)/gm)].map((x) => x[1]);
            m.earlyPass = 4 - m.failedParts.filter((x) => Number(x.slice(4)) <= 4).length;
            m.recentPass = 4 - m.failedParts.filter((x) => Number(x.slice(4)) > 4).length;
            m.minutes = +((Date.now() - m.started) / 60000).toFixed(1);
            // Validity: this session's own sessions dir has data, its own bili.log exists,
            // and the logged nudge interval matches the arm (proves its config was used).
            const logFile = path.join(state, "billion-context", "bili.log");
            const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
            // How many of the 16 values the report needs survived in the fold summaries.
            const needed = reportTasks(MODULES).flatMap((t) => [spec(t.a)[t.fa], spec(t.b)[t.fb]]);
            m.keptValues = needed.filter((v) => summaries.includes(String(v))).length;
            m.nudgeInject = (logText.match(/nudge INJECT/g) ?? []).length;
            m.nudgeSuppressed = (logText.match(/ARMED-SUPPRESSED/g) ?? []).length;
            const intervals = [...new Set([...logText.matchAll(/interval=(\d+)/g)].map((x) => Number(x[1])))];
            m.interval = intervals.join("/") || null;
            const wantInterval = ARMS[arm].nudgeGrowthTokens ?? 50000;
            m.ownSessions = fs.readdirSync(sessions, { recursive: true }).length > 0;
            m.pluginSeen = m.ownSessions && logText.length > 0 && (intervals.length === 0 || intervals.every((v) => v === wantInterval));
            m.invalidReason = m.pluginSeen ? null : !m.ownSessions ? "own sessions dir empty (attached to another proxy?)" : !logText ? "no bili.log in this session's state dir" : `interval ${m.interval} != ${wantInterval}`;
            // Stop the proxy this session spawned so it cannot linger into the next one.
            const reg = path.join(state, "billion-context", "instances");
            if (fs.existsSync(reg)) for (const f of fs.readdirSync(reg)) {
                try {
                    const pid = JSON.parse(fs.readFileSync(path.join(reg, f), "utf8")).pid;
                    if (pid && pid !== process.pid) process.kill(pid);
                } catch { /* already gone */ }
            }
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
        console.log(`  INVALID: ${m.invalidReason}. Stopping: this session did not run with its arm's config.`);
        console.log(`  $${m.cost.toFixed(3)} spent on a plain pi session`);
        break;
    }
    console.log(`  $${m.cost.toFixed(3)} turns ${m.turns} compress ${m.compress} reads ${m.reads} kept ${m.keptValues}/16 rereads ${m.rereads} recovery ${m.recoveryCmds} nudges ${m.nudgeInject} interval ${m.interval} tests ${m.testsPass}/${m.testsPass + m.testsFail} early ${m.earlyPass}/4 recent ${m.recentPass}/4 back ${m.wentBackEarly ? "E" : "-"}${m.wentBackRecent ? "R" : "-"}${m.failedParts.length ? " failed " + m.failedParts.join(",") : ""}${m.reportPeek ? " (opened report.js early)" : ""}${m.killed ? " (killed)" : ""}`);
    if (p.arm === "canary") console.log("  canary: injectNudge is off, so bili.log should show ARMED-SUPPRESSED and no nudge INJECT for this session. compress can still run: the pi lane always registers the tool, so injectTool does not apply there.");
}

console.log(`\nsummary (spent $${total.toFixed(2)}), means per arm x model:`);
console.log("arm      model               cost    cacheRead  cacheWrite  output  compress  kept/16  rereads  recovery  tests  early/4  recent/4  backEarly  backRecent");
for (const model of MODELS) for (const arm of ARM_NAMES) {
    const rs = results.filter((r) => r.arm === arm && r.model === model);
    if (!rs.length) continue;
    const avg = (k) => rs.reduce((s, r) => s + r[k], 0) / rs.length;
    console.log(`${arm.padEnd(8)} ${model.padEnd(18)} $${avg("cost").toFixed(3).padStart(6)} ${String(Math.round(avg("cacheRead"))).padStart(10)} ${String(Math.round(avg("cacheWrite"))).padStart(11)} ${String(Math.round(avg("output"))).padStart(7)} ${avg("compress").toFixed(1).padStart(9)} ${avg("keptValues").toFixed(1).padStart(8)} ${avg("rereads").toFixed(1).padStart(8)} ${avg("recoveryCmds").toFixed(1).padStart(9)}  ${avg("testsPass").toFixed(1)}/9  ${avg("earlyPass").toFixed(1).padStart(7)} ${avg("recentPass").toFixed(1).padStart(8)} ${(rs.filter((x) => x.wentBackEarly).length + "/" + rs.length).padStart(10)} ${(rs.filter((x) => x.wentBackRecent).length + "/" + rs.length).padStart(11)}`);
}
console.log(`results: ${resultsFile}`);
