// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine, Rest } from "@docket/docserver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeDocFs } from "../src/fs.ts";
import { restRoute } from "../src/http.ts";

let dir: string;
let srv: Server;
let base: string;

beforeEach(async () => {
    dir = fs.mkdtempSync(join(tmpdir(), "rest-http-"));
    fs.mkdirSync(join(dir, "catalog"));
    fs.writeFileSync(
        join(dir, "catalog/epub.md"),
        "---\ntitle: EPUB Editions\n---\n\nReaders download book data as EPUB.\n",
    );
    const engine = await Engine.create({
        fs: new NodeDocFs(),
        sources: [{ name: "shop", dir }],
    });
    const route = restRoute(new Rest({ engine, version: "x" }));
    srv = createServer((req, res) => {
        void route(req, res);
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

afterEach(async () => {
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("restRoute", () => {
    it("serves REST over HTTP", async () => {
        // --- When ---
        const have = await fetch(`${base}/healthz`);

        // --- Then ---
        expect(have.status).toBe(200);
        expect(have.headers.get("content-type")).toBe("application/json");
        expect(await have.text()).toBe('{"status":"ok","docs":1}\n');
    });

    it("drops the body of a HEAD answer", async () => {
        // --- When ---
        const have = await fetch(`${base}/docs`, { method: "HEAD" });

        // --- Then ---
        expect(have.status).toBe(200);
        expect(await have.text()).toBe("");
    });

    it("answers a wrong method with Allow", async () => {
        // --- When ---
        const have = await fetch(`${base}/search?q=x`, {
            method: "POST",
            body: "x".repeat(2 * 1024 * 1024),
        });

        // --- Then ---
        expect(have.status).toBe(405);
        expect(have.headers.get("allow")).toBe("GET, HEAD");
        expect(await have.text()).toBe("Method Not Allowed\n");
    });

    it("redirects an unclean path", async () => {
        // --- When ---
        const have = await fetch(`${base}//docs?x=1`, {
            redirect: "manual",
        });

        // --- Then ---
        expect(have.status).toBe(307);
        expect(have.headers.get("location")).toBe("/docs?x=1");
    });
});
