// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";

import { Engine, Glossary, type ToolDeps } from "@docket/docserver";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeDocFs } from "../src/fs.ts";
import { MCP_PATH, McpHttpHandler, toWebRequest } from "../src/http.ts";
import { serveStdio } from "../src/stdio.ts";

let dir: string;
const closers: (() => Promise<void> | void)[] = [];

beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "mcp-transport-"));
});

afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** write writes content to name under dir, creating parents. */
function write(name: string, content: string): string {
    const path = join(dir, name);
    fs.mkdirSync(join(path, ".."), { recursive: true });
    fs.writeFileSync(path, content);
    return path;
}

/** newDeps builds the Go tests' one-file corpus on the real filesystem. */
async function newDeps(): Promise<ToolDeps> {
    write(
        "catalog/epub.md",
        "---\ntitle: EPUB Editions\n---\n\n" +
            "Readers download book data as EPUB.\n" +
            "See https://docs.example.com/epub\n",
    );
    const engine = await Engine.create({
        fs: new NodeDocFs(),
        sources: [{ name: "shop", dir }],
    });
    return { engine, version: "0.0.0-test" };
}

/** listen serves handler on 127.0.0.1 and returns the MCP endpoint URL. */
async function listen(handler: McpHttpHandler): Promise<URL> {
    const srv: Server = createServer((req, res) => {
        void handler.handle(req, res);
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    closers.push(
        () => new Promise<void>((resolve) => srv.close(() => resolve())),
        () => handler.close(),
    );
    closers.push(() => srv.closeAllConnections());
    const { port } = srv.address() as AddressInfo;
    return new URL(`http://127.0.0.1:${port}${MCP_PATH}`);
}

/** connectHTTP returns a client connected over Streamable HTTP to url. */
async function connectHTTP(url: URL): Promise<Client> {
    const client = new Client({ name: "test", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(url) as Transport);
    closers.push(() => client.close());
    return client;
}

describe("Streamable HTTP", () => {
    // go: Test_Handler_serves_tools_over_http
    it("serves the tools over HTTP", async () => {
        // --- Given ---
        const url = await listen(new McpHttpHandler(await newDeps()));
        const client = await connectHTTP(url);

        // --- When ---
        const res = await client.callTool({
            name: "search",
            arguments: { query: "EPUB" },
        });

        // --- Then ---
        expect(res.isError).toBeFalsy();
        const have = res.structuredContent as { results: { id: string }[] };
        expect(have.results.map((r) => r.id)).toEqual(["shop/catalog/epub.md"]);
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
            "get_doc",
            "list_docs",
            "search",
        ]);
    });

    // go: Test_handler_closes_idle_session
    it("closes an idle session", async () => {
        // --- Given ---
        const handler = new McpHttpHandler(await newDeps(), 50);
        const client = await connectHTTP(await listen(handler));
        await new Promise((resolve) => setTimeout(resolve, 300));

        // --- When ---
        const call = client.listTools();

        // --- Then ---
        await expect(call).rejects.toThrow("session not found");
        expect(handler.size).toBe(0);
    });

    it("gives each client its own session", async () => {
        // --- Given ---
        const handler = new McpHttpHandler(await newDeps());
        const url = await listen(handler);

        // --- When ---
        await connectHTTP(url);
        await connectHTTP(url);

        // --- Then ---
        expect(handler.size).toBe(2);
    });

    it("hides an unreadable glossary as internal error", async () => {
        // --- Given --- a glossary file the server cannot read.
        if (process.getuid?.() === 0) return;
        const path = write(
            "glossary/main.md",
            "## Backorder\n\nOrder for an out-of-stock title.\n",
        );
        const engine = await Engine.create({
            fs: new NodeDocFs(),
            sources: [{ name: "shop", dir }],
        });
        const logged: unknown[] = [];
        const deps: ToolDeps = {
            engine,
            version: "x",
            glossary: new Glossary(engine, "shop/glossary"),
            logErr: (err) => logged.push(err),
        };
        const client = await connectHTTP(
            await listen(new McpHttpHandler(deps)),
        );
        fs.chmodSync(path, 0o000);
        closers.push(() => fs.chmodSync(path, 0o644));

        // --- When ---
        const res = await client.callTool({ name: "glossary_terms" });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(res.content).toEqual([{ type: "text", text: "internal error" }]);
        expect(logged).toHaveLength(1);
    });
});

describe("Streamable HTTP in a browser renderer", () => {
    it("serves a client where Request takes only its own body types", () => {
        // --- Given --- Obsidian's Chromium Request reads a body of a type
        // it does not know, such as a Node stream, as its string form, and
        // its timers return numbers. They are in place before the server's
        // modules load, as in the plugin, so this runs in a child process.
        write("catalog/epub.md", "---\ntitle: EPUB Editions\n---\n\nEPUB.\n");
        const script = `
            const Native = globalThis.Request;
            class ChromiumRequest extends Native {
                constructor(input, init) {
                    const b = init?.body;
                    const own = b == null || typeof b === "string" ||
                        b instanceof Uint8Array || b instanceof ArrayBuffer;
                    super(input, own ? init : { ...init, body: String(b) });
                }
            }
            globalThis.Request = ChromiumRequest;
            for (const [set, clear] of [
                ["setTimeout", "clearTimeout"],
                ["setInterval", "clearInterval"],
            ]) {
                const nativeSet = globalThis[set];
                const nativeClear = globalThis[clear];
                const ids = new Map();
                let next = 1;
                globalThis[set] = (fn, ms, ...args) => {
                    const id = next++;
                    ids.set(id, nativeSet(fn, ms, ...args));
                    return id;
                };
                globalThis[clear] = (id) => {
                    nativeClear(ids.get(id));
                    ids.delete(id);
                };
            }
            const { createServer } = await import("node:http");
            const { Engine } = await import("@docket/docserver");
            const { NodeDocFs, McpHttpHandler } = await import(
                ${JSON.stringify(new URL("../src/index.ts", import.meta.url).pathname)}
            );
            const engine = await Engine.create({
                fs: new NodeDocFs(),
                sources: [{ name: "shop", dir: ${JSON.stringify(dir)} }],
            });
            const handler = new McpHttpHandler({ engine, version: "x" });
            const srv = createServer((req, res) => void handler.handle(req, res));
            await new Promise((r) => srv.listen(0, "127.0.0.1", r));
            const url = "http://127.0.0.1:" + srv.address().port + "/mcp";
            const post = (body, sid) => fetch(url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    accept: "application/json, text/event-stream",
                    ...(sid ? { "mcp-session-id": sid } : {}),
                },
                body: JSON.stringify(body),
            });
            const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {},
                    clientInfo: { name: "c", version: "1" } } });
            const sid = init.headers.get("mcp-session-id");
            await init.text();
            await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
            const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call",
                params: { name: "search", arguments: { query: "EPUB" } } }, sid);
            const text = await call.text();
            const ac = new AbortController();
            const stream = await fetch(url, {
                headers: { accept: "text/event-stream", "mcp-session-id": sid },
                signal: ac.signal,
            });
            ac.abort();
            const end = await fetch(url, {
                method: "DELETE",
                headers: { "mcp-session-id": sid },
            });
            console.log(JSON.stringify({
                init: init.status,
                call: call.status,
                found: text.includes("shop/catalog/epub.md"),
                stream: [stream.status, stream.headers.get("content-type")],
                end: end.status,
                kept: globalThis.Request === ChromiumRequest,
            }));
            await handler.close();
            srv.close();
            srv.closeAllConnections();
        `;

        // --- When ---
        const have = execFileSync("bun", ["-e", script], {
            cwd: new URL("..", import.meta.url).pathname,
            encoding: "utf8",
            timeout: 20_000,
        });

        // --- Then ---
        expect(JSON.parse(have.trim().split("\n").at(-1) as string)).toEqual({
            init: 200,
            call: 200,
            found: true,
            stream: [200, "text/event-stream"],
            end: 200,
            kept: true,
        });
    });
});

describe("toWebRequest", () => {
    /** incoming is a Node request with method, headers and body. */
    function incoming(
        method: string,
        headers: Record<string, string | string[]>,
        body = "",
    ): IncomingMessage {
        const req = Readable.from(body === "" ? [] : [Buffer.from(body)]);
        return Object.assign(req, {
            method,
            url: "/mcp?x=1",
            headers,
        }) as unknown as IncomingMessage;
    }

    it("passes the body as text and drops the framing headers", async () => {
        // --- Given ---
        const req = incoming(
            "POST",
            {
                "content-type": "application/json",
                "content-length": "11",
                connection: "keep-alive",
                "transfer-encoding": "chunked",
                "mcp-session-id": "s1",
                accept: ["application/json", "text/event-stream"],
            },
            '{"a":"é"}',
        );

        // --- When ---
        const have = await toWebRequest(req);

        // --- Then ---
        expect(have.method).toBe("POST");
        expect(have.url).toBe("http://localhost/mcp?x=1");
        expect(await have.text()).toBe('{"a":"é"}');
        expect(have.headers.get("mcp-session-id")).toBe("s1");
        expect(have.headers.get("accept")).toBe(
            "application/json, text/event-stream",
        );
        expect(have.headers.get("content-length")).toBeNull();
        expect(have.headers.get("transfer-encoding")).toBeNull();
    });

    it("sends no body for a GET", async () => {
        // --- When ---
        const have = await toWebRequest(incoming("GET", { host: "h" }));

        // --- Then ---
        expect(have.method).toBe("GET");
        expect(have.body).toBeNull();
    });
});

describe("stdio", () => {
    // go: Test_Serve_over_piped_transport
    it("serves one client over piped streams", async () => {
        // --- Given ---
        const srvIn = new PassThrough();
        const cliIn = new PassThrough();
        const ctl = new AbortController();
        const served = serveStdio(await newDeps(), {
            stdin: srvIn,
            stdout: cliIn,
            signal: ctl.signal,
        });
        const client = new Client({ name: "test", version: "0.1.0" });
        await client.connect(new StdioServerTransport(cliIn, srvIn));

        // --- When ---
        const res = await client.callTool({
            name: "search",
            arguments: { query: "EPUB" },
        });

        // --- Then ---
        expect(res.isError).toBeFalsy();
        const have = res.structuredContent as { results: unknown[] };
        expect(have.results).toHaveLength(1);

        await client.close();
        ctl.abort();
        await expect(served).resolves.toBeUndefined();
    });

    it("ends when its input ends", async () => {
        // --- Given ---
        const srvIn = new PassThrough();
        const served = serveStdio(await newDeps(), {
            stdin: srvIn,
            stdout: new PassThrough(),
        });

        // --- When ---
        srvIn.end();

        // --- Then ---
        await expect(served).resolves.toBeUndefined();
    });

    it("returns at once for an aborted signal", async () => {
        // --- When ---
        const served = serveStdio(await newDeps(), {
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            signal: AbortSignal.abort(),
        });

        // --- Then ---
        await expect(served).resolves.toBeUndefined();
    });
});
