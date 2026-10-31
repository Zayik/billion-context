// #5222 Phase 2: persistent process-local resolver wedge — detection + visibility.
// Owner decision 2026-10-31: NO self-restart ("bili does not kill itself") — when a
// long-lived proxy's main-thread DNS pool wedges after an OS-level network change
// (WSL/VPN switch), DETECT it and SURFACE it (panel banner + /__bili/status) instead.
// Process behavior is unchanged: this module only records evidence and reports.
//
// Triple gate (all required, per owner spec):
//   G1 — at least WEDGE_MIN_HOSTS distinct hosts are failing;
//   G2 — each such host resolved successfully RECENTLY (last success within
//        WEDGE_SUCCESS_RECENCY_MS) — proves the names are alive and the regression
//        is on the resolver side, not dead domains;
//   G3 — each such host has been failing CONTINUOUSLY for at least WEDGE_SUSTAIN_MS
//        (no success since) — filters transient blips.
//
// Evidence source: tunnel-admission MAIN-pool outcomes (one record per
// checkTunnelDestination). Outbound undici connects resolve inside libuv and are not
// observable here — admission is this process's only resolver observation point. The
// worker-thread probe (#5222 Phase 1) mitigates admission but does NOT heal the pool
// (outbound connects still use the wedged pool), so detector evidence stays on the
// main-pool outcome even when the worker stage admitted the request.

import { log as loggerLog } from "./logger.js";

export interface ResolverWedgeStatus {
    wedged: boolean;
    hosts: string[];
    detectedAt: number | null;
}

interface HostState {
    /** Epoch ms of the last successful resolution in this process; 0 = never succeeded. */
    lastSuccessAt: number;
    /** Epoch ms when the current consecutive-failure streak began; 0 = not failing now. */
    streakStartAt: number;
}

const WEDGE_MIN_HOSTS = 2;
const WEDGE_SUSTAIN_MS = 5 * 60_000;
const WEDGE_SUCCESS_RECENCY_MS = 24 * 60 * 60_000;
// Tunnel destinations are user-supplied (/bili/<url>) — bound the map so
// enumerating distinct hosts cannot grow it unboundedly. Eviction is FIFO by
// FIRST SEEN (not by activity time): production timestamps are monotonic, and
// activity-time ordering misbehaves when a record carries a backdated clock.
const MAX_TRACKED_HOSTS = 256;

const states = new Map<string, HostState>();
let episodeStartAt: number | null = null;

/** Pure triple-gate evaluation over a synthetic clock (test seam). Returns the
 *  qualifying hosts (sorted) when the gate holds, else []. */
export function evaluateWedgeHosts(stateMap: ReadonlyMap<string, HostState>, now: number): string[] {
    const qualified: string[] = [];
    for (const [host, s] of stateMap) {
        if (s.streakStartAt === 0) continue;
        if (now - s.streakStartAt < WEDGE_SUSTAIN_MS) continue; // G3: window not elapsed
        if (s.lastSuccessAt === 0 || now - s.lastSuccessAt > WEDGE_SUCCESS_RECENCY_MS) continue; // G2
        qualified.push(host);
    }
    return qualified.length >= WEDGE_MIN_HOSTS ? [...qualified].sort() : []; // G1
}

function evictFirstSeen(): void {
    if (states.size <= MAX_TRACKED_HOSTS) return;
    const first = states.keys().next().value;
    if (first !== undefined) states.delete(first);
}

/** Record seam: called from tunnel-guard after the main-pool retry loop. A success
 *  ends any failure streak and refreshes recency; a failure starts/extends the streak. */
export function recordResolverOutcome(host: string, ok: boolean, now: number = Date.now()): void {
    evictFirstSeen();
    const cur = states.get(host) ?? { lastSuccessAt: 0, streakStartAt: 0 };
    if (ok) {
        cur.lastSuccessAt = now;
        cur.streakStartAt = 0;
    } else if (cur.streakStartAt === 0) {
        cur.streakStartAt = now;
    }
    states.set(host, cur);
    refreshEpisode(now);
}

/** Re-evaluates the gate and maintains episode state. Idempotent — called from both
 *  the record seam and the wire helper so status polls see live state; logs once per
 *  episode (false→true transition). */
function refreshEpisode(now: number): ResolverWedgeStatus {
    const gated = evaluateWedgeHosts(states, now);
    if (gated.length > 0) {
        if (episodeStartAt === null) {
            episodeStartAt = now;
            loggerLog("warn", `[tunnel] persistent local-DNS wedge detected: ${gated.length} previously-resolving host(s) (${gated.slice(0, 8).join(", ")}) have failed to resolve continuously for at least ${Math.round(WEDGE_SUSTAIN_MS / 60_000)} min — THIS PROCESS's resolver state is stuck (e.g. after a WSL/VPN network switch). Requests to these destinations keep failing until the proxy process is restarted (or egress is routed through an upstream proxy: -F / BILI_UPSTREAM_PROXY).`);
        }
        return { wedged: true, hosts: gated, detectedAt: episodeStartAt };
    }
    episodeStartAt = null;
    return { wedged: false, hosts: [], detectedAt: null };
}

/** Wire payload shared by /__bili/status and /__bili/overview (#2152 parity). */
export function resolverWedgeWire(): ResolverWedgeStatus {
    return refreshEpisode(Date.now());
}

/** Test hook: clear all tracked state between scenarios. */
export function _resetResolverWedgeForTest(): void {
    states.clear();
    episodeStartAt = null;
}
