// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { McpHost, type McpState, type RunRequest } from "../../src/mcp/host.ts";

/** FakeRun is a controllable server run. */
interface FakeRun {
    req: RunRequest;
    /** fail ends the run with err, as a failed server does. */
    fail: (err: unknown) => void;
    /** closeFails makes the shutdown after an abort reject. */
    closeFails: boolean;
}

/** newHost builds a host over fake runs, recording states and log lines. */
function newHost(opts: { listens?: boolean } = {}) {
    const runs: FakeRun[] = [];
    const states: McpState[] = [];
    const lines: string[] = [];
    const host = new McpHost({
        run: (req) =>
            new Promise<void>((resolve, reject) => {
                const run: FakeRun = { req, fail: reject, closeFails: false };
                runs.push(run);
                if (opts.listens !== false) {
                    req.stderr.write("indexed 5 documents in 3ms\n");
                    req.stderr.write("listening on ");
                    req.stderr.write("[::]:7777\n");
                }
                req.signal.addEventListener("abort", () => {
                    if (run.closeFails) reject(new Error("close failed"));
                    else resolve();
                });
            }),
        onState: (s) => states.push(s),
        log: (line) => lines.push(line),
    });
    return { host, runs, states, lines };
}

/** settle lets pending promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("McpHost", () => {
    it("starts and listens", async () => {
        // --- Given ---
        const { host, runs, states, lines } = newHost();

        // --- When ---
        await host.start();

        // --- Then ---
        expect(runs).toHaveLength(1);
        expect(host.running).toBe(true);
        expect(host.state).toEqual({ kind: "listening", address: "[::]:7777" });
        expect(states).toEqual([
            { kind: "starting" },
            { kind: "listening", address: "[::]:7777" },
        ]);
        expect(lines).toEqual([
            "indexed 5 documents in 3ms",
            "listening on [::]:7777",
        ]);
    });

    it("stays starting until the server listens", async () => {
        // --- Given ---
        const { host } = newHost({ listens: false });

        // --- When ---
        await host.start();

        // --- Then ---
        expect(host.state).toEqual({ kind: "starting" });
    });

    it("ignores a start while running", async () => {
        // --- Given ---
        const { host, runs } = newHost();
        await host.start();

        // --- When ---
        await host.start();

        // --- Then ---
        expect(runs).toHaveLength(1);
    });

    it("stops and waits for the shutdown", async () => {
        // --- Given ---
        const { host, runs, states } = newHost();
        await host.start();

        // --- When ---
        await host.stop();

        // --- Then ---
        expect(runs[0]?.req.signal.aborted).toBe(true);
        expect(host.running).toBe(false);
        expect(host.state).toEqual({ kind: "stopped" });
        expect(states.at(-1)).toEqual({ kind: "stopped" });
    });

    it("treats a failing shutdown as stopped", async () => {
        // --- Given ---
        const { host, runs, states } = newHost();
        await host.start();
        (runs[0] as FakeRun).closeFails = true;

        // --- When ---
        await host.stop();

        // --- Then ---
        expect(host.state).toEqual({ kind: "stopped" });
        expect(states.some((s) => s.kind === "error")).toBe(false);
    });

    it("does nothing when stopping while stopped", async () => {
        // --- Given ---
        const { host, states } = newHost();

        // --- When ---
        await host.stop();

        // --- Then ---
        expect(states).toEqual([]);
    });

    it("restarts after the old run has shut down", async () => {
        // --- Given ---
        const { host, runs, states } = newHost();
        await host.start();

        // --- When ---
        await host.restart();

        // --- Then ---
        expect(runs).toHaveLength(2);
        expect(runs[0]?.req.signal.aborted).toBe(true);
        expect(runs[1]?.req.signal.aborted).toBe(false);
        expect(host.state).toEqual({ kind: "listening", address: "[::]:7777" });
        expect(states.map((s) => s.kind)).toEqual([
            "starting",
            "listening",
            "stopped",
            "starting",
            "listening",
        ]);
    });

    it("restart starts a stopped server", async () => {
        // --- Given ---
        const { host, runs } = newHost();

        // --- When ---
        await host.restart();

        // --- Then ---
        expect(runs).toHaveLength(1);
        expect(host.running).toBe(true);
    });

    it("reports a failed run as an error", async () => {
        // --- Given ---
        const { host, runs, states } = newHost({ listens: false });
        await host.start();

        // --- When ---
        (runs[0] as FakeRun).fail(
            new Error("listen: listen tcp :7777: bind: address already in use"),
        );
        await settle();

        // --- Then ---
        const want: McpState = {
            kind: "error",
            message: "listen: listen tcp :7777: bind: address already in use",
        };
        expect(host.state).toEqual(want);
        expect(states.at(-1)).toEqual(want);
        expect(host.running).toBe(false);
    });

    it("reports a non-Error failure by its text", async () => {
        // --- Given ---
        const { host, runs } = newHost({ listens: false });
        await host.start();

        // --- When ---
        (runs[0] as FakeRun).fail("boom");
        await settle();

        // --- Then ---
        expect(host.state).toEqual({ kind: "error", message: "boom" });
    });

    it("starts again after an error", async () => {
        // --- Given ---
        const { host, runs } = newHost({ listens: false });
        await host.start();
        (runs[0] as FakeRun).fail(new Error("x"));
        await settle();

        // --- When ---
        await host.start();

        // --- Then ---
        expect(runs).toHaveLength(2);
        expect(host.state).toEqual({ kind: "starting" });
    });

    it("clears an error on stop", async () => {
        // --- Given ---
        const { host, runs } = newHost({ listens: false });
        await host.start();
        (runs[0] as FakeRun).fail(new Error("x"));
        await settle();

        // --- When ---
        await host.stop();

        // --- Then ---
        expect(host.state).toEqual({ kind: "stopped" });
    });

    it("runs requests in order", async () => {
        // --- Given ---
        const { host, runs } = newHost();

        // --- When ---
        const done = [host.start(), host.stop(), host.start(), host.stop()];
        await Promise.all(done);

        // --- Then ---
        expect(runs).toHaveLength(2);
        expect(runs.every((r) => r.req.signal.aborted)).toBe(true);
        expect(host.state).toEqual({ kind: "stopped" });
    });

    it("ignores log lines of a replaced run", async () => {
        // --- Given ---
        const { host, runs } = newHost();
        await host.start();
        await host.restart();

        // --- When ---
        runs[0]?.req.stderr.write("listening on :1\n");

        // --- Then ---
        expect(host.state).toEqual({ kind: "listening", address: "[::]:7777" });
    });

    it("starts nothing once disposed", async () => {
        // --- Given ---
        const { host, runs } = newHost();
        await host.start();

        // --- When ---
        await host.dispose();
        await host.start();
        await host.restart();

        // --- Then ---
        expect(runs).toHaveLength(1);
        expect(host.running).toBe(false);
        expect(host.state).toEqual({ kind: "stopped" });
    });

    it.each([["stop"], ["restart"]] as const)(
        "does not report listening after a %s while starting",
        async (op) => {
            // --- Given --- a run that binds only once indexing is done,
            // whether or not it was asked to stop meanwhile.
            const states: McpState[] = [];
            const host = new McpHost({
                run: (req) =>
                    new Promise<void>((resolve) => {
                        req.signal.addEventListener("abort", () => {
                            req.stderr.write("listening on [::]:7777\n");
                            resolve();
                        });
                    }),
                onState: (s) => states.push(s),
            });
            await host.start();

            // --- When ---
            await host[op]();

            // --- Then ---
            expect(states.map((s) => s.kind)).toEqual(
                op === "stop"
                    ? ["starting", "stopped"]
                    : ["starting", "stopped", "starting"],
            );
        },
    );
});
