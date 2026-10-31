#!/usr/bin/env node
// Paid probe: does an earlier cache breakpoint stay alive while only LONGER
// prefixes are read? The fold anchors in src/loop/cache-control.ts rely on it:
// an anchor is written once, then re-sent but not read until the next fold.
// Neither OpenAI nor Anthropic documents this for reads. Synthetic content
// only; dry run unless --run; hard dollar cap.
//
//   node scripts/cache-ttl-probe.mjs [--probe terra|opus|all] [--run] [--cap 1.50] [--auth <pi auth.json>]
//
// Three conversations per route, all with a breakpoint at turn 5 on the first
// request, then kept warm (or not) past the provider's minimum lifetime:
//   K  keep-warm: append a round every interval, re-sending the turn-5 marker
//   N  keep-warm: append a round every interval, WITHOUT the turn-5 marker
//   I  idle: no requests at all
// Finally each edits turn 7. Cached ~ through turn 5 means the turn-5 entry
// survived; ~ the system/developer block means it expired.
// terra: 30-minute minimum lifetime, interval 4 min, final edit at ~36 min.
// opus:  5-minute lifetime (Copilot), interval 2 min, final edit at ~7.5 min.
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
const CAP = Number(flag("--cap", "1.50"));
const AUTH = flag("--auth", process.env.PI_AUTH_FILE ?? path.join(os.homedir(), ".pi", "agent", "auth.json"));
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


const sleep = (ms) => (RUN ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 60000).toFixed(1)}m`;

// ---- Terra (Responses) ----
const T_TURNS = 30, T_TOK = 700;
function terraInput(seed, { mark5 = true, editTurn = -1, rounds = 0 } = {}) {
    const items = [{ role: "developer", content: [{ type: "input_text", text: text(seed, 1500, `developer-${seed}`) }] }];
    for (let t = 1; t <= T_TURNS; t++) {
        const block = { type: "input_text", text: text(seed * 1000 + t + (t === editTurn ? 500 : 0), T_TOK, `turn-${t}${t === editTurn ? "-edited" : ""}`) };
        if (t === 5 && mark5) block.prompt_cache_breakpoint = { mode: "explicit" };
        items.push({ role: "user", content: [block] });
        items.push({ role: "assistant", content: [{ type: "output_text", text: `noted ${t}` }] });
    }
    items.push({ role: "user", content: [{ type: "input_text", text: "Reply with the single word OK." }] });
    for (let k = 0; k < rounds; k++) {
        items.push({ role: "assistant", content: [{ type: "output_text", text: "OK" }] });
        items.push({ role: "user", content: [{ type: "input_text", text: `Round ${k + 2}. Reply with the single word OK.` }] });
    }
    return items;
}
const terraSend = (name, seed, opts) => send(`${at()} ${name}`, "terra", RUN ? `${copilotBase()}/responses` : "dry-run",
    { model: "gpt-6.1-terra", input: terraInput(seed, opts), max_output_tokens: 16, reasoning: { effort: "none" }, store: false, stream: false, prompt_cache_key: `ttl-probe-${seed}` });

// ---- Opus (Messages) ----
const O_TURNS = 26, O_TOK = 300;
function opusBody(seed, { mark5 = true, editTurn = -1, rounds = 0 } = {}) {
    const cc = { type: "ephemeral" };
    const system = [{ type: "text", text: text(seed, 1000, `system-${seed}`), cache_control: cc }];
    const messages = [];
    for (let t = 1; t <= O_TURNS; t++) {
        const block = { type: "text", text: text(seed * 1000 + t + (t === editTurn ? 500 : 0), O_TOK, `turn-${t}${t === editTurn ? "-edited" : ""}`) };
        if (t === 5 && mark5) block.cache_control = cc;
        messages.push({ role: "user", content: [block] });
        messages.push({ role: "assistant", content: [{ type: "text", text: `noted ${t}` }] });
    }
    messages.push({ role: "user", content: [{ type: "text", text: "Reply with the single word OK." }] });
    for (let k = 0; k < rounds; k++) {
        messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
        messages.push({ role: "user", content: [{ type: "text", text: `Round ${k + 2}. Reply with the single word OK.` }] });
    }
    messages[messages.length - 1].content[0].cache_control = cc;
    return { model: "claude-opus-5.5", max_tokens: 16, system, messages };
}
const opusSend = (name, seed, opts) => send(`${at()} ${name}`, "opus", RUN ? `${copilotBase()}/v1/messages` : "dry-run", opusBody(seed, opts), { "anthropic-version": "2023-06-01" });

async function run(label, sendFn, seedBase, intervalMin, warmRounds) {
    const K = seedBase, N = seedBase + 1, I = seedBase + 2;
    await sendFn(`${label} K write (marker at turn 5)`, K, {});
    await sendFn(`${label} N write (marker at turn 5)`, N, {});
    await sendFn(`${label} I write (marker at turn 5)`, I, {});
    for (let r = 1; r <= warmRounds; r++) {
        await sleep(intervalMin * 60000);
        await sendFn(`${label} K warm read ${r} (marker re-sent)`, K, { rounds: r });
        await sendFn(`${label} N warm read ${r} (marker dropped)`, N, { mark5: false, rounds: r });
    }
    await sleep(intervalMin * 60000);
    for (const [name, seed] of [["K", K], ["N", N], ["I", I]]) {
        await sendFn(`${label} ${name} FINAL edit turn 7: turn-5 entry alive if cached >> system block`, seed, { editTurn: 7, rounds: warmRounds + 1 });
    }
}

const PROBES = {
    terra: () => run("terra", terraSend, 7101 + (Date.now() % 997), 4, 8),
    opus: () => run("opus", opusSend, 8101 + (Date.now() % 997), 2, 3),
};
const selected = PROBE === "all" ? ["opus", "terra"] : PROBE.split(",");
for (const p of selected) {
    if (!PROBES[p]) throw new Error(`unknown probe ${p}`);
    await PROBES[p]();
}

for (const r of results) console.log(JSON.stringify(r));
console.log(`\n${RUN ? "spent" : "dry run, nothing sent; worst case"} $${(RUN ? spent : results.reduce((s, r) => s + r.worstCaseUsd, 0)).toFixed(4)} (cap $${CAP})`);
if (RUN) {
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `cache-ttl-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    fs.writeFileSync(file, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`results: ${file}`);
}
