// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The host over the real server: a bookshop copy served on a free port,
// its rebuild loop driven by vault events only.

import * as fs from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeDocFs, run } from "@docket/docserver-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpHost, type McpState } from "../../src/mcp/host.ts";
import { assignPort, NODE_PORT_DEPS, notePort } from "../../src/mcp/port.ts";
import { VaultWatchers } from "../../src/mcp/vault-notifier.ts";

/** BOOKSHOP is the example project the doc server tests use. */
const BOOKSHOP = new URL(
    "../../../docserver-node/test/testdata/bookshop",
    import.meta.url,
).pathname;

/** freePort returns a port nothing listens on right now. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address() as { port: number };
            srv.close(() => resolve(port));
        });
    });
}

/** until polls check every 20 ms until it holds or ms pass. */
async function until(check: () => boolean, ms = 5000): Promise<boolean> {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) return false;
        await new Promise((r) => setTimeout(r, 20));
    }
    return true;
}

let vault: string;
let root: string;
let port: number;
const hosts: McpHost[] = [];

beforeEach(async () => {
    vault = fs.mkdtempSync(join(tmpdir(), "vault-"));
    root = join(vault, "srd");
    fs.cpSync(BOOKSHOP, root, { recursive: true });
    port = await freePort();
    const cfg = join(root, "project-config.md");
    fs.writeFileSync(
        cfg,
        fs
            .readFileSync(cfg, "utf8")
            .replace(/^mcp-port: \d+$/m, `mcp-port: ${port}`),
    );
    fs.writeFileSync(
        join(root, ".mcp.json"),
        JSON.stringify({
            mcpServers: {
                srd: { type: "http", url: `http://localhost:${port}/mcp` },
            },
        }),
    );
});

afterEach(async () => {
    for (const host of hosts.splice(0)) await host.stop();
    fs.rmSync(vault, { recursive: true, force: true });
});

/** serving builds a host serving the copy, its watchers fed by hand. */
function serving() {
    const lines: string[] = [];
    const states: McpState[] = [];
    const watchers = new VaultWatchers(
        () => vault,
        () => {
            throw new Error("fallback watcher used");
        },
    );
    const host = new McpHost({
        run: (req) =>
            run({
                config: join(root, "project-config.md"),
                version: "test",
                stderr: req.stderr,
                signal: req.signal,
                fs: new NodeDocFs(),
                newWatcher: watchers.factory,
            }),
        onState: (s) => states.push(s),
        log: (line) => lines.push(line),
    });
    hosts.push(host);
    return { host, watchers, lines, states };
}

describe("McpHost over the server", () => {
    it("serves, reindexes on vault events, and stops", async () => {
        // --- Given ---
        const { host, watchers, lines } = serving();
        await host.start();
        expect(await until(() => host.state.kind === "listening")).toBe(true);
        const doc = join(root, "kb/shipping_times.md");

        // --- When ---
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        fs.appendFileSync(doc, "\nGift wrapping ships in a day.\n");
        watchers.event({
            kind: "modify",
            path: "srd/kb/shipping_times.md",
            folder: false,
        });

        // --- Then ---
        expect(health.status).toBe(200);
        expect(watchers.size).toBe(2);
        const reindexed = () =>
            lines.some((l) => l.startsWith("reindexed 5 documents"));
        expect(await until(reindexed)).toBe(true);
        await host.stop();
        expect(host.state).toEqual({ kind: "stopped" });
        expect(watchers.size).toBe(0);
        await expect(
            fetch(`http://127.0.0.1:${port}/healthz`),
        ).rejects.toThrow();
    });

    it("reports a port in use as an error", async () => {
        // --- Given ---
        const blocker: Server = createServer();
        await new Promise<void>((r) => blocker.listen(port, r));
        const { host, states } = serving();

        try {
            // --- When ---
            await host.start();

            // --- Then ---
            expect(await until(() => host.state.kind === "error")).toBe(true);
            expect(host.state).toEqual({
                kind: "error",
                message: `listen: listen tcp :${port}: bind: address already in use`,
            });
            expect(states.map((s) => s.kind)).toEqual(["starting", "error"]);
            expect(host.running).toBe(false);
        } finally {
            await new Promise((r) => blocker.close(r));
        }
    });

    it("serves two vaults asking for one port side by side", async () => {
        // --- Given --- a second vault copy naming the same port.
        const other = join(vault, "other");
        fs.cpSync(root, other, { recursive: true });
        const start = (cfg: string) => {
            const host = new McpHost({
                run: async (req) => {
                    await assignPort(NODE_PORT_DEPS, cfg);
                    return run({
                        config: cfg,
                        version: "test",
                        stderr: req.stderr,
                        signal: req.signal,
                        fs: new NodeDocFs(),
                    });
                },
            });
            hosts.push(host);
            return host;
        };
        const first = start(join(root, "project-config.md"));
        await first.start();
        expect(await until(() => first.state.kind === "listening")).toBe(true);

        // --- When ---
        const second = start(join(other, "project-config.md"));
        await second.start();

        // --- Then ---
        expect(await until(() => second.state.kind === "listening")).toBe(true);
        const moved = notePort(
            fs.readFileSync(join(other, "project-config.md"), "utf8"),
        ) as number;
        expect(moved).toBeGreaterThan(port);
        expect(second.state).toMatchObject({ kind: "listening" });
        expect((second.state as { address: string }).address).toMatch(
            new RegExp(`:${moved}$`),
        );
        const registry = JSON.parse(
            fs.readFileSync(join(other, ".mcp.json"), "utf8"),
        );
        expect(registry.mcpServers.srd.url).toBe(
            `http://localhost:${moved}/mcp`,
        );
        for (const p of [port, moved]) {
            const res = await fetch(`http://127.0.0.1:${p}/healthz`);
            expect(res.status).toBe(200);
        }
    });
});
