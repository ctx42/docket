// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { rawGet } from "./raw-http.ts";

let srv: Server | undefined;

afterEach(async () => {
    const s = srv;
    srv = undefined;
    if (s !== undefined) await new Promise<void>((r) => s.close(() => r()));
});

/** listen starts srv on a free loopback port and returns the port. */
async function listen(s: Server): Promise<number> {
    srv = s;
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return (s.address() as AddressInfo).port;
}

describe("rawGet", () => {
    it.each([
        ["dot segment", "/./mcp"],
        ["double slash", "//mcp"],
        ["dot-dot segment", "/x/../mcp"],
        ["query", "//docs?x=1"],
    ])("sends a %s target as given", async (_name, want) => {
        // --- Given ---
        const port = await listen(
            createServer((req, res) => {
                res.end(req.url);
            }),
        );

        // --- When ---
        const have = await rawGet(port, want);

        // --- Then ---
        expect(have.body).toBe(want);
    });

    it("reads the status and the headers", async () => {
        // --- Given ---
        const port = await listen(
            createServer((_req, res) => {
                res.writeHead(307, { Location: "/docs?x=1" });
                res.end();
            }),
        );

        // --- When ---
        const have = await rawGet(port, "/");

        // --- Then ---
        expect(have.status).toBe(307);
        expect(have.headers.get("location")).toBe("/docs?x=1");
        expect(have.body).toBe("");
    });

    it("fails when nothing listens", async () => {
        // --- Given ---
        const port = await listen(createServer());
        await new Promise<void>((r) => srv?.close(() => r()));
        srv = undefined;

        // --- When ---
        const have = rawGet(port, "/");

        // --- Then ---
        await expect(have).rejects.toThrow("ECONNREFUSED");
    });
});
