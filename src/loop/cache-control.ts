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

/**
 * Fold anchors: cache breakpoints that survive the next fold.
 *
 * A fold removes a range from the middle of the view. Every cache entry the
 * provider holds sits at a breakpoint the client placed earlier, and those
 * all sit after the folded range, so the request after a fold re-reads only
 * the system head and re-writes the rest. Folds mostly move forward through
 * the history, so the last visible message before a folded range is a prefix
 * that later folds leave byte-identical. A breakpoint there is written once
 * after the fold and read back after later ones.
 *
 * One anchor per active block, newest block first, deduplicated, at most
 * `limit`; over the cap the two oldest stay (the provider always checks the
 * first two breakpoints) and the newest fill the rest. Anthropic has room for one (the newest); Copilot Terra keeps old
 * breakpoints findable (first 2 + latest 50) and re-sending them is free, so
 * it carries many, which also covers a fold that reaches back past the
 * previous one. The breakpoint field is not part of the cached bytes, so an
 * anchor that disappears (its block merged away) does not break the prefix.
 *
 * Stateless: derived from the active blocks every request.
 */
export function foldAnchorMessageIds(
    originalMessages: readonly { id?: string; role?: string; contentType?: string }[],
    processed: readonly { id?: string }[],
    blocks: readonly { active: boolean; createdAt: number; effectiveMessageIds: readonly string[] }[],
    limit: number,
    accept: (message: { id?: string; role?: string; contentType?: string }) => boolean = () => true,
): string[] {
    const active = blocks.filter((block) => block.active && block.effectiveMessageIds.length > 0);
    if (active.length === 0 || limit <= 0) return [];
    const blocksByBase = new Map<string, number[]>();
    active.forEach((block, index) => {
        for (const id of block.effectiveMessageIds) {
            const base = baseIdOf(id);
            const list = blocksByBase.get(base);
            if (list) list.push(index);
            else blocksByBase.set(base, [index]);
        }
    });
    const visible = new Set(processed.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0));
    const anchorOf = new Map<number, string | undefined>();
    let last: string | undefined;
    for (const message of originalMessages) {
        const id = message.id;
        if (typeof id !== "string" || id.length === 0) continue;
        // A covered message the view still renders (the kernel can keep one,
        // such as the first user message) is not where the range starts.
        if (!visible.has(id)) {
            for (const index of blocksByBase.get(baseIdOf(id)) ?? []) {
                if (!anchorOf.has(index)) anchorOf.set(index, last);
            }
        }
        if (visible.has(id) && accept(message)) last = id;
    }
    const order = active.map((block, index) => ({ createdAt: block.createdAt, index })).sort((a, b) => b.createdAt - a.createdAt || b.index - a.index);
    const all: string[] = [];
    for (const { index } of order) {
        const anchor = anchorOf.get(index);
        if (anchor !== undefined && !all.includes(anchor)) all.push(anchor);
    }
    if (all.length <= limit) return all;
    // Over the cap: keep the two oldest (the provider always checks the first
    // two breakpoints) and fill the rest with the newest.
    const keepOldest = limit > 2 ? 2 : 0;
    return [...all.slice(0, limit - keepOldest), ...all.slice(all.length - keepOldest)];
}

/** The newest fold's anchor alone (see foldAnchorMessageIds). */
export function foldAnchorMessageId(
    originalMessages: readonly { id?: string; role?: string }[],
    processed: readonly { id?: string }[],
    blocks: readonly { active: boolean; createdAt: number; effectiveMessageIds: readonly string[] }[],
    accept?: (message: { id?: string; role?: string }) => boolean,
): string | undefined {
    const newest = blocks.reduce<(typeof blocks)[number] | undefined>((best, block) => (block.active && block.effectiveMessageIds.length > 0 && (best === undefined || block.createdAt >= best.createdAt) ? block : best), undefined);
    if (newest === undefined) return undefined;
    return foldAnchorMessageIds(originalMessages, processed, [newest], 1, accept)[0];
}

const ANTHROPIC_BREAKPOINT_LIMIT = 4;

type TtlTally = { count: number; long: boolean; short: boolean };

function tallyMark(tally: TtlTally, mark: unknown): void {
    if (!mark) return;
    tally.count++;
    if ((mark as { ttl?: unknown }).ttl === "1h") tally.long = true;
    else tally.short = true;
}

function tallyEntries(tally: TtlTally, entries: unknown): void {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) tallyMark(tally, (entry as { cache_control?: unknown } | null)?.cache_control);
}

/**
 * Add the fold anchor to a CLIENT-managed Anthropic mark map (pi and other
 * hosts that place their own cache_control). bili's own cadence
 * (computeAnthropicMessageMarks) is left alone. The anchor is added only when
 * the 4-breakpoint budget across system, tools and messages has room. It
 * takes the client's TTL, and is skipped when the client mixes 1h and 5m
 * marks (a 5m breakpoint may not precede a 1h one, so a wrong guess 400s).
 * Returns the input map unchanged when no anchor applies.
 */
export function withAnthropicFoldAnchor(
    clientMarks: Map<string, unknown>,
    anchorId: string | undefined,
    system: unknown,
    tools: unknown,
): Map<string, unknown> {
    if (knobNoCacheControl() || anchorId === undefined || clientMarks.has(anchorId)) return clientMarks;
    const tally: TtlTally = { count: 0, long: false, short: false };
    tallyEntries(tally, system);
    tallyEntries(tally, tools);
    for (const mark of clientMarks.values()) tallyMark(tally, mark);
    if (tally.count >= ANTHROPIC_BREAKPOINT_LIMIT || (tally.long && tally.short)) return clientMarks;
    const out = new Map(clientMarks);
    out.set(anchorId, tally.long ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" });
    return out;
}

/** The explicit-breakpoint field Copilot's Responses endpoint accepts on an
 *  input content part (verified against Copilot GPT-6.1 Terra). Other
 *  Responses upstreams are not known to accept it, so callers gate on
 *  isCopilotOrigin. */
const RESPONSES_BREAKPOINT = { mode: "explicit" } as const;

export function isCopilotOrigin(origin: string | undefined): boolean {
    if (!origin) return false;
    try {
        const host = new URL(origin).hostname.toLowerCase();
        return host === "githubcopilot.com" || host.endsWith(".githubcopilot.com");
    } catch {
        return false;
    }
}

/** Copilot Terra: how many fold anchors ride at once. The provider keeps the
 *  latest 50 explicit breakpoints findable; 40 leaves headroom for the
 *  client's own. */
export const RESPONSES_FOLD_ANCHOR_LIMIT = 40;

/**
 * Responses counterpart of withAnthropicFoldAnchor: stamp the explicit
 * breakpoint on the last input_text part of each anchor's user item or
 * tool result. The item
 * is found by reference (patchResponsesInput re-emits an unchanged slot's
 * original object), and replaced by a copy so the client's parsed input is
 * never mutated. Returns the input unchanged when the anchor is not a plain
 * user message or tool result, or is not found.
 */
export function withResponsesFoldAnchor<T>(
    items: T[],
    layout: readonly { original: unknown; coreId?: string; coreIds?: string[] }[],
    anchorIds: string | undefined | readonly string[],
): T[] {
    const ids = anchorIds === undefined ? [] : typeof anchorIds === "string" ? [anchorIds] : anchorIds;
    if (knobNoCacheControl()) return items;
    let out = items;
    for (const id of ids) out = stampResponsesAnchor(out, layout, id);
    return out;
}

function stampResponsesAnchor<T>(
    items: T[],
    layout: readonly { original: unknown; coreId?: string; coreIds?: string[] }[],
    anchorId: string,
): T[] {
    const slot = layout.find((s) => s.coreId === anchorId || s.coreIds?.includes(anchorId));
    if (!slot) return items;
    const index = items.indexOf(slot.original as T);
    if (index < 0) return items;
    const item = slot.original as { type?: string; role?: string; content?: unknown; output?: unknown };
    // A tool result (function_call_output) takes the breakpoint on its output
    // parts: Copilot GPT-6 Luna writes an entry there (probe, 2026-10-31).
    // After folds the compress results cluster right after the developer
    // block, so that is where most of the reusable prefix ends.
    const isOutput = item.type === "function_call_output";
    if (!isOutput && ((item.type !== undefined && item.type !== "message") || item.role !== "user")) return items;
    const field = isOutput ? "output" : "content";
    const value = item[field];
    let content: Record<string, unknown>[];
    if (typeof value === "string") {
        content = [{ type: "input_text", text: value }];
    } else if (Array.isArray(value)) {
        content = value as Record<string, unknown>[];
    } else {
        return items;
    }
    let last = -1;
    for (let i = content.length - 1; i >= 0; i--) {
        if (content[i]?.type === "input_text") {
            last = i;
            break;
        }
    }
    if (last < 0 || content[last]!["prompt_cache_breakpoint"] !== undefined) return items;
    const out = [...items];
    out[index] = { ...item, [field]: content.map((part, i) => (i === last ? { ...part, prompt_cache_breakpoint: RESPONSES_BREAKPOINT } : part)) } as T;
    return out;
}
