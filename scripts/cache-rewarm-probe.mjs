#!/usr/bin/env node
// Paid probe (Haiku 5.5 on Copilot): after every cache entry has expired, does
// ONE request carrying several markers re-create an entry at each of them?
// Synthetic content only; dry run unless --run; hard dollar cap.
//
//   node scripts/cache-rewarm-probe.mjs [--run] [--cap 0.50] [--auth <pi auth.json>] [--model claude-haiku-5.5] [--idle-min 6]
//
// R1  write: markers at system, turn 5, turn 10, end (4 = Anthropic's limit)
// R2  wait --idle-min (default 6, past the 5-minute lifetime), re-send R1
//     unchanged: expect a full write (everything expired)
// R3  immediately edit turn 11: cached should reach turn 10
// R4  edit turn 6: cached should reach turn 5
// R5  edit turn 2: cached should be the system block only
// R6  five markers: expect HTTP 400 (limit check, nothing billed)
// Project rule: tests use the cheap models only.
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
const CAP = Number(flag("--cap", "0.50"));
const AUTH = flag("--auth", process.env.PI_AUTH_FILE ?? path.join(os.homedir(), ".pi", "agent", "auth.json"));
const OUT = flag("--out", process.env.CACHE_PROBE_OUT ?? path.join(os.homedir(), ".cache", "billion-context", "cache-probes"));

const PRICES = {
    terra: { in: 1, read: 0.05, write: 1.25, write1h: 1.25, out: 5 },
    // Opus-level prices: an upper bound for Haiku, so the cap stays conservative.
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
const MODEL = flag("--model", "claude-haiku-5.5");
const IDLE_MIN = Number(flag("--idle-min", "6"));

const TURNS = 26, TOK = 300;
function body(seed, { marks = ["system", 5, 10, "end"], editTurn = -1 } = {}) {
    const cc = { type: "ephemeral" };
    const system = [{ type: "text", text: text(seed, 1000, `system-${seed}`), ...(marks.includes("system") ? { cache_control: cc } : {}) }];
    const messages = [];
    for (let t = 1; t <= TURNS; t++) {
        const block = { type: "text", text: text(seed * 1000 + t + (t === editTurn ? 500 : 0), TOK, `turn-${t}${t === editTurn ? "-edited" : ""}`) };
        if (marks.includes(t)) block.cache_control = cc;
        messages.push({ role: "user", content: [block] });
        messages.push({ role: "assistant", content: [{ type: "text", text: `noted ${t}` }] });
    }
    messages.push({ role: "user", content: [{ type: "text", text: "Reply with the single word OK.", ...(marks.includes("end") ? { cache_control: cc } : {}) }] });
    return { model: MODEL, max_tokens: 16, system, messages };
}
const go = (name, b) => send(`${at()} ${name}`, "opus", RUN ? `${copilotBase()}/v1/messages` : "dry-run", b, { "anthropic-version": "2023-06-01" });

const seed = 9301 + (Date.now() % 997);
const first = await go("R1 write: markers system, turn 5, turn 10, end", body(seed));
if (!RUN || first?.ok) {
    await sleep(IDLE_MIN * 60000);
    await go(`R2 after ${IDLE_MIN} min idle, same request: expect full write`, body(seed));
    await go("R3 edit turn 11: expect cached through turn 10", body(seed, { editTurn: 11 }));
    await go("R4 edit turn 6: expect cached through turn 5", body(seed, { editTurn: 6 }));
    await go("R5 edit turn 2: expect system block only", body(seed, { editTurn: 2 }));
    await go("R6 five markers: expect HTTP 400", body(seed + 1, { marks: ["system", 3, 5, 10, "end"] }));
}

for (const r of results) console.log(JSON.stringify(r));
console.log(`\n${RUN ? "spent" : "dry run, nothing sent; worst case"} $${(RUN ? spent : results.reduce((s, r) => s + r.worstCaseUsd, 0)).toFixed(4)} (cap $${CAP})`);
if (RUN) {
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `cache-rewarm-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    fs.writeFileSync(file, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`results: ${file}`);
}
