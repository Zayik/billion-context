import { baseIdOf } from "acp-kernel";
import type { AnthropicRequestBody } from "acp-kernel/wire";
import { noCacheControl as knobNoCacheControl } from "../knobs.js";

/**
 * #1637: Anthropic prompt caching is EXPLICIT — content blocks must carry
 * `cache_control` breakpoints or nothing upstream caches. bili used to emit
 * none, so Anthropic-style upstreams never cached anything bili sent, and
 * relays that breakpoint only the system block left the ENTIRE history
 * re-billing at full price on every request (#1631: cached pinned at the
 * system head, 9–13%, for 40+ requests straight).
 *
 * Both the steady request path (prepareAnthropic) and the compress-loop
 * round-2 rebuild (adapter-anthropic) apply THE SAME marks through the
 * kernel's own `coreToAnthropic(messages, cacheControls)` machinery — one
 * applier, identical bytes on both paths (the dual-builder divergence class
 * the cache matrix pins; see #1554).
 *
 * Cadence: CUMULATIVE incremental breakpoints (Anthropic-recommended). A
 * marked message STAYS marked — removing a mid-history marker mutates that
 * element's bytes on the next request and breaks the byte prefix exactly
 * there. Marks die only by folding (covered messages vanish from the view).
 * Once the cap is reached no NEW marks are added until a fold retires
 * covered ones: a rolling drop would mutate an early element and collapse
 * the LCP. Cap = 3 message marks + 1 system breakpoint = Anthropic's 4-block
 * limit.
 *
 * Client-managed caching wins: any pre-existing cache_control (harvested
 * from the client's messages, present on system blocks, or on tools entries —
 * the 4-breakpoint budget counts all three) suppresses our stamps entirely
 * (pass no marks / return the system unchanged).
 * BILI_NO_CACHE_CONTROL / compat.noCacheControl disables everything.
 */

const MESSAGE_MARK_CAP = 3;

type AnthropicCacheMarks = Map<string, { type: "ephemeral" }>;

export function computeAnthropicMessageMarks(
    processed: { id?: string }[],
    ephemeralTailCount: number,
    session: { metadata: Record<string, unknown> },
): AnthropicCacheMarks {
    const marks = new Map<string, { type: "ephemeral" }>();
    if (knobNoCacheControl()) {
        session.metadata["anthropicCacheMarkIds"] = [];
        return marks;
    }
    if (processed.length === 0 || processed.length <= ephemeralTailCount) {
        session.metadata["anthropicCacheMarkIds"] = [];
        return marks;
    }
    const liveIds = new Set(processed.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0));
    // Retire marks whose messages folded away; keep the survivors' order.
    const kept = ((session.metadata["anthropicCacheMarkIds"] as string[] | undefined) ?? []).filter((id) => liveIds.has(id));
    const lastIndex = processed.length - 1 - ephemeralTailCount;
    const currentId = processed[lastIndex]?.id;
    if (typeof currentId === "string" && currentId.length > 0 && !kept.includes(currentId) && kept.length < MESSAGE_MARK_CAP) {
        kept.push(currentId);
    }
    session.metadata["anthropicCacheMarkIds"] = kept;
    for (const id of kept) marks.set(id, { type: "ephemeral" });
    return marks;
}

/** WC-010: Anthropic's 4-breakpoint budget spans system blocks + tools entries
 *  + message blocks COMBINED; anthropicToCore only harvests messages, so a
 *  tools-only client mark must suppress ours too or the 5th breakpoint 400s. */
export function anthropicToolsCarryCacheControl(tools: unknown): boolean {
    if (!Array.isArray(tools)) return false;
    return tools.some((t) => typeof t === "object" && t !== null && (t as { cache_control?: unknown }).cache_control !== undefined);
}

export function stampAnthropicSystemCacheControl(systemOut: AnthropicRequestBody["system"], ours = true): AnthropicRequestBody["system"] {
    if (knobNoCacheControl()) return systemOut;
    if (!ours) return systemOut;
    if (typeof systemOut === "string" && systemOut.length > 0) {
        // Deterministic string→block conversion (semantically identical for
        // Anthropic; stable across turns). A string system can carry no
        // client cache_control, so conversion never discards one.
        return [{ type: "text", text: systemOut, cache_control: { type: "ephemeral" } }];
    }
    if (!Array.isArray(systemOut) || systemOut.length === 0) return systemOut;
    for (const block of systemOut) {
        if ((block as { cache_control?: unknown }).cache_control) return systemOut;
    }
    // Stamp by replacement, never in place: the array may share block
    // references with the frozen client head (parsed.system), which must stay
    // unmarked (#1085).
    const last = systemOut.length - 1;
    systemOut[last] = { ...systemOut[last], cache_control: { type: "ephemeral" } };
    return systemOut;
}

type AnchorMessage = { id?: string; role?: string; contentType?: string; rawAnthropicBlock?: unknown; rawAnthropicMessage?: unknown };

/**
 * Fold anchors: after a fold, every cache entry the client's own breakpoints
 * wrote sits after the folded range, so the next request re-reads only the
 * system head. A breakpoint on the last visible message before each folded
 * range is a prefix later forward folds leave byte-identical.
 *
 * One anchor per active block, newest first, deduplicated, at most `limit`.
 * Over the cap the two oldest stay (the provider always checks the first two
 * breakpoints) and the newest fill the rest. Stateless: derived every request.
 */
export function foldAnchorMessageIds(
    originalMessages: readonly AnchorMessage[],
    processed: readonly { id?: string }[],
    blocks: readonly { active: boolean; createdAt: number; effectiveMessageIds: readonly string[] }[],
    limit: number,
    accept: (message: AnchorMessage) => boolean = () => true,
): string[] {
    const active = blocks.filter((block) => block.active && block.effectiveMessageIds.length > 0);
    const blocksByBase = new Map<string, number[]>();
    active.forEach((block, index) => {
        for (const id of block.effectiveMessageIds) {
            const base = baseIdOf(id);
            blocksByBase.set(base, [...(blocksByBase.get(base) ?? []), index]);
        }
    });
    const visible = new Set(processed.map((m) => m.id));
    const anchorOf = new Map<number, string | undefined>();
    let last: string | undefined;
    for (const message of originalMessages) {
        const id = message.id;
        if (!id) continue;
        // The range starts at the first message the view drops: the kernel can
        // keep a covered message (the first user message) on the wire.
        if (visible.has(id)) {
            if (accept(message)) last = id;
            continue;
        }
        for (const index of blocksByBase.get(baseIdOf(id)) ?? []) {
            if (!anchorOf.has(index)) anchorOf.set(index, last);
        }
    }
    const order = active.map((block, index) => ({ createdAt: block.createdAt, index })).sort((a, b) => b.createdAt - a.createdAt || b.index - a.index);
    const all: string[] = [];
    for (const { index } of order) {
        const anchor = anchorOf.get(index);
        if (anchor !== undefined && !all.includes(anchor)) all.push(anchor);
    }
    if (all.length <= limit) return all;
    const keepOldest = limit > 2 ? 2 : 0;
    return [...all.slice(0, limit - keepOldest), ...all.slice(all.length - keepOldest)];
}

/** The newest fold's anchor alone (see foldAnchorMessageIds). */
export function foldAnchorMessageId(
    originalMessages: readonly AnchorMessage[],
    processed: readonly { id?: string }[],
    blocks: readonly { active: boolean; createdAt: number; effectiveMessageIds: readonly string[] }[],
    accept?: (message: AnchorMessage) => boolean,
): string | undefined {
    const newest = blocks.reduce<(typeof blocks)[number] | undefined>((best, block) => (block.active && block.effectiveMessageIds.length > 0 && (best === undefined || block.createdAt >= best.createdAt) ? block : best), undefined);
    if (newest === undefined) return undefined;
    return foldAnchorMessageIds(originalMessages, processed, [newest], 1, accept)[0];
}

/**
 * Add the fold anchor to a CLIENT-managed Anthropic mark map (pi), never
 * touching the client's own marks. Added only when the 4-breakpoint budget
 * across system, tools and messages has room. Takes the client's TTL, and is
 * skipped when the client mixes 1h and 5m (a 5m mark may not precede a 1h one).
 */
export function withAnthropicFoldAnchor(
    clientMarks: Map<string, unknown>,
    anchorId: string | undefined,
    system: unknown,
    tools: unknown,
): Map<string, unknown> {
    if (anchorId === undefined || clientMarks.has(anchorId)) return clientMarks;
    const entries = [...(Array.isArray(system) ? system : []), ...(Array.isArray(tools) ? tools : [])] as ({ cache_control?: unknown } | null)[];
    const marks = [...entries.map((entry) => entry?.cache_control), ...clientMarks.values()].filter(Boolean) as { ttl?: unknown }[];
    const long = marks.some((mark) => mark.ttl === "1h");
    if (marks.length >= 4 || (long && marks.some((mark) => mark.ttl !== "1h"))) return clientMarks;
    return new Map(clientMarks).set(anchorId, long ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" });
}

/**
 * Which upstreams get fold anchors, and how. Anything not listed gets none, so
 * a new vendor never sees a marker it was not checked against.
 * - anthropic: Anthropic and Copilot (Claude). One anchor (the 4-mark budget),
 *   on a message the Anthropic encoder can mark: not thinking, not a block it
 *   passes through verbatim.
 * - responses: Copilot only (other Responses hosts may reject the field; the
 *   Codex subscription backend does). Up to 40 anchors, on a user message or
 *   a tool result; Copilot keeps the latest 50 explicit breakpoints findable.
 */
const FOLD_ANCHOR_VENDORS: Record<"anthropic" | "responses", { hosts: string[]; limit: number; accept: (m: AnchorMessage) => boolean }> = {
    anthropic: {
        hosts: ["anthropic.com", "githubcopilot.com"],
        limit: 1,
        accept: (m) => !m.rawAnthropicMessage && (m.contentType === "tool-call" || ((m.contentType === "text" || m.contentType === "tool-result") && !m.rawAnthropicBlock)),
    },
    responses: {
        hosts: ["githubcopilot.com"],
        limit: 40,
        accept: (m) => m.role === "user" || m.contentType === "tool-result",
    },
};

let extraFoldAnchorHosts: string[] = [];
/** Tests: treat these hosts (e.g. 127.0.0.1) as listed vendors. */
export function _setFoldAnchorHostsForTest(hosts: string[]): void {
    extraFoldAnchorHosts = hosts;
}

export function foldAnchorPolicy(wire: "anthropic" | "responses", origin: string | undefined): { limit: number; accept: (m: AnchorMessage) => boolean } | undefined {
    if (!origin || knobNoCacheControl()) return undefined;
    let host: string;
    try {
        host = new URL(origin).hostname.toLowerCase();
    } catch {
        return undefined;
    }
    const vendor = FOLD_ANCHOR_VENDORS[wire];
    const listed = [...vendor.hosts, ...extraFoldAnchorHosts].some((domain) => host === domain || host.endsWith(`.${domain}`));
    return listed ? vendor : undefined;
}

/**
 * Stamp `prompt_cache_breakpoint` on the last input_text part of each anchor's
 * user message item or function_call_output (string content becomes one
 * input_text part). Copilot writes an entry at either; callers gate on
 * foldAnchorPolicy. Items are found by reference in the layout and replaced by
 * copies, so the client's parsed input is never mutated.
 */
export function withResponsesFoldAnchor<T>(
    items: T[],
    layout: readonly { original: unknown; coreId?: string; coreIds?: string[] }[],
    anchorIds: readonly string[],
): T[] {
    let out = items;
    for (const anchorId of anchorIds) {
        const slot = layout.find((s) => s.coreId === anchorId || s.coreIds?.includes(anchorId));
        const index = slot ? out.indexOf(slot.original as T) : -1;
        if (index < 0) continue;
        const item = slot!.original as { type?: string; role?: string; content?: unknown; output?: unknown };
        const isOutput = item.type === "function_call_output";
        if (!isOutput && ((item.type !== undefined && item.type !== "message") || item.role !== "user")) continue;
        const field = isOutput ? "output" : "content";
        const value = item[field];
        const content = typeof value === "string" ? [{ type: "input_text", text: value }] : Array.isArray(value) ? (value as Record<string, unknown>[]) : undefined;
        const last = content?.findLastIndex((part) => part?.type === "input_text") ?? -1;
        if (last < 0 || content![last]!["prompt_cache_breakpoint"] !== undefined) continue;
        out = [...out];
        out[index] = { ...item, [field]: content!.map((part, i) => (i === last ? { ...part, prompt_cache_breakpoint: { mode: "explicit" } } : part)) } as T;
    }
    return out;
}
