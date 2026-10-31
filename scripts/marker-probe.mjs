#!/usr/bin/env node
// Paid probe: how many explicit cache markers Copilot GPT Responses models take, and
// whether markers from earlier requests stay findable after a mid-history edit.
// Synthetic content only. Dry run unless --run is given; a hard dollar cap stops
// the run before any request whose worst-case cost would cross it.
//
//   node scripts/marker-probe.mjs [--probe E1|E2|all] [--run] [--cap 1.00] [--auth <pi auth.json>] [--model <id>]
//
// Project rule: billion-context tests use the cheap model only (GPT-6 Luna by
// default). Terra results from 2026-10-31 are recorded in PR #10.
//
// E1  Per-request limit: fresh prefixes carrying 3, 4, 5 and 8 explicit
//     breakpoints. OpenAI documents 4 writes per request (the implicit end
//     marker takes one), so 3 should pass and 4+ may 400. Copilot may differ.
// E2  Accumulation: six requests on one growing conversation, each adding ONE
//     new breakpoint while re-sending the earlier ones (6 present at the end).
//     Then edit turn 4 (first-2 rule), turn 10 (beyond the 20-ending lookback,
//     latest-50 rule) and turn 19 (recent): each read should stop at the
//     breakpoint just before the edit.
//
// Credentials come from Pi's auth.json (github-copilot entry) and are never printed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const RUN = args.includes("--run");
const PROBE = flag("--probe", "all");
const CAP = Number(flag("--cap", "1.00"));
const MODEL = flag("--model", "gpt-6-luna");
const AUTH = flag("--auth", process.env.PI_AUTH_FILE ?? path.join(os.homedir(), ".pi", "agent", "auth.json"));
const OUT = flag("--out", process.env.CACHE_PROBE_OUT ?? path.join(os.homedir(), ".cache", "billion-context", "cache-probes"));

const PRICES = {
    // Terra-level prices: an upper bound for Luna, so the cap stays conservative.
    terra: { in: 1, read: 0.05, write: 1.25, write1h: 1.25, out: 5 },
};

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

function text(seed, approxTokens, label) {
    const r = rng(seed);
    const words = [label];
    while (words.length < Math.round(approxTokens * 0.75)) words.push(WORDS[Math.floor(r() * WORDS.length)]);
    return words.join(" ");
}

const estTokens = (obj) => Math.ceil(JSON.stringify(obj).length / 4);

let spent = 0;
const results = [];

function loadToken() {
    const auth = JSON.parse(fs.readFileSync(AUTH, "utf8"))["github-copilot"];
    if (!auth?.access) throw new Error(`no github-copilot entry in ${AUTH}`);
    const minutes = (auth.expires - Date.now()) / 60000;
    if (minutes < 5) throw new Error("Copilot token expires within 5 minutes; start Pi once to refresh it, then re-run");
    return auth.access;
}

// The Copilot token names its own proxy host (individual, business or enterprise);
// the API host is the same name with "api." instead of "proxy.".
function copilotBase() {
    const ep = /(?:^|;)proxy-ep=([^;]+)/.exec(loadToken())?.[1] ?? "proxy.individual.githubcopilot.com";
    return `https://${ep.replace(/^proxy\./, "api.")}`;
}

const COPILOT_HEADERS = {
    "User-Agent": "GitHubCopilotChat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Copilot-Integration-Id": "vscode-chat",
    "X-Initiator": "user",
    "Openai-Intent": "conversation-edits",
};

async function send(name, route, url, body, extraHeaders = {}) {
    const p = PRICES[route];
    const worst = (estTokens(body) * Math.max(p.write, p.write1h) + 64 * p.out) / 1e6;
    const row = { name, route, estInputTokens: estTokens(body), worstCaseUsd: +worst.toFixed(4) };
    if (!RUN) {
        results.push({ ...row, status: "dry-run" });
        return null;
    }
    if (spent + worst > CAP) {
        results.push({ ...row, status: `skipped: cap $${CAP} would be exceeded (spent $${spent.toFixed(4)})` });
        return null;
    }
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${loadToken()}`, ...COPILOT_HEADERS, ...extraHeaders },
        body: JSON.stringify(body),
    });
    const raw = await res.text();
    let json = null;
    try {
        json = JSON.parse(raw);
    } catch {
        json = null;
    }
    if (!res.ok) {
        const message = json?.error?.message ?? raw.slice(0, 300);
        results.push({ ...row, status: `HTTP ${res.status}`, error: message });
        return { ok: false, status: res.status, message };
    }
    const u = terraUsage(json.usage);
    spent += u.usd;
    results.push({ ...row, status: "ok", ...u, spentUsd: +spent.toFixed(4) });
    return { ok: true, usage: u };
}

function terraUsage(usage = {}) {
    const input = usage.input_tokens ?? 0;
    const d = usage.input_tokens_details ?? {};
    const cached = d.cached_tokens ?? 0;
    const writeReported = d.cache_write_tokens;
    const write = writeReported ?? Math.max(0, input - cached);
    const plain = Math.max(0, input - cached - write);
    const out = usage.output_tokens ?? 0;
    const p = PRICES.terra;
    const usd = (plain * p.in + cached * p.read + write * p.write + out * p.out) / 1e6;
    return { input, cached, write, writeReported: writeReported !== undefined, output: out, usd: +usd.toFixed(5) };
}


// ---- Copilot Terra, Responses API ----

const TURNS = 30;
const TURN_TOKENS = 700;

function input(seed, { marks = [], editTurn = -1, extraRounds = 0 } = {}) {
    const items = [{ role: "developer", content: [{ type: "input_text", text: text(seed, 1500, `developer-${seed}`) }] }];
    for (let t = 1; t <= TURNS; t++) {
        const block = { type: "input_text", text: text(seed * 1000 + t + (t === editTurn ? 500 : 0), TURN_TOKENS, `turn-${t}${t === editTurn ? "-edited" : ""}`) };
        if (marks.includes(t)) block.prompt_cache_breakpoint = { mode: "explicit" };
        items.push({ role: "user", content: [block] });
        items.push({ role: "assistant", content: [{ type: "output_text", text: `noted ${t}` }] });
    }
    items.push({ role: "user", content: [{ type: "input_text", text: "Reply with the single word OK." }] });
    for (let k = 0; k < extraRounds; k++) {
        items.push({ role: "assistant", content: [{ type: "output_text", text: "OK" }] });
        items.push({ role: "user", content: [{ type: "input_text", text: `Round ${k + 2}. Reply with the single word OK.` }] });
    }
    return items;
}

// Approximate token count of the prefix through turn t (developer + t turns).
const through = (t) => `~${(1500 + t * (TURN_TOKENS + 8)).toLocaleString()} tok`;

const body = (items, key) => ({ model: MODEL, input: items, max_output_tokens: 16, reasoning: { effort: "none" }, store: false, stream: false, prompt_cache_key: key });
const terraSend = (name, items, key) => send(name, "terra", RUN ? `${copilotBase()}/responses` : "dry-run", body(items, key));

async function probeE1() {
    const base = 5101 + (Date.now() % 997);
    for (const [i, n] of [3, 4, 5, 8].entries()) {
        const marks = Array.from({ length: n }, (_, k) => 3 + k * 3);
        await terraSend(`E1 ${n} explicit breakpoints on a fresh prefix (turns ${marks.join(",")})`, input(base + i * 13, { marks }), `probe-e1-${base}-${n}`);
    }
}

async function probeE2() {
    const seed = 6203 + (Date.now() % 997);
    const key = `probe-e2-${seed}`;
    const all = [3, 6, 9, 12, 15, 18];
    for (let k = 1; k <= all.length; k++) {
        const r = await terraSend(`E2.${k} ${k} breakpoint(s) present, 1 new (turn ${all[k - 1]}): accepted? write ~ only the new span?`, input(seed, { marks: all.slice(0, k), extraRounds: k - 1 }), key);
        if (r && !r.ok) return;
    }
    const n = all.length;
    await terraSend(`E2.7 edit turn 4: expect cached ${through(3)} (first-2 rule)`, input(seed, { marks: all, editTurn: 4, extraRounds: n }), key);
    await terraSend(`E2.8 edit turn 10: expect cached ${through(9)} (latest-50 rule, beyond 20 endings)`, input(seed, { marks: all, editTurn: 10, extraRounds: n + 1 }), key);
    await terraSend(`E2.9 edit turn 19: expect cached ${through(18)}`, input(seed, { marks: all, editTurn: 19, extraRounds: n + 2 }), key);
}

const PROBES = { E1: probeE1, E2: probeE2 };
const selected = PROBE === "all" ? ["E1", "E2"] : PROBE.split(",");
for (const p of selected) {
    if (!PROBES[p]) throw new Error(`unknown probe ${p}`);
    await PROBES[p]();
}

for (const r of results) console.log(JSON.stringify(r));
console.log(`\n${RUN ? "spent" : "dry run, nothing sent; worst case"} $${(RUN ? spent : results.reduce((s, r) => s + r.worstCaseUsd, 0)).toFixed(4)} (cap $${CAP})`);
if (RUN) {
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `terra-markers-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    fs.writeFileSync(file, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`results: ${file}`);
}
