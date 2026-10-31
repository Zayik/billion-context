import assert from "node:assert";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startServer } from "../src/server.ts";
import { rmrf } from "./tmp-rm.ts";
import { foldAnchorMessageId, foldAnchorMessageIds, isCopilotOrigin, withAnthropicFoldAnchor, withResponsesFoldAnchor } from "../src/loop/cache-control.ts";

// Fold anchor: after a fold, every provider cache entry sits after the folded
// range, so the next request re-reads only the system head. One breakpoint
// on the last visible message before the newest folded range is a prefix the
// next (forward-moving) fold leaves byte-identical, so it is read back then.

const msgs = (...ids: string[]) => ids.map((id) => ({ id, role: id.startsWith("a") ? "assistant" : "user" }));
const block = (createdAt: number, ids: string[], active = true) => ({ active, createdAt, effectiveMessageIds: ids });

test("fold anchor: no active fold means no anchor", () => {
    const original = msgs("u1", "a1", "u2");
    assert.equal(foldAnchorMessageId(original, original, []), undefined);
    assert.equal(foldAnchorMessageId(original, original, [block(1, ["a1"], false)]), undefined);
});

test("fold anchor: last visible message before the newest folded range", () => {
    const original = msgs("u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4", "u5");
    // Older fold covered a1..u2; newest covered u3..a3.
    const blocks = [block(1, ["a1", "u2"]), block(2, ["u3", "a3"])];
    const processed = msgs("u1", "a2", "u4", "a4", "u5");
    assert.equal(foldAnchorMessageId(original, processed, blocks), "a2");
});

test("fold anchor: sub-id projections of a covered message count as covered", () => {
    const original = [{ id: "u1", role: "user" }, { id: "a1#r0", role: "assistant" }, { id: "a1#call", role: "assistant" }, { id: "u2", role: "user" }];
    const processed = [{ id: "u1" }, { id: "u2" }];
    assert.equal(foldAnchorMessageId(original, processed, [block(1, ["a1"])]), "u1");
});

test("fold anchor: the accept filter walks back to an allowed message", () => {
    const original = msgs("u1", "a1", "u2", "a2");
    const processed = msgs("u1", "a1", "a2");
    assert.equal(foldAnchorMessageId(original, processed, [block(1, ["u2"])]), "a1");
    assert.equal(foldAnchorMessageId(original, processed, [block(1, ["u2"])], (m) => m.role === "user"), "u1");
});

test("fold anchor: a range at the very start has no anchor", () => {
    const original = msgs("u1", "a1", "u2");
    assert.equal(foldAnchorMessageId(original, msgs("u2"), [block(1, ["u1", "a1"])]), undefined);
});

test("fold anchor: a covered message the view still renders is not the range start", () => {
    // The kernel kept u1 visible although the fold covered it: anchor on u1.
    const original = msgs("u1", "a1", "u2", "a2", "u3");
    assert.equal(foldAnchorMessageId(original, msgs("u1", "a2", "u3"), [block(1, ["u1", "a1", "u2"])]), "u1");
});

test("fold anchors: one per active fold, newest first, deduplicated and capped", () => {
    const original = msgs("u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4", "u5");
    // Three folds: a1 (oldest), u3..a3 (newest), u4 (middle, after the newest in position).
    const blocks = [block(1, ["a1"]), block(3, ["u3", "a3"]), block(2, ["u4"]), block(4, ["x9"], false)];
    const processed = msgs("u1", "u2", "a2", "a4", "u5");
    assert.deepEqual(foldAnchorMessageIds(original, processed, blocks, 10), ["a2", "u1"], "u4's anchor is a2 too (u3..a3 hidden), so it dedups");
    assert.deepEqual(foldAnchorMessageIds(original, processed, blocks, 1), ["a2"]);
    assert.deepEqual(foldAnchorMessageIds(original, processed, blocks, 10, (m) => m.role === "user"), ["u2", "u1"]);
    assert.deepEqual(foldAnchorMessageIds(original, processed, [], 10), []);
});

test("fold anchors: over the cap, the two oldest stay and the newest fill the rest", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `u${i + 1}`);
    const original = ids.map((id) => ({ id, role: "user" }));
    // Fold every even message; each anchor is the odd message just before it.
    const blocks = ids.filter((_, i) => i % 2 === 1).map((id, k) => block(k + 1, [id]));
    const processed = original.filter((_, i) => i % 2 === 0);
    assert.deepEqual(foldAnchorMessageIds(original, processed, blocks, 10), ["u11", "u9", "u7", "u5", "u3", "u1"]);
    assert.deepEqual(foldAnchorMessageIds(original, processed, blocks, 4), ["u11", "u9", "u3", "u1"]);
    assert.deepEqual(foldAnchorMessageIds(original, processed, blocks, 2), ["u11", "u9"]);
});

test("anthropic fold anchor: added within the 4-breakpoint budget, client marks kept", () => {
    const client = new Map<string, unknown>([["u9", { type: "ephemeral" }]]);
    const system = [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }];
    const out = withAnthropicFoldAnchor(client, "a2", system, []);
    assert.notEqual(out, client, "input map is never mutated");
    assert.deepEqual([...out.entries()], [["u9", { type: "ephemeral" }], ["a2", { type: "ephemeral" }]]);
    assert.equal(client.size, 1);
});

test("anthropic fold anchor: skipped when the budget is full, no anchor, or already marked", () => {
    const system = [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }];
    const tools = [{ name: "t", cache_control: { type: "ephemeral" } }];
    const full = new Map<string, unknown>([["u8", { type: "ephemeral" }], ["u9", { type: "ephemeral" }]]);
    assert.equal(withAnthropicFoldAnchor(full, "a2", system, tools), full);
    const one = new Map<string, unknown>([["u9", { type: "ephemeral" }]]);
    assert.equal(withAnthropicFoldAnchor(one, undefined, system, tools), one);
    assert.equal(withAnthropicFoldAnchor(one, "u9", system, tools), one);
});

test("anthropic fold anchor: copies a uniform 1h TTL, skips mixed TTLs", () => {
    const long = new Map<string, unknown>([["u9", { type: "ephemeral", ttl: "1h" }]]);
    assert.deepEqual(withAnthropicFoldAnchor(long, "a2", [], []).get("a2"), { type: "ephemeral", ttl: "1h" });
    const system = [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }];
    const mixed = new Map<string, unknown>([["u9", { type: "ephemeral" }]]);
    assert.equal(withAnthropicFoldAnchor(mixed, "a2", system, []), mixed);
});

test("anthropic fold anchor: BILI_NO_CACHE_CONTROL disables it", () => {
    process.env.BILI_NO_CACHE_CONTROL = "1";
    try {
        const client = new Map<string, unknown>([["u9", { type: "ephemeral" }]]);
        assert.equal(withAnthropicFoldAnchor(client, "a2", [], []), client);
    } finally {
        delete process.env.BILI_NO_CACHE_CONTROL;
    }
});

test("responses fold anchor: explicit breakpoint on the last input_text of the anchor item, by copy", () => {
    const anchorItem = { type: "message", role: "user", content: [{ type: "input_text", text: "first" }, { type: "input_image", image_url: "x" }, { type: "input_text", text: "last" }] };
    const other = { type: "message", role: "user", content: "tail" };
    const items = [anchorItem, other];
    const layout = [{ original: anchorItem, coreId: "u1" }, { original: other, coreId: "u2" }];
    const out = withResponsesFoldAnchor(items, layout, "u1");
    assert.notEqual(out, items);
    assert.deepEqual(out[0], { type: "message", role: "user", content: [{ type: "input_text", text: "first" }, { type: "input_image", image_url: "x" }, { type: "input_text", text: "last", prompt_cache_breakpoint: { mode: "explicit" } }] });
    assert.equal(out[1], other);
    assert.equal((anchorItem.content[2] as Record<string, unknown>)["prompt_cache_breakpoint"], undefined, "client item never mutated");
});

test("responses fold anchors: several items stamped in one pass", () => {
    const a = { type: "message", role: "user", content: "a" };
    const b = { type: "message", role: "user", content: "b" };
    const c = { type: "message", role: "user", content: "c" };
    const layout = [{ original: a, coreId: "u1" }, { original: b, coreId: "u2" }, { original: c, coreId: "u3" }];
    const out = withResponsesFoldAnchor([a, b, c], layout, ["u3", "u1", "missing"]);
    const bp = { mode: "explicit" };
    assert.deepEqual(out, [
        { type: "message", role: "user", content: [{ type: "input_text", text: "a", prompt_cache_breakpoint: bp }] },
        b,
        { type: "message", role: "user", content: [{ type: "input_text", text: "c", prompt_cache_breakpoint: bp }] },
    ]);
});

test("responses fold anchor: string content becomes one input_text part", () => {
    const anchorItem = { role: "user", content: "hello" };
    const out = withResponsesFoldAnchor([anchorItem], [{ original: anchorItem, coreIds: ["u1#p0", "u1#p1"], coreId: "u1#p0" }], "u1#p1");
    assert.deepEqual(out[0], { role: "user", content: [{ type: "input_text", text: "hello", prompt_cache_breakpoint: { mode: "explicit" } }] });
});

test("responses fold anchor: a tool result takes the breakpoint on its output", () => {
    const bp = { mode: "explicit" };
    const str = { type: "function_call_output", call_id: "c1", output: "summary text" };
    const arr = { type: "function_call_output", call_id: "c2", output: [{ type: "input_text", text: "one" }, { type: "input_image", image_url: "x" }] };
    const layout = [{ original: str, coreId: "t1" }, { original: arr, coreId: "t2" }];
    const out = withResponsesFoldAnchor([str, arr], layout, ["t1", "t2"]);
    assert.deepEqual(out[0], { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "summary text", prompt_cache_breakpoint: bp }] });
    assert.deepEqual(out[1], { type: "function_call_output", call_id: "c2", output: [{ type: "input_text", text: "one", prompt_cache_breakpoint: bp }, { type: "input_image", image_url: "x" }] });
    assert.equal(typeof str.output, "string", "client item never mutated");
});

test("responses fold anchor: unchanged when the anchor is missing, rebuilt, or not a user message", () => {
    const user = { type: "message", role: "user", content: "hi" };
    const dev = { type: "message", role: "developer", content: "d" };
    const items = [user, dev];
    const layout = [{ original: user, coreId: "u1" }, { original: dev, coreId: "d1" }];
    assert.equal(withResponsesFoldAnchor(items, layout, undefined), items);
    assert.equal(withResponsesFoldAnchor(items, layout, "zz"), items);
    assert.equal(withResponsesFoldAnchor(items, layout, "d1"), items);
    // The slot was rebuilt (a different object rides the input): leave it.
    assert.equal(withResponsesFoldAnchor([{ ...user }, dev], layout, "u1")[0]!.content, "hi");
});

test("isCopilotOrigin: only githubcopilot.com hosts", () => {
    assert.equal(isCopilotOrigin("https://api.githubcopilot.com"), true);
    assert.equal(isCopilotOrigin("https://api.enterprise.githubcopilot.com/v1"), true);
    assert.equal(isCopilotOrigin("https://api.openai.com"), false);
    assert.equal(isCopilotOrigin("https://githubcopilot.com.evil.example"), false);
    assert.equal(isCopilotOrigin(undefined), false);
    assert.equal(isCopilotOrigin("not a url"), false);
});

// End to end, Anthropic wire, pi plugin mode with client-managed marks
// (system + last message, the pi-ai cadence): after a plugin-API fold of
// m00003..m00004, the next upstream body carries one extra breakpoint on
// m00002 (the last visible message before the folded range), and stays
// within the 4-breakpoint budget.
const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore. ".repeat(30);
type Item = { role: "user" | "assistant"; text: string } | { pair: { id: string; args: unknown; result: string } };

function anthropicBody(items: Item[]): Record<string, unknown> {
    const messages = items.flatMap((it): Record<string, unknown>[] => "pair" in it
        ? [
            { role: "assistant", content: [{ type: "tool_use", id: it.pair.id, name: "compress", input: it.pair.args }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: it.pair.id, content: it.pair.result }] },
        ]
        : [{ role: it.role, content: [{ type: "text", text: it.text }] }]);
    const last = messages[messages.length - 1] as { content: Record<string, unknown>[] };
    last.content = last.content.map((b, i) => (i === last.content.length - 1 ? { ...b, cache_control: { type: "ephemeral" } } : b));
    return { model: "claude-test", max_tokens: 1024, stream: true, system: [{ type: "text", text: "You are a test agent.", cache_control: { type: "ephemeral" } }], messages };
}

function sse(): string[] {
    const ev = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
    return [
        ev("message_start", { type: "message_start", message: { id: "msg_p", role: "assistant", usage: { input_tokens: 55 } } }),
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
        ev("content_block_stop", { type: "content_block_stop", index: 0 }),
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
        ev("message_stop", { type: "message_stop" }),
    ];
}

function markedTexts(raw: string): string[] {
    const body = JSON.parse(raw) as { messages: { content: unknown }[] };
    const out: string[] = [];
    for (const m of body.messages) {
        if (!Array.isArray(m.content)) continue;
        for (const b of m.content as Record<string, unknown>[]) {
            if (b.cache_control) out.push(/\b([qa]\d+) lorem/.exec(String(b.text ?? ""))?.[1] ?? String(b.type));
        }
    }
    return out;
}

test("anthropic fold anchor e2e: a plugin fold adds one breakpoint before the folded range", async () => {
    const captured: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push(Buffer.concat(chunks).toString());
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const line of sse()) res.write(line);
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-anchor-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const conv = `fold-anchor-${Date.now().toString(36)}`;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
    const send = async (hist: Item[]) => {
        const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "pi-plugin/0.0.1", "x-bili-plugin-conversation": conv }, body: JSON.stringify(anthropicBody(hist)) });
        assert.equal(r.status, 200, (await r.clone().text()).slice(0, 300));
        await r.arrayBuffer();
    };
    try {
        const hist: Item[] = [];
        for (let i = 1; i <= 9; i++) {
            if (i > 1) hist.push({ role: "assistant", text: `a${i - 1} ${filler}` });
            hist.push({ role: "user", text: `q${i} ${filler}` });
            await send(hist);
            assert.deepEqual(markedTexts(captured.at(-1)!), [`q${i}`], "before any fold only the client's own marks ride");
        }
        hist.push({ role: "assistant", text: `a9 ${filler}` });
        const args = { content: [{ startId: "m00003", endId: "m00004", topic: "ANCHOR", summary: "Folded the second question and its answer; nothing in that exchange needs to be kept verbatim." }] };
        const r = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conv, tool: "compress", args }) });
        const j = (await r.json()) as { ok: boolean; result?: string; error?: string };
        assert.ok(j.ok && !j.result?.includes("FAILED"), `compress rejected: ${j.error ?? j.result}`);
        hist.push({ pair: { id: "cmp_1", args, result: j.result! } }, { role: "user", text: `q10 ${filler}` });
        await send(hist);
        const after = captured.at(-1)!;
        assert.ok(!after.includes("q2 lorem"), "the folded range is gone from the view");
        assert.deepEqual(markedTexts(after), ["a1", "q10"], "anchor on a1 (m00002) plus the client's tail mark");
        const sys = (JSON.parse(after) as { system: Record<string, unknown>[] }).system.filter((b) => b.cache_control).length;
        assert.ok(sys + 2 <= 4, "within the 4-breakpoint budget");
        hist.push({ role: "assistant", text: `a10 ${filler}` }, { role: "user", text: `q11 ${filler}` });
        await send(hist);
        assert.deepEqual(markedTexts(captured.at(-1)!), ["a1", "q11"], "the anchor holds still until the next fold");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(stateDir);
    }
});
