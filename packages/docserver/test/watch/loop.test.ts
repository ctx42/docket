// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ERR_BUFFER, Relay, runLoop } from "../../src/watch/loop.ts";

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

/** settled reports whether p resolved without advancing time. */
async function settled(p: Promise<unknown>): Promise<boolean> {
    let done = false;
    void p.then(() => {
        done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    return done;
}

describe("runLoop", () => {
    // go: Test_Loop_Run_debounces_burst
    it("debounces a burst into one rebuild", async () => {
        // --- Given ---
        const ntf = new Relay();
        const ctl = new AbortController();
        let rebuilt = 0;
        const loop = runLoop(ntf, {
            debounceMs: 50,
            rebuild: () => {
                rebuilt++;
            },
            warn: () => {},
            signal: ctl.signal,
        });

        // --- When ---
        for (let i = 0; i < 5; i++) {
            ntf.signal();
            await vi.advanceTimersByTimeAsync(5);
        }

        // --- Then ---
        await vi.advanceTimersByTimeAsync(50);
        expect(rebuilt).toBe(1);
        await vi.advanceTimersByTimeAsync(150);
        expect(rebuilt).toBe(1);
        ctl.abort();
        await loop;
    });

    // go: Test_Loop_Run_waits_for_quiet
    it("waits for a quiet window", async () => {
        // --- Given ---
        const ntf = new Relay();
        const ctl = new AbortController();
        let rebuilt = 0;
        const loop = runLoop(ntf, {
            debounceMs: 100,
            rebuild: () => {
                rebuilt++;
            },
            warn: () => {},
            signal: ctl.signal,
        });

        // --- When --- signals keep arriving inside the debounce window.
        for (let i = 0; i < 4; i++) {
            ntf.signal();
            await vi.advanceTimersByTimeAsync(40);
        }

        // --- Then --- nothing within the next 50 ms; one rebuild follows
        // the quiet window.
        expect(rebuilt).toBe(0);
        await vi.advanceTimersByTimeAsync(50);
        expect(rebuilt).toBe(0);
        await vi.advanceTimersByTimeAsync(10);
        expect(rebuilt).toBe(1);
        await vi.advanceTimersByTimeAsync(500);
        expect(rebuilt).toBe(1);
        ctl.abort();
        await loop;
    });

    // go: Test_Loop_Run_change_during_rebuild
    it("rebuilds again after a change during a rebuild, never beside it", async () => {
        // --- Given --- the rebuild blocks until released.
        const ntf = new Relay();
        const ctl = new AbortController();
        let active = 0;
        let peak = 0;
        let started = 0;
        let release: () => void = () => {};
        const loop = runLoop(ntf, {
            debounceMs: 20,
            rebuild: async () => {
                active++;
                peak = Math.max(peak, active);
                started++;
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                active--;
            },
            warn: () => {},
            signal: ctl.signal,
        });
        ntf.signal();
        await vi.advanceTimersByTimeAsync(20);
        expect(started).toBe(1);

        // --- When ---
        ntf.signal();
        await vi.advanceTimersByTimeAsync(50);
        expect(started).toBe(1);
        release();

        // --- Then ---
        await vi.advanceTimersByTimeAsync(20);
        expect(started).toBe(2);
        release();
        await vi.advanceTimersByTimeAsync(500);
        expect(started).toBe(2);
        expect(peak).toBe(1);
        ctl.abort();
        await loop;
    });

    // go: Test_Loop_Run_forwards_errors
    it("forwards errors", async () => {
        // --- Given ---
        const ntf = new Relay();
        const ctl = new AbortController();
        const warned: Error[] = [];
        const loop = runLoop(ntf, {
            debounceMs: 20,
            rebuild: () => {},
            warn: (err) => warned.push(err),
            signal: ctl.signal,
        });
        const want = new Error("watch limit");

        // --- When ---
        ntf.warn(want);

        // --- Then ---
        expect(warned).toEqual([want]);
        expect(warned[0]).toBe(want);
        ctl.abort();
        await loop;
    });

    // go: Test_Loop_Run_rebuilds_after_errors_closed
    it("rebuilds after errors", async () => {
        // --- Given ---
        const ntf = new Relay();
        const ctl = new AbortController();
        let rebuilt = 0;
        const loop = runLoop(ntf, {
            debounceMs: 20,
            rebuild: () => {
                rebuilt++;
            },
            warn: () => {},
            signal: ctl.signal,
        });
        ntf.warn(new Error("x"));

        // --- When ---
        ntf.signal();

        // --- Then ---
        await vi.advanceTimersByTimeAsync(20);
        expect(rebuilt).toBe(1);
        ctl.abort();
        await loop;
    });

    // go: Test_Loop_Run_returns_on_cancel
    it("returns on abort", async () => {
        // --- Given ---
        const ctl = new AbortController();
        const loop = runLoop(new Relay(), {
            debounceMs: 1000,
            rebuild: () => {},
            warn: () => {},
            signal: ctl.signal,
        });

        // --- When ---
        ctl.abort();

        // --- Then ---
        expect(await settled(loop)).toBe(true);
    });

    // go: Test_Loop_Run_returns_when_changes_closed
    it("returns when the notifier closes", async () => {
        // --- Given ---
        const ntf = new Relay();
        const loop = runLoop(ntf, {
            debounceMs: 1000,
            rebuild: () => {},
            warn: () => {},
        });

        // --- When ---
        ntf.close();

        // --- Then ---
        expect(await settled(loop)).toBe(true);
    });

    it("returns at once for an aborted signal", async () => {
        // --- When ---
        const loop = runLoop(new Relay(), {
            debounceMs: 10,
            rebuild: () => {},
            warn: () => {},
            signal: AbortSignal.abort(),
        });

        // --- Then ---
        expect(await settled(loop)).toBe(true);
    });

    it("finishes a running rebuild before returning", async () => {
        // --- Given ---
        const ntf = new Relay();
        const ctl = new AbortController();
        let release: () => void = () => {};
        let finished = false;
        const loop = runLoop(ntf, {
            debounceMs: 10,
            rebuild: async () => {
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                finished = true;
            },
            warn: () => {},
            signal: ctl.signal,
        });
        ntf.signal();
        await vi.advanceTimersByTimeAsync(10);

        // --- When ---
        ctl.abort();

        // --- Then ---
        expect(await settled(loop)).toBe(false);
        release();
        expect(await settled(loop)).toBe(true);
        expect(finished).toBe(true);
    });

    it("delivers errors met during a rebuild after it, and its own failure", async () => {
        // --- Given ---
        const ntf = new Relay();
        const ctl = new AbortController();
        const warned: string[] = [];
        let release: () => void = () => {};
        const loop = runLoop(ntf, {
            debounceMs: 10,
            rebuild: async () => {
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                throw new Error("rebuild failed");
            },
            warn: (err) => warned.push(err.message),
            signal: ctl.signal,
        });
        ntf.signal();
        await vi.advanceTimersByTimeAsync(10);

        // --- When ---
        ntf.warn(new Error("during"));
        expect(warned).toEqual([]);
        release();

        // --- Then ---
        await vi.advanceTimersByTimeAsync(0);
        expect(warned).toEqual(["during", "rebuild failed"]);
        ctl.abort();
        await loop;
    });

    it("keeps at most ERR_BUFFER errors met during a rebuild", async () => {
        // --- Given ---
        const ntf = new Relay();
        const ctl = new AbortController();
        const warned: Error[] = [];
        let release: () => void = () => {};
        const loop = runLoop(ntf, {
            debounceMs: 10,
            rebuild: () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
            warn: (err) => warned.push(err),
            signal: ctl.signal,
        });
        ntf.signal();
        await vi.advanceTimersByTimeAsync(10);

        // --- When ---
        for (let i = 0; i < ERR_BUFFER + 4; i++) ntf.warn(new Error(`e${i}`));
        release();
        await vi.advanceTimersByTimeAsync(0);

        // --- Then ---
        expect(warned).toHaveLength(ERR_BUFFER);
        expect(warned.at(-1)?.message).toBe(`e${ERR_BUFFER - 1}`);
        ntf.warn(new Error("after"));
        expect(warned).toHaveLength(ERR_BUFFER + 1);
        ctl.abort();
        await loop;
    });

    it("ignores signals and errors after it stopped", async () => {
        // --- Given ---
        const ntf = new Relay();
        const ctl = new AbortController();
        let rebuilt = 0;
        const warned: Error[] = [];
        const loop = runLoop(ntf, {
            debounceMs: 10,
            rebuild: () => {
                rebuilt++;
            },
            warn: (err) => warned.push(err),
            signal: ctl.signal,
        });
        ctl.abort();
        await loop;

        // --- When ---
        ntf.signal();
        ntf.warn(new Error("late"));
        await vi.advanceTimersByTimeAsync(100);

        // --- Then ---
        expect(rebuilt).toBe(0);
        expect(warned).toEqual([]);
    });
});

describe("Relay", () => {
    it("holds one coalesced change and up to ERR_BUFFER errors for a late sink", () => {
        // --- Given ---
        const relay = new Relay();
        relay.signal();
        relay.signal();
        for (let i = 0; i < ERR_BUFFER + 4; i++) relay.warn(new Error(`e${i}`));
        relay.close();
        const have = { changes: 0, errors: 0, closed: 0 };

        // --- When ---
        relay.listen({
            change: () => have.changes++,
            error: () => have.errors++,
            closed: () => have.closed++,
        });

        // --- Then ---
        expect(have).toEqual({ changes: 1, errors: ERR_BUFFER, closed: 1 });
    });

    it("delivers nothing after close", () => {
        // --- Given ---
        const relay = new Relay();
        const have: string[] = [];
        relay.listen({
            change: () => have.push("change"),
            error: () => have.push("error"),
            closed: () => have.push("closed"),
        });
        relay.close();

        // --- When ---
        relay.signal();
        relay.warn(new Error("x"));
        relay.close();

        // --- Then ---
        expect(have).toEqual(["closed"]);
    });
});
