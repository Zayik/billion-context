import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWedgeHosts, recordResolverOutcome, resolverWedgeWire, _resetResolverWedgeForTest } from "../src/resolver-wedge.ts";

/** #5222 Phase 2: persistent process-local resolver wedge — triple-gate detector.
 *  Owner decision 2026-10-31: detect + surface only, NEVER self-restart. Gate
 *  discipline (#3617): both directions asserted — "fires when it should" AND
 *  "does NOT fire when it should not". All timing rides the synthetic-clock
 *  parameter of recordResolverOutcome / evaluateWedgeHosts — no real waits. */

const SUSTAIN_MS = 5 * 60_000;
const RECENCY_MS = 24 * 60 * 60_000;

type HostState = { lastSuccessAt: number; streakStartAt: number };
const st = (lastSuccessAt: number, streakStartAt: number): HostState => ({ lastSuccessAt, streakStartAt });

test("#5222 P2 positive: two previously-resolving hosts failing past the window → gate holds", () => {
    const now = Date.now();
    const map = new Map<string, HostState>([
        ["alpha.example", st(now - 3600_000, now - 6 * 60_000)],
        ["beta.example", st(now - 3600_000, now - 10 * 60_000)],
    ]);
    assert.deepEqual(evaluateWedgeHosts(map, now), ["alpha.example", "beta.example"]);
});

test("#5222 P2 negative G1: a single failing host never alarms", () => {
    const now = Date.now();
    const map = new Map<string, HostState>([["alpha.example", st(now - 3600_000, now - 6 * 60_000)]]);
    assert.deepEqual(evaluateWedgeHosts(map, now), []);
});

test("#5222 P2 negative G3: failures younger than the sustain window do not alarm", () => {
    const now = Date.now();
    const map = new Map<string, HostState>([
        ["alpha.example", st(now - 3600_000, now - (SUSTAIN_MS - 1))],
        ["beta.example", st(now - 3600_000, now - (SUSTAIN_MS - 1))],
    ]);
    assert.deepEqual(evaluateWedgeHosts(map, now), []);
});

test("#5222 P2 boundary G3: exactly at the sustain window the gate fires", () => {
    const now = Date.now();
    const map = new Map<string, HostState>([
        ["alpha.example", st(now - 3600_000, now - SUSTAIN_MS)],
        ["beta.example", st(now - 3600_000, now - SUSTAIN_MS)],
    ]);
    assert.deepEqual(evaluateWedgeHosts(map, now), ["alpha.example", "beta.example"]);
});

test("#5222 P2 negative G2: hosts that NEVER resolved here are dead names, not a wedge", () => {
    const now = Date.now();
    const map = new Map<string, HostState>([
        ["dead-a.invalid", st(0, now - 6 * 60_000)],
        ["dead-b.invalid", st(0, now - 6 * 60_000)],
    ]);
    assert.deepEqual(evaluateWedgeHosts(map, now), []);
});

test("#5222 P2 negative G2: a success older than the recency horizon does not count", () => {
    const now = Date.now();
    const map = new Map<string, HostState>([
        ["alpha.example", st(now - RECENCY_MS - 1, now - 6 * 60_000)],
        ["beta.example", st(now - RECENCY_MS - 1, now - 6 * 60_000)],
    ]);
    assert.deepEqual(evaluateWedgeHosts(map, now), []);
});

test("#5222 P2 negative: a mid-episode recovery breaks the streak and the gate", () => {
    const now = Date.now();
    const map = new Map<string, HostState>([
        ["alpha.example", st(now - 60_000, 0)], // recovered just now
        ["beta.example", st(now - 3600_000, now - 6 * 60_000)],
    ]);
    assert.deepEqual(evaluateWedgeHosts(map, now), []);
});

test("#5222 P2 wire: backdated success+failure history trips the banner state, recovery clears it", () => {
    _resetResolverWedgeForTest();
    try {
        const now = Date.now();
        assert.deepEqual(resolverWedgeWire(), { wedged: false, hosts: [], detectedAt: null }, "clean process alarms nothing");
        recordResolverOutcome("alpha.example", true, now - 3600_000);
        recordResolverOutcome("beta.example", true, now - 3600_000);
        recordResolverOutcome("alpha.example", false, now - 6 * 60_000);
        recordResolverOutcome("beta.example", false, now - 6 * 60_000);
        const w = resolverWedgeWire();
        assert.equal(w.wedged, true);
        assert.deepEqual(w.hosts, ["alpha.example", "beta.example"]);
        assert.ok(w.detectedAt !== null && w.detectedAt >= now && w.detectedAt <= Date.now());
        // recovery of ONE host drops the gate below two hosts → alarm clears
        recordResolverOutcome("alpha.example", true, Date.now());
        const w2 = resolverWedgeWire();
        assert.equal(w2.wedged, false);
        assert.deepEqual(w2.hosts, []);
    } finally {
        _resetResolverWedgeForTest();
    }
});

test("#5222 P2 wire: persistent failures on never-resolved names stay silent (no false alarm)", () => {
    _resetResolverWedgeForTest();
    try {
        const now = Date.now();
        recordResolverOutcome("dead-a.invalid", false, now - 6 * 60_000);
        recordResolverOutcome("dead-b.invalid", false, now - 6 * 60_000);
        assert.equal(resolverWedgeWire().wedged, false, "G2: machine-wide dead names must not be reported as a process wedge");
    } finally {
        _resetResolverWedgeForTest();
    }
});

test("#5222 P2 bound: user-supplied hosts cannot grow the tracker past its cap", () => {
    _resetResolverWedgeForTest();
    try {
        const now = Date.now();
        for (let i = 0; i < 300; i++) {
            const host = `h${i}.example`;
            recordResolverOutcome(host, true, now - 3600_000 + i);
            recordResolverOutcome(host, false, now - 6 * 60_000 + i);
        }
        const w = resolverWedgeWire();
        assert.ok(w.wedged, "the surviving hosts still qualify");
        assert.equal(w.hosts.length, 256, "tracker is capped (MAX_TRACKED_HOSTS)");
        assert.ok(!w.hosts.includes("h0.example") && !w.hosts.includes("h43.example"), "first-seen entries evicted first (FIFO)");
        assert.ok(w.hosts.includes("h299.example"), "newest entries survive");
    } finally {
        _resetResolverWedgeForTest();
    }
});
