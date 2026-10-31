#!/usr/bin/env node
// Paid probe (GPT-6 Luna on Copilot): can an explicit cache breakpoint sit on a
// compress result (a function_call_output) and still write a cache entry?
// After plugin-mode folds the compress call/result pairs cluster right after
// the developer block, and that cluster is the stable prefix a later fold keeps.
// Responses only accepts breakpoints on input_text; OpenAI's forum reports that
// a breakpoint inside function_call_output is accepted but never writes.
// Synthetic content only; dry run unless --run; hard dollar cap.
//
//   node scripts/carrier-breakpoint-probe.mjs [--run] [--cap 0.30] [--auth <pi auth.json>] [--model gpt-6-luna]
//
// Each arm sends two requests with the same head (developer + 3 compress pairs)
// and different tails. The second request's cached_tokens show whether an entry
// was written at the end of the head.
//   T  breakpoint on the last compress result (input_text inside the output)
//   U  breakpoint on a short user "checkpoint" message right after the head
//   C  control: no explicit breakpoint
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
const CAP = Number(flag("--cap", "0.30"));
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


const HEAD_DEV = 1500;
const SUMMARY = 1000;
const TAIL = 3000;

const tools = [{ type: "function", name: "compress", description: "Fold earlier context into a summary.", parameters: { type: "object", properties: { ranges: { type: "string" } }, required: ["ranges"] } }];

function head(seed, arm) {
    const items = [{ role: "developer", content: [{ type: "input_text", text: text(seed, HEAD_DEV, `developer-${seed}`) }] }];
    for (let k = 1; k <= 3; k++) {
        const callId = `call_${seed}_${k}`;
        items.push({ type: "function_call", call_id: callId, name: "compress", arguments: JSON.stringify({ ranges: `m${k}0001..m${k}0040` }) });
        const out = { type: "input_text", text: text(seed * 10 + k, SUMMARY, `summary-${k}`) };
        if (arm === "T" && k === 3) out.prompt_cache_breakpoint = { mode: "explicit" };
        items.push({ type: "function_call_output", call_id: callId, output: [out] });
    }
    if (arm === "U") items.push({ role: "user", content: [{ type: "input_text", text: "(context checkpoint)", prompt_cache_breakpoint: { mode: "explicit" } }] });
    return items;
}

function input(seed, arm, tailSeed) {
    return [
        ...head(seed, arm),
        { role: "user", content: [{ type: "input_text", text: text(tailSeed, TAIL, `tail-${tailSeed}`) }] },
        { role: "user", content: [{ type: "input_text", text: "Reply with the single word OK." }] },
    ];
}

const headTok = (arm) => `~${(HEAD_DEV + 3 * SUMMARY + 3 * 40 + (arm === "U" ? 10 : 0)).toLocaleString()} tok`;
const body = (items, key) => ({ model: MODEL, input: items, tools, tool_choice: "none", max_output_tokens: 16, reasoning: { effort: "none" }, store: false, stream: false, prompt_cache_key: key });
const lunaSend = (name, items, key) => send(name, "terra", RUN ? `${copilotBase()}/responses` : "dry-run", body(items, key));

const base = 7301 + (Date.now() % 997);
for (const [i, arm] of ["C", "T", "U"].entries()) {
    const seed = base + i * 17;
    const key = `probe-carrier-${arm}-${seed}`;
    const r1 = await lunaSend(`${arm}.1 head + tail A: write`, input(seed, arm, seed + 1), key);
    if (r1 && !r1.ok) continue;
    const expect = arm === "C" ? "expect ~0 cached (no entry at the head end)" : `cached ${headTok(arm)} if the head-end entry was written`;
    await lunaSend(`${arm}.2 same head + tail B: ${expect}`, input(seed, arm, seed + 2), key);
}

for (const r of results) console.log(JSON.stringify(r));
console.log(`\n${RUN ? "spent" : "dry run, nothing sent; worst case"} $${(RUN ? spent : results.reduce((s, r) => s + r.worstCaseUsd, 0)).toFixed(4)} (cap $${CAP})`);
if (RUN) {
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `carrier-breakpoint-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    fs.writeFileSync(file, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`results: ${file}`);
}
