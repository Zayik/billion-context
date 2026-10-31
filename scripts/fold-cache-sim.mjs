#!/usr/bin/env node
// Fold cache simulator: replays synthetic pi sessions through billion-context's
// fold rules and scores cache-marker layouts on the Responses (GPT-5.6+) and
// Anthropic cache models. Free: no network.
//
// Fold rules mirrored from the kernel (kernel/src/recommend.ts, config.ts):
//   - protected zone: last 3 messages, last 5,000 tokens, last user message;
//   - compressible ranges are split at user messages (about one turn each);
//   - a fold removes its range from the wire; in plugin mode the summary rides
//     in the compress call/result pair at the tail (a live carrier, never folded
//     by a plain range).
// Layout "inplace" is a what-if: the summary is rendered as a user-role message
// where the folded range was, and the tail compress result is a short stub.
//
// Cache rules:
//   responses: entries are written at the implicit breakpoint (end of the latest
//     eligible message) and at explicit breakpoints (4 writes per request). A
//     lookup checks explicit breakpoints (first 2 + latest 50), the implicit one,
//     20 earlier eligible message endings and the end of the developer block.
//     Explicit breakpoints can sit only on user or developer input_text.
//   anthropic: at most 4 cache_control marks; entries are written only at marks;
//     each mark reads the longest live entry within 20 blocks before it.
//
// Usage: node scripts/fold-cache-sim.mjs [--seed N] [--json]

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : dflt;
};
const SEED = Number(opt("seed", 1));
const SEEDS = Number(opt("seeds", 20));
const JSON_OUT = args.includes("--json");

// Prices relative to uncached input.
const READ = 0.1;
const WRITE = 1.25;

function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}
const lognormal = (r, median, sigma) => {
    const u = Math.max(r(), 1e-9), v = r();
    return Math.round(median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
};

// ── Session generation ──────────────────────────────────────────────────────
// A message: { id, role: dev|user|asst|tool|carrier-call|carrier|summary, tok, turn }

function* sessionEvents(r, sc) {
    let n = 0;
    const id = (p) => `${p}${++n}`;
    for (let turn = 0; turn < sc.turns; turn++) {
        yield { kind: "user", msg: { id: id("u"), role: "user", tok: Math.min(4000, Math.max(30, lognormal(r, sc.userMedian, 1))), turn } };
        const rounds = Math.max(0, Math.round(lognormal(r, sc.roundsMedian, 0.7)));
        for (let k = 0; k < rounds; k++) {
            yield { kind: "round", msgs: [
                { id: id("c"), role: "asst", tok: 80 + Math.round(r() * 300), turn },
                { id: id("t"), role: "tool", tok: Math.min(20000, Math.max(20, lognormal(r, sc.toolMedian, 1.1))), turn, protectedTool: sc.protectHeadTool && turn === 0 && k === 0 },
            ] };
        }
        yield { kind: "reply", msg: { id: id("a"), role: "asst", tok: 100 + Math.round(r() * 600), turn } };
    }
}

// ── Fold policy (kernel-shaped) ─────────────────────────────────────────────

function protectedSet(visible) {
    const out = new Set();
    const plain = visible.filter((m) => m.role !== "dev");
    for (const m of plain.slice(-3)) out.add(m.id);
    let acc = 0;
    for (let i = plain.length - 1; i >= 0 && acc < 5000; i--) { out.add(plain[i].id); acc += plain[i].tok; }
    for (let i = plain.length - 1; i >= 0; i--) if (plain[i].role === "user") { out.add(plain[i].id); break; }
    return out;
}

// Compressible ranges: contiguous foldable messages split at user messages.
function ranges(visible, sc) {
    const prot = protectedSet(visible);
    const out = [];
    let cur = null;
    for (let i = 0; i < visible.length; i++) {
        const m = visible[i];
        const foldable = !["dev", "summary", "carrier", "carrier-call"].includes(m.role) && !prot.has(m.id) && !m.protectedTool && !(sc.keepFirstUser && m.id === sc.firstUserId);
        if (!foldable) { if (cur) out.push(cur), (cur = null); continue; }
        if (cur && m.role === "user" && cur.ids.length >= 3) { out.push(cur); cur = null; }
        if (!cur) cur = { start: i, ids: [], tok: 0 };
        cur.ids.push(m.id); cur.tok += m.tok;
    }
    if (cur) out.push(cur);
    return out;
}

// ── Cache models ────────────────────────────────────────────────────────────

class PrefixIndex {
    // prefix keys and token offsets for one request
    constructor(msgs) {
        this.keys = []; this.ends = [];
        let h = "", t = 0;
        for (const m of msgs) { h = hashStep(h, m.id); t += m.tok; this.keys.push(h); this.ends.push(t); }
    }
}
let HS = new Map(), HN = 0;
function hashStep(prev, id) {
    const k = prev + "|" + id;
    let v = HS.get(k);
    if (v === undefined) { v = `h${++HN}`; HS.set(k, v); }
    return v;
}

const isEligibleEnding = (msgs, i) => {
    const m = msgs[i];
    if (m.role === "user" || m.role === "summary" || m.role === "dev") return true;
    if (m.role === "tool" || m.role === "carrier") return !(msgs[i + 1] && (msgs[i + 1].role === "tool" || msgs[i + 1].role === "carrier"));
    return false;
};
const markable = (m) => m.role === "user" || m.role === "summary" || m.role === "dev";

// ── Marker strategies (Responses) ───────────────────────────────────────────
// Each returns the indices (into msgs) of explicit breakpoints for this request.
// `st` is per-session strategy state (sticky markers survive between requests).

const RESP = {
    none: () => [],
    // PR #10 as first opened: anchors on user messages only, newest 40.
    "anchors(user)": (msgs, ctx) => anchorIdx(msgs, ctx, 40),
    // Sticky grid: mark a user/summary message when the gap since the previous
    // sticky marker reaches G tokens; markers persist until folded away.
    grid: (msgs, ctx, st) => gridIdx(msgs, ctx, st, ctx.gridTok),
    "grid+anchors(user)": (msgs, ctx, st) => cap([...gridIdx(msgs, ctx, st, ctx.gridTok), ...anchorIdx(msgs, ctx, 40)], msgs),
    // Every user message, sticky, newest 38 + first 2.
    // PR #10 now: anchors may sit on tool results too (Luna probe: they write).
    anchors: (msgs, ctx) => anchorIdx(msgs, ctx, 40, true),
    "grid+anchors": (msgs, ctx, st) => cap([...gridIdx(msgs, ctx, st, ctx.gridTok), ...anchorIdx(msgs, ctx, 40, true)], msgs),
    "anchors(newest 3)": (msgs, ctx) => anchorIdx(msgs, ctx, 3, true),
    every: (msgs) => cap(msgs.map((m, i) => (i > 0 && markable(m) ? i : -1)).filter((i) => i >= 0), msgs),
};

function cap(idx, msgs, limit = 40) {
    const u = [...new Set(idx)].sort((a, b) => a - b);
    if (u.length <= limit) return u;
    return [...u.slice(0, 2), ...u.slice(u.length - (limit - 2))];
}

function anchorIdx(msgs, ctx, limit, toolOk = false) {
    const ok = (m) => markable(m) || (toolOk && (m.role === "carrier" || m.role === "tool"));
    const pos = new Map(msgs.map((m, i) => [m.id, i]));
    const out = [];
    for (const f of ctx.folds) {
        // last visible markable message before the folded range (original order)
        let best = -1;
        for (const id of ctx.order) {
            if (id === f.firstId) break;
            const i = pos.get(id);
            if (i !== undefined && ok(msgs[i]) && i > 0) best = i;
        }
        if (best >= 0) out.push(best);
    }
    return cap(out, msgs, limit);
}

function gridIdx(msgs, ctx, st, G) {
    st.sticky ??= new Set();
    const pos = new Map(msgs.map((m, i) => [m.id, i]));
    for (const id of [...st.sticky]) if (!pos.has(id)) st.sticky.delete(id);
    let last = msgs[0].tok, t = 0;
    for (let i = 0; i < msgs.length; i++) {
        t += msgs[i].tok;
        if (st.sticky.has(msgs[i].id)) last = t;
        else if (i > 0 && markable(msgs[i]) && t - last >= G && i < msgs.length - 1) { st.sticky.add(msgs[i].id); last = t; }
    }
    return cap([...st.sticky].map((id) => pos.get(id)), msgs, 38);
}

function simulateResponses(reqs, strategy, ctx) {
    const cache = new Set();
    const st = {};
    let cost = 0, readTok = 0, inTok = 0, writes = 0;
    const perFold = [];
    for (const rq of reqs) {
        const { msgs } = rq;
        const P = new PrefixIndex(msgs);
        const explicit = RESP[strategy](msgs, { ...ctx, folds: rq.folds, order: rq.order }, st);
        const last = msgs.length - 1;
        let implicitAt = last;
        while (implicitAt > 0 && !isEligibleEnding(msgs, implicitAt)) implicitAt--;
        // lookup candidates
        const cands = new Set([...explicit.slice(0, 2), ...explicit.slice(-50), implicitAt, 0]);
        let seen = 0;
        for (let i = implicitAt - 1; i >= 0 && seen < 20; i--) if (isEligibleEnding(msgs, i)) { cands.add(i); seen++; }
        let read = 0;
        for (const i of cands) if (cache.has(P.keys[i])) read = Math.max(read, P.ends[i]);
        // writes: implicit + explicit, at most 4 new
        let w = 0;
        for (const i of [implicitAt, ...explicit.slice().reverse()]) {
            if (w >= 4) break;
            if (!cache.has(P.keys[i])) { cache.add(P.keys[i]); w++; }
        }
        writes += w;
        const total = P.ends[last];
        cost += read * READ + (total - read) * WRITE;
        readTok += read; inTok += total;
        if (rq.afterFold) perFold.push({ total, read, lcp: rq.lcp, folded: rq.afterFold });
    }
    return { cost, readTok, inTok, writes, perFold };
}

// Ideal: every request reads its full longest common prefix with the previous
// request (the most any marker layout can read).
function simulateIdeal(reqs) {
    let cost = 0;
    for (const rq of reqs) { const total = rq.msgs.reduce((s, m) => s + m.tok, 0); cost += rq.lcp * READ + (total - rq.lcp) * WRITE; }
    return cost;
}

// ── Anthropic model (Haiku/Opus): 4 marks; pi holds system + tools + tail ───

const ANTH = {
    // pi: system (dev) + last tool (counts as a slot, covers nothing new) + tail.
    pi: (msgs) => ({ marks: [0, msgs.length - 1], slots: 3 }),
    // PR #10: the free 4th slot on the newest fold anchor.
    "pi+anchor": (msgs, ctx) => ({ marks: [0, ...newestAnchor(msgs, ctx, 1), msgs.length - 1], slots: 4 }),
    // Reclaim pi's tool mark (the system mark already covers the tools): two anchors.
    "reclaim:2anchors": (msgs, ctx) => ({ marks: [0, ...newestAnchor(msgs, ctx, 2), msgs.length - 1], slots: 4 }),
};
function newestAnchor(msgs, ctx, k) {
    const pos = new Map(msgs.map((m, i) => [m.id, i]));
    const out = [];
    for (const f of [...ctx.folds].reverse()) {
        let best = -1;
        for (const id of ctx.order) { if (id === f.firstId) break; const i = pos.get(id); if (i !== undefined && i > 0) best = i; }
        if (best >= 0 && !out.includes(best)) out.push(best);
        if (out.length >= k) break;
    }
    return out;
}
function simulateAnthropic(reqs, strategy) {
    const cache = new Set();
    let cost = 0;
    for (const rq of reqs) {
        const { msgs } = rq;
        const P = new PrefixIndex(msgs);
        const { marks } = ANTH[strategy](msgs, { folds: rq.folds, order: rq.order });
        let read = 0;
        for (const mk of marks) for (let i = mk; i >= Math.max(0, mk - 20); i--) if (cache.has(P.keys[i])) { read = Math.max(read, P.ends[i]); break; }
        for (const mk of marks) cache.add(P.keys[mk]);
        const total = P.ends[msgs.length - 1];
        cost += read * READ + (total - read) * WRITE;
    }
    return { cost };
}

// ── Session driver ──────────────────────────────────────────────────────────

function runSession(sc, seed) {
    const r = rng(seed);
    const dev = { id: "dev", role: "dev", tok: 9000 };
    let visible = [dev];
    const order = ["dev"]; // original order of every message ever seen (for anchors)
    const folds = []; // { firstId, ids }
    const reqs = [];
    let prev = null;
    let lastFoldCtx = 9000;
    let cid = 0;
    const tok = () => visible.reduce((s, m) => s + m.tok, 0);
    const push = (afterFold = 0) => {
        const msgs = visible.slice();
        let lcp = 0;
        if (prev) { let t = 0; for (let i = 0; i < Math.min(prev.length, msgs.length); i++) { if (prev[i].id !== msgs[i].id) break; t += msgs[i].tok; lcp = t; } }
        reqs.push({ msgs, lcp, afterFold, folds: folds.map((f) => ({ ...f })), order: order.slice() });
        prev = msgs;
    };
    const add = (m) => { visible.push(m); order.push(m.id); };
    let pendingFold = 0;
    let foldEvents = 0;
    for (const ev of sessionEvents(r, sc)) {
        if (ev.kind === "user") {
            add(ev.msg);
            if (sc.keepFirstUser && !sc.firstUserId) sc.firstUserId = ev.msg.id;
            push(pendingFold); pendingFold = 0;
        } else if (ev.kind === "round") {
            for (const m of ev.msgs) add(m);
            push(pendingFold); pendingFold = 0;
            // nudge: growth since the last fold
            if (tok() >= sc.minFoldCtx && tok() - lastFoldCtx >= sc.growth) {
                pendingFold = foldNow();
            }
        } else add(ev.msg);
    }
    return { reqs, folds: foldEvents };

    function foldNow() {
        let rs = ranges(visible, sc);
        if (!rs.length) return 0;
        const eligible = rs.reduce((s, x) => s + x.tok, 0);
        // agent folds oldest-first until it has taken `take` of the eligible tokens
        let pick = [];
        if (sc.order === "newest") rs = rs.slice().reverse();
        let acc = 0;
        for (const x of rs) {
            if (acc >= eligible * sc.take) break;
            if (sc.skip && r() < sc.skip) continue;
            pick.push(x); acc += x.tok;
        }
        if (!pick.length) return 0;
        let folded = 0;
        const summaries = [];
        for (const x of pick) {
            const ids = new Set(x.ids);
            folded += x.tok;
            folds.push({ firstId: x.ids[0], ids: x.ids });
            const sumTok = Math.max(300, Math.round(x.tok * 0.05));
            summaries.push({ at: x.ids[0], ids, sumTok });
        }
        const allIds = new Set(pick.flatMap((x) => x.ids));
        const next = [];
        for (const m of visible) {
            const s = summaries.find((s) => s.at === m.id);
            if (s && sc.layout === "inplace") { const sm = { id: `s${++cid}`, role: "summary", tok: s.sumTok }; next.push(sm); order.splice(order.indexOf(m.id), 0, sm.id); }
            if (!allIds.has(m.id)) next.push(m);
        }
        visible = next;
        // compress pair at the tail
        const sumTotal = summaries.reduce((s, x) => s + x.sumTok, 0);
        add({ id: `cc${++cid}`, role: "carrier-call", tok: 200 + 40 * pick.length });
        add({ id: `cr${++cid}`, role: "carrier", tok: sc.layout === "inplace" ? 60 : sumTotal });
        // optional merge: every Nth fold, the two oldest carriers are rewritten as one
        foldEvents++;
        if (sc.mergeEvery && foldEvents % sc.mergeEvery === 0) {
            const carriers = visible.filter((m) => m.role === "carrier" || m.role === "summary");
            if (carriers.length >= 2) {
                const [a, b] = carriers;
                const merged = { ...a, id: `m${++cid}`, tok: Math.round((a.tok + b.tok) * 0.8) };
                visible = visible.filter((m) => m !== b).map((m) => (m === a ? merged : m));
                order.splice(order.indexOf(a.id), 1, merged.id);
            }
        }
        lastFoldCtx = tok();
        return folded;
    }
}

// ── Scenarios ───────────────────────────────────────────────────────────────

const BASE = { turns: 60, userMedian: 300, roundsMedian: 8, toolMedian: 1200, growth: 50000, minFoldCtx: 80000, take: 0.8, order: "oldest", layout: "plugin" };
const SCENARIOS = {
    "A forward folds (typical)": { ...BASE },
    "B agent skips 30% of ranges": { ...BASE, skip: 0.3 },
    "C summary merges": { ...BASE, mergeEvery: 3 },
    "D protected head (task + skill kept)": { ...BASE, keepFirstUser: true, protectHeadTool: true },
    "E chatty (short turns)": { ...BASE, turns: 150, roundsMedian: 2, userMedian: 500 },
    "F in-place summaries (what-if)": { ...BASE, layout: "inplace" },
    "G in-place + skips (what-if)": { ...BASE, layout: "inplace", skip: 0.3 },
};

const STRATS = Object.keys(RESP);
const results = {};
for (const [name, sc0] of Object.entries(SCENARIOS)) {
    const agg = { none: 0, ideal: 0, folds: 0, reqs: 0, lcpShare: 0, nFold: 0 };
    for (const s of STRATS) agg[s] = 0;
    for (const s of Object.keys(ANTH)) agg[`anth:${s}`] = 0;
    agg["anth:ideal"] = 0;
    for (let k = 0; k < SEEDS; k++) {
        HS = new Map(); HN = 0;
        const sc = { ...sc0 };
        const { reqs, folds } = runSession(sc, SEED * 1000 + k);
        agg.folds += folds; agg.reqs += reqs.length;
        const ideal = simulateIdeal(reqs);
        agg.ideal += ideal; agg["anth:ideal"] += ideal;
        for (const s of STRATS) agg[s] += simulateResponses(reqs, s, { gridTok: 8000 }).cost;
        for (const s of Object.keys(ANTH)) agg[`anth:${s}`] += simulateAnthropic(reqs, s).cost;
        for (const rq of reqs) if (rq.afterFold) {
            const total = rq.msgs.reduce((s, m) => s + m.tok, 0);
            agg.lcpShare += rq.lcp / total; agg.nFold++;
        }
    }
    results[name] = agg;
}

if (JSON_OUT) { console.log(JSON.stringify(results, null, 2)); process.exit(0); }

const pct = (x, base, ideal) => (base - ideal > 0 ? `${Math.round((100 * (base - x)) / (base - ideal))}%` : "-");
for (const [name, a] of Object.entries(results)) {
    const base = a.none;
    console.log(`\n${name}: ${(a.folds / SEEDS).toFixed(1)} folds, ${Math.round(a.reqs / SEEDS)} requests per session; stable prefix after a fold = ${(100 * a.lcpShare / a.nFold).toFixed(1)}% of the request`);
    console.log(`  Responses (cost in M uncached-input-token units per session, gap closed vs ideal):`);
    for (const s of ["none", ...STRATS.filter((s) => s !== "none"), "ideal"]) {
        const v = s === "ideal" ? a.ideal : a[s];
        console.log(`    ${s.padEnd(14)} ${(v / SEEDS / 1e6).toFixed(3)}  ${s === "none" ? "" : pct(v, base, a.ideal)}`);
    }
    const ab = a["anth:pi"];
    console.log(`  Anthropic:`);
    for (const s of [...Object.keys(ANTH), "ideal"]) {
        const v = a[`anth:${s}`];
        console.log(`    ${s.padEnd(18)} ${(v / SEEDS / 1e6).toFixed(3)}  ${s === "pi" ? "" : pct(v, ab, a["anth:ideal"])}`);
    }
}
