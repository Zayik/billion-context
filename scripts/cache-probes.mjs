#!/usr/bin/env node
// Paid prompt-cache probes for the fork cost plan (docs/cost-plan-unified.md, P1.1).
// Synthetic content only. Dry run unless --run is given; a hard dollar cap stops
// the run before any request whose worst-case cost would cross it.
//
//   node scripts/cache-probes.mjs [--probe A|C|D-start|D-finish|all] [--run] [--cap 1.00]
//
// A        Copilot GPT-6.1 Terra (Responses): implicit lookback after an old edit,
//          and whether an explicit prompt_cache_breakpoint is accepted and honoured.
// C        Copilot Claude Opus 5.5 (Messages): a mid-history cache_control marker
//          beyond the 20-block lookback, the 4-marker limit, and ttl "1h".
// D-start  Copilot Terra: write a prefix and record it locally.
// D-finish Copilot Terra: re-read that prefix (run 45+ minutes after D-start).
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
const AUTH = flag("--auth", process.env.PI_AUTH_FILE ?? path.join("D:/Development/Pi/agent", "auth.json"));
const OUT = flag("--out", process.env.CACHE_PROBE_OUT ?? path.join(os.homedir(), ".cache", "billion-context", "cache-probes"));

const PRICES = {
    terra: { in: 1, read: 0.05, write: 1.25, write1h: 1.25, out: 5 },
    opus: { in: 4, read: 0.2, write: 5, write1h: 8, out: 20 },
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
    const u = route === "terra" ? terraUsage(json.usage) : opusUsage(json.usage);
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

function opusUsage(usage = {}) {
    const plain = usage.input_tokens ?? 0;
    const read = usage.cache_read_input_tokens ?? 0;
    const created = usage.cache_creation_input_tokens ?? 0;
    const w1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const w5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? created - w1h;
    const out = usage.output_tokens ?? 0;
    const p = PRICES.opus;
    const usd = (plain * p.in + read * p.read + w5m * p.write + w1h * p.write1h + out * p.out) / 1e6;
    return { input: plain + read + created, cached: read, write: created, write5m: w5m, write1h: w1h, output: out, usd: +usd.toFixed(5) };
}

// ---- Probe A / D: Copilot Terra, Responses API ----

const TERRA_TURNS = 26;
const TERRA_TURN_TOKENS = 800;

function terraInput(seed, { editTurn = -1, breakpointTurn = -1, extraRounds = 0 } = {}) {
    const input = [{ role: "developer", content: [{ type: "input_text", text: text(seed, 1500, `developer-${seed}`) }] }];
    for (let t = 1; t <= TERRA_TURNS; t++) {
        const body = text(seed * 1000 + t + (t === editTurn ? 500 : 0), TERRA_TURN_TOKENS, `turn-${t}${t === editTurn ? "-edited" : ""}`);
        const block = { type: "input_text", text: body };
        if (t === breakpointTurn) block.prompt_cache_breakpoint = { mode: "explicit" };
        input.push({ role: "user", content: [block] });
        input.push({ role: "assistant", content: [{ type: "output_text", text: `noted ${t}` }] });
    }
    input.push({ role: "user", content: [{ type: "input_text", text: "Reply with the single word OK." }] });
    for (let k = 0; k < extraRounds; k++) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: "OK" }] });
        input.push({ role: "user", content: [{ type: "input_text", text: `Round ${k + 2}. Reply with the single word OK.` }] });
    }
    return input;
}

const terraBody = (input) => ({ model: "gpt-6.1-terra", input, max_output_tokens: 16, reasoning: { effort: "none" }, store: false, stream: false });
const terraSend = (name, input) => send(name, "terra", `${copilotBase()}/responses`, terraBody(input));

async function probeA() {
    const s1 = 4101 + (Date.now() % 997);
    await terraSend("A1 write base (implicit)", terraInput(s1));
    await terraSend("A2 append one round: expect full hit", terraInput(s1, { extraRounds: 1 }));
    await terraSend("A3 edit turn 7 (beyond 20 endings): expect developer-block hit only", terraInput(s1, { editTurn: 7, extraRounds: 2 }));
    const s2 = s1 + 7;
    const a4 = await terraSend("A4 write base + explicit breakpoint at turn 5", terraInput(s2, { breakpointTurn: 5 }));
    if (a4 && !a4.ok) return;
    await terraSend("A5 edit turn 7 with breakpoint at turn 5: expect hit through turn 5", terraInput(s2, { breakpointTurn: 5, editTurn: 7, extraRounds: 1 }));
}

const D_STATE = path.join(OUT, "probe-d-state.json");

async function probeDStart() {
    const seed = 9001 + (Date.now() % 997);
    const r = await terraSend("D-start write base", terraInput(seed));
    if (r?.ok) {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(D_STATE, JSON.stringify({ seed, at: Date.now() }));
    }
}

async function probeDFinish() {
    if (!fs.existsSync(D_STATE)) throw new Error(`no ${D_STATE}; run --probe D-start first`);
    const { seed, at } = JSON.parse(fs.readFileSync(D_STATE, "utf8"));
    const minutes = ((Date.now() - at) / 60000).toFixed(1);
    await terraSend(`D-finish after ${minutes} min: warm if cached ~= base`, terraInput(seed, { extraRounds: 1 }));
}

// ---- Probe C: Copilot Opus, Messages API ----

const OPUS_TURNS = 26;
const OPUS_TURN_TOKENS = 300;

function opusBody(seed, { markers = [], editTurn = -1, extraRounds = 0, ttl = {} } = {}) {
    const cc = (key) => (ttl[key] ? { type: "ephemeral", ttl: ttl[key] } : { type: "ephemeral" });
    const system = [{ type: "text", text: text(seed, 1000, `system-${seed}`), ...(markers.includes("system") ? { cache_control: cc("system") } : {}) }];
    const messages = [];
    for (let t = 1; t <= OPUS_TURNS; t++) {
        const block = { type: "text", text: text(seed * 1000 + t + (t === editTurn ? 500 : 0), OPUS_TURN_TOKENS, `turn-${t}${t === editTurn ? "-edited" : ""}`) };
        if (markers.includes(t)) block.cache_control = cc(t);
        messages.push({ role: "user", content: [block] });
        messages.push({ role: "assistant", content: [{ type: "text", text: `noted ${t}` }] });
    }
    messages.push({ role: "user", content: [{ type: "text", text: "Reply with the single word OK." }] });
    for (let k = 0; k < extraRounds; k++) {
        messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
        messages.push({ role: "user", content: [{ type: "text", text: `Round ${k + 2}. Reply with the single word OK.` }] });
    }
    const last = messages[messages.length - 1].content[0];
    if (markers.includes("end")) last.cache_control = cc("end");
    return { model: "claude-opus-5.5", max_tokens: 16, system, messages };
}

const opusSend = (name, body) => send(name, "opus", `${copilotBase()}/v1/messages`, body, { "anthropic-version": "2023-06-01" });

async function probeC() {
    const c1 = 7301 + (Date.now() % 997);
    await opusSend("C1 write: markers system + turn 5 + end", opusBody(c1, { markers: ["system", 5, "end"] }));
    await opusSend("C2 edit turn 7: expect hit through turn 5", opusBody(c1, { markers: ["system", 5, "end"], editTurn: 7, extraRounds: 1 }));
    const c2 = c1 + 11;
    await opusSend("C3 control write: markers system + end", opusBody(c2, { markers: ["system", "end"] }));
    await opusSend("C4 control edit turn 7: expect system-only hit", opusBody(c2, { markers: ["system", "end"], editTurn: 7, extraRounds: 1 }));
    await opusSend("C5 five markers: expect HTTP 400", opusBody(c2 + 1, { markers: ["system", 2, 4, 6, "end"] }));
    const c3 = c1 + 23;
    await opusSend("C6 ttl 1h on system + turn 5, 5m on end: accepted? billed how?", opusBody(c3, { markers: ["system", 5, "end"], ttl: { system: "1h", 5: "1h" } }));
}

const PROBES = { A: probeA, C: probeC, "D-start": probeDStart, "D-finish": probeDFinish };
const selected = PROBE === "all" ? ["A", "C"] : PROBE.split(",");
for (const p of selected) {
    if (!PROBES[p]) throw new Error(`unknown probe ${p}`);
    await PROBES[p]();
}

for (const r of results) console.log(JSON.stringify(r));
console.log(`\n${RUN ? "spent" : "dry run, nothing sent; worst case"} $${(RUN ? spent : results.reduce((s, r) => s + r.worstCaseUsd, 0)).toFixed(4)} (cap $${CAP})`);
if (RUN) {
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    fs.writeFileSync(file, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`results: ${file}`);
}
