import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { rmrf } from "./tmp-rm.ts";

type Message = Record<string, unknown>;
type Fold = { startId: string; endId: string; topic: string; summary: string };
type Sample = { input: number; cached: number; miss: number; stream: string; messages: Message[] };

function commonPrefix(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
}

function textOf(message: Message): string {
    return typeof message.content === "string" ? message.content : "";
}

function syntheticHistory(): Message[] {
    return Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `synthetic-message-${String(i + 1).padStart(2, "0")}:` + String.fromCharCode(65 + i % 26).repeat(i === 2 || i === 3 ? 3350 : 4000),
    }));
}

async function runScenario(name: string, ranges: Array<[number, number]>): Promise<Sample[]> {
    const samples: Sample[] = [];
    const cachedStreams: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string; tools?: unknown; messages: Message[] };
            const stream = [JSON.stringify(body.model), JSON.stringify(body.tools ?? null), ...body.messages.map((m) => JSON.stringify(m))].join("\n");
            const cached = cachedStreams.reduce((best, previous) => Math.max(best, commonPrefix(previous, stream)), 0);
            const sample = { input: stream.length, cached, miss: stream.length - cached, stream, messages: body.messages };
            samples.push(sample);
            cachedStreams.push(stream);
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: ${JSON.stringify({ id: `c${samples.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "synthetic answer" } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ id: `c${samples.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: sample.input, completion_tokens: 2, prompt_tokens_details: { cached_tokens: cached } } })}\n\n`);
            res.end("data: [DONE]\n\n");
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-fold-meter-"));
    const previousState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000, kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
        autoUpdate: false, mitm: { enabled: false, domains: [] }, compat: { roles: {} },
        streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false,
        updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    const conv = `cache-meter-${name}`;
    const history = syntheticHistory();
    const request = async (): Promise<void> => {
        const response = await fetch(`http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "pi-plugin/0.0.1", "x-bili-plugin-conversation": conv },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages: history }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        await response.arrayBuffer();
    };
    try {
        await request();
        await request();
        if (ranges.length > 0) {
            const content: Fold[] = ranges.map(([start, end]) => ({
                startId: `m${String(start).padStart(5, "0")}`,
                endId: `m${String(end).padStart(5, "0")}`,
                topic: `synthetic-${start}-${end}`,
                summary: `Synthetic summary preserves the decisions from messages ${start} through ${end}.`,
            }));
            const response = await fetch(`http://127.0.0.1:${port}/__bili/plugin/tool`, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content } }),
            });
            const result = await response.json() as { ok: boolean; result?: string; error?: string };
            assert.ok(result.ok && result.result && !result.result.includes("[Compression FAILED"), `fold failed: ${result.error ?? result.result}`);
            history.push({ role: "assistant", content: null, tool_calls: [{ id: `cmp-${name}`, type: "function", function: { name: "compress", arguments: JSON.stringify({ content }) } }] });
            history.push({ role: "tool", tool_call_id: `cmp-${name}`, content: result.result });
        }
        await request();
        history.push({ role: "user", content: "synthetic continuation" });
        await request();
        for (let i = 0; i < ranges.length; i++) {
            const response = await fetch(`http://127.0.0.1:${port}/__bili/plugin/tool`, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ conversationId: conv, tool: "decompress", args: { blockId: `b${i + 1}`, full: true } }),
            });
            const result = await response.json() as { ok: boolean; result?: string };
            assert.ok(result.ok && result.result, `${name}: block b${i + 1} is retrievable`);
            for (let index = ranges[i]![0]; index <= ranges[i]![1]; index++) {
                assert.ok(result.result.includes(`synthetic-message-${String(index).padStart(2, "0")}:`), `${name}: original ${index} is retrievable`);
            }
        }
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        if (previousState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previousState;
        rmrf(stateDir);
    }
    return samples;
}

test("real plugin folds against a deterministic prefix-cache meter", { timeout: 120_000 }, async (t) => {
    const early = await runScenario("early", [[3, 4]]);
    const late = await runScenario("late", [[31, 32]]);
    const batch = await runScenario("batch", [[3, 4], [15, 16], [31, 32]]);
    const control = await runScenario("control", []);
    for (const [label, samples, hidden] of [
        ["early", early, [3, 4]], ["late", late, [31, 32]],
        ["batch", batch, [3, 4, 15, 16, 31, 32]], ["control", control, []],
    ] as const) {
        assert.equal(samples.length, 4);
        assert.ok(samples[1]!.cached > samples[1]!.input * 0.99, `${label}: warm baseline`);
        assert.ok(samples[3]!.cached > samples[3]!.input * 0.99, `${label}: new prefix becomes warm`);
        const before = samples[1]!.messages.map(textOf).filter((text) => text.includes("synthetic-message-"));
        const after = samples[2]!.messages.map(textOf).filter((text) => text.includes("synthetic-message-"));
        const expected = before.filter((text) => !hidden.some((index) => text.includes(`synthetic-message-${String(index).padStart(2, "0")}:`)));
        assert.deepEqual(after, expected, `${label}: only requested messages vanish, all others stay byte-identical and ordered`);
        for (const index of hidden) assert.ok(!samples[2]!.stream.includes(`synthetic-message-${String(index).padStart(2, "0")}:`));
        for (let i = 0; i < hidden.length; i += 2) {
            const summary = `Synthetic summary preserves the decisions from messages ${hidden[i]} through ${hidden[i + 1]}.`;
            assert.equal(samples[2]!.stream.split(summary).length - 1, 2, `${label}: summary rides in tool call and receipt`);
        }
        t.diagnostic(`${label}: pre=${samples[1]!.input}, fold=${samples[2]!.input}, cached=${samples[2]!.cached}, miss=${samples[2]!.miss}, nextCached=${samples[3]!.cached}, nextInput=${samples[3]!.input}`);
    }
    assert.ok(early[2]!.miss > 100_000, "small old fold invalidates a long warm suffix");
    assert.ok(late[2]!.miss < early[2]!.miss / 2, "a later fold preserves more of the prefix");
    assert.ok(batch[2]!.miss < early[2]!.miss * 1.1, "one batch shares the earliest changed prefix");
    assert.ok(control[2]!.miss < 1000, "no-fold control stays warm");
});

test("markers cannot reuse a suffix behind a changed prefix", () => {
    const original = "stable-head|old-context|unchanged-suffix|marker";
    const changed = "stable-head|summary|unchanged-suffix|marker";
    const cached = commonPrefix(original, changed);
    assert.equal(cached, "stable-head|".length);
    assert.equal(commonPrefix(original + "|second-marker", changed + "|second-marker"), cached);
    assert.equal(commonPrefix(original, original + "|new-tail"), original.length);
});
