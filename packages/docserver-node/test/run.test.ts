// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The server's whole run on the real filesystem, ported from the earlier Go
// server's run tests. Some Go tests that probe the running server over REST
// make the same check here through the MCP tools.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import {
    CLOSED_DIR,
    emptyGap,
    FileStore,
    fromDate,
    type Gap,
    hash,
} from "@docket/docserver";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { NodeDocFs } from "../src/fs.ts";
import { type RunOptions, run, type Watcher } from "../src/run.ts";

/** WAIT_MS bounds every poll, as the Go tests' 500 × 10 ms waits. */
const WAIT_MS = 5_000;

const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** Collector is a Writable collecting everything written to it. */
class Collector extends Writable {
    private text = "";

    override _write(
        chunk: unknown,
        _enc: BufferEncoding,
        done: (err?: Error | null) => void,
    ): void {
        this.text += String(chunk);
        done();
    }

    override toString(): string {
        return this.text;
    }
}

/** tempDir returns a new temp dir removed after the test. */
function tempDir(): string {
    const dir = fs.mkdtempSync(join(tmpdir(), "mcp-run-"));
    dirs.push(dir);
    return dir;
}

/** writeMD writes content to name within dir, creating parents. */
function writeMD(dir: string, name: string, content: string): string {
    const path = join(dir, name);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, content);
    return path;
}

/** writeConfig writes content to a temp-dir config.yaml. */
function writeConfig(content: string): string {
    return writeMD(tempDir(), "config.yaml", content);
}

/** freePort returns a TCP port free on the loopback interface a moment ago. */
async function freePort(): Promise<number> {
    const srv = createServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const { port } = srv.address() as { port: number };
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    return port;
}

/** writeMCPJSON writes a .mcp.json registering "srd" on port into dir. */
function writeMCPJSON(dir: string, port: number): void {
    const json =
        `{"mcpServers": {"srd": ` +
        `{"type": "http", "url": "http://localhost:${port}/mcp"}}}`;
    fs.writeFileSync(join(dir, ".mcp.json"), json);
}

/**
 * writeProject writes a temp project as the Go helper does and returns its
 * project-config.md path; a non-zero mcpPort also writes a .mcp.json.
 */
function writeProject(port: number, mcpPort: number): string {
    const root = tempDir();
    writeMD(
        root,
        "upstream/glossary/main.md",
        "---\ntitle: Main\n---\n\n" +
            "## Stock Keeping Unit (SKU)\n\nIdentifier of a book edition.\n",
    );
    writeMD(root, "kb/users.md", "## Users\n\nPeople.\n");
    writeMD(root, "upstream/initiatives/srd.md", "## Scope\n\nPlans.\n");
    fs.mkdirSync(join(root, "gaps"));
    if (mcpPort !== 0) writeMCPJSON(root, mcpPort);
    const front =
        "upstream-sync: ignore-push\n" +
        "mcp-server: srd\n" +
        `mcp-port: ${port}\n` +
        "sources: [upstream, kb]\n" +
        "gaps: gaps\n" +
        "glossary: upstream/glossary\n" +
        "precedence: [kb, upstream]\n" +
        "initiatives: upstream/initiatives\n" +
        "kb: kb\n";
    return writeMD(root, "project-config.md", `---\n${front}---\n`);
}

/** corpusDir writes the shared one-document corpus and returns its dir. */
function corpusDir(): string {
    const dir = tempDir();
    writeMD(
        dir,
        "catalog/epub.md",
        "---\ntitle: EPUB Editions\n---\n\n" +
            "Readers download book data as EPUB.\n",
    );
    return dir;
}

/** newSeed returns a gap store over dir to write gaps before a run. */
function newSeed(dir: string): FileStore {
    const seed = new FileStore(
        new NodeDocFs(),
        dir,
        () => fromDate(new Date()),
        undefined,
    );
    closers.push(() => seed.close());
    return seed;
}

/** newGap returns a missing-kind gap about topic. */
function newGap(topic: string, extra: Partial<Gap> = {}): Gap {
    return {
        ...emptyGap(),
        kind: "missing",
        topic,
        demand: "d",
        detail: "x",
        ...extra,
    };
}

/** Running is a run in progress. */
interface Running {
    stderr: Collector;
    ctl: AbortController;
    done: Promise<void>;
}

/**
 * start runs the server on config until the test ends or ctl aborts; the
 * returned run's done settles with run's outcome.
 */
function start(config: string, opts: Partial<RunOptions> = {}): Running {
    const stderr = new Collector();
    const ctl = new AbortController();
    const done = run({
        config,
        version: "0.0.0-test",
        stderr,
        signal: ctl.signal,
        ...opts,
    });
    closers.push(async () => {
        ctl.abort();
        await done.catch(() => {});
    });
    return { stderr, ctl, done };
}

/** waitOutput polls buf until it contains want, failing after WAIT_MS. */
async function waitOutput(buf: Collector, want: string): Promise<void> {
    const end = Date.now() + WAIT_MS;
    while (!buf.toString().includes(want)) {
        if (Date.now() > end) {
            throw new Error(`output never contained "${want}"`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** waitListening waits for the advertised bound address and returns it. */
async function waitListening(buf: Collector): Promise<string> {
    const end = Date.now() + WAIT_MS;
    for (;;) {
        const addr = /listening on (.*)\n/.exec(buf.toString())?.[1];
        if (addr !== undefined) return addr;
        if (Date.now() > end) {
            throw new Error("server did not advertise a listening address");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** connect returns an MCP client connected to base's /mcp endpoint. */
async function connect(base: string): Promise<Client> {
    const client = new Client({ name: "test", version: "0.1.0" });
    const url = new URL(`${base}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(url) as Transport);
    closers.push(() => client.close());
    return client;
}

/** call calls tool name with args. */
async function call(
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
): Promise<CallToolResult> {
    return (await client.callTool({
        name,
        arguments: args,
    })) as CallToolResult;
}

/** textOf returns a tool result's first text block. */
function textOf(res: CallToolResult): string {
    const block = res.content[0];
    return block?.type === "text" ? block.text : "";
}

/** gapsOf returns the gaps of a list_gaps result. */
function gapsOf(res: CallToolResult): Record<string, unknown>[] {
    expect(res.isError).toBeFalsy();
    return (res.structuredContent as { gaps: Record<string, unknown>[] }).gaps;
}

/** nopWatcher returns a watcher that never signals. */
function nopWatcher(): Watcher {
    return { listen: () => {}, close: () => {} };
}

describe("run", { timeout: 30_000 }, () => {
    // go: Test_run_error_missing_config
    it("errors for a missing config", async () => {
        // --- Given ---
        const path = join(tempDir(), "no.yaml");

        // --- When ---
        const have = run({
            config: path,
            version: "0.0.0-test",
            stderr: new Collector(),
        });

        // --- Then ---
        await expect(have).rejects.toThrow("read config");
    });

    // go: Test_run_error_missing_source_dir
    it("errors for a missing source dir", async () => {
        // --- Given ---
        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                "sources:\n  gone:\n    dir: /no/such/dir\n",
        );

        // --- When ---
        const have = run({
            config: path,
            version: "0.0.0-test",
            stderr: new Collector(),
        });

        // --- Then ---
        const want = "ingest source gone: lstat /no/such/dir: no such file";
        await expect(have).rejects.toThrow(want);
    });

    // go: Test_run_error_gaps_dir_missing
    it("refuses to start without its gaps folder", async () => {
        // --- Given ---
        const dir = corpusDir();
        const gapsPath = join(tempDir(), "absent");
        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                `gaps: ${gapsPath}\n` +
                `sources:\n  shop:\n    dir: ${dir}\n`,
        );
        const stderr = new Collector();

        // --- When ---
        const have = run({ config: path, version: "0.0.0-test", stderr });

        // --- Then ---
        await expect(have).rejects.toThrow("gaps folder: stat ");
        expect(stderr.toString()).toBe("");
    });

    // go: Test_run_error_listen_required_in_http_mode
    it("errors without a listen address in HTTP mode", async () => {
        // --- Given ---
        const dir = corpusDir();
        const path = writeConfig(`sources:\n  shop:\n    dir: ${dir}\n`);

        // --- When ---
        const have = run({
            config: path,
            version: "0.0.0-test",
            stderr: new Collector(),
        });

        // --- Then ---
        await expect(have).rejects.toThrow("listen address is required");
    });

    // go: Test_run_http_serves_rest_and_mcp
    it("serves REST and MCP side by side", async () => {
        // --- Given ---
        const dir = corpusDir();
        const path = writeConfig(
            `listen: "127.0.0.1:0"\nsources:\n  shop:\n    dir: ${dir}\n`,
        );
        const srv = start(path);
        const base = `http://${await waitListening(srv.stderr)}`;

        // --- When --- REST health and search.
        let res = await fetch(`${base}/healthz`);

        // --- Then ---
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('{"status":"ok","docs":1}\n');

        res = await fetch(`${base}/search?q=EPUB`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("shop/catalog/epub.md");

        // --- When --- MCP tools over /mcp.
        const client = await connect(base);
        const tools = await client.listTools();

        // --- Then ---
        expect(tools.tools).toHaveLength(3);
        const have = await call(client, "get_doc", {
            id: "shop/catalog/epub.md",
        });
        expect(have.isError).toBeFalsy();
        await client.close();

        // --- Then --- aborting shuts the server down cleanly.
        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();

        expect(srv.stderr.toString()).toContain("indexed 1 documents");
    });

    it("stops at once while a client holds an MCP stream", async () => {
        // --- Given --- a client with the GET event stream open.
        const dir = corpusDir();
        const path = writeConfig(
            `listen: "127.0.0.1:0"\nsources:\n  shop:\n    dir: ${dir}\n`,
        );
        const srv = start(path);
        const url = `http://${await waitListening(srv.stderr)}/mcp`;
        const headers = {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
        };
        const init = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "t", version: "1" },
                },
            }),
        });
        const sid = init.headers.get("mcp-session-id") as string;
        await init.text();
        await fetch(url, {
            method: "POST",
            headers: { ...headers, "mcp-session-id": sid },
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
            }),
        });
        const stream = await fetch(url, {
            headers: { accept: "text/event-stream", "mcp-session-id": sid },
        });
        expect(stream.status).toBe(200);

        // --- When ---
        const start0 = Date.now();
        srv.ctl.abort();
        await srv.done;

        // --- Then --- well inside the 5 s shutdown timeout.
        expect(Date.now() - start0).toBeLessThan(1_000);
        await stream.body?.cancel().catch(() => {});
    });

    it("exits on SIGINT under Bun while a client holds a stream", async () => {
        // --- Given --- docket mcp, which runs on Bun, with a stream open.
        const dir = corpusDir();
        const path = writeConfig(
            `listen: "127.0.0.1:0"\nsources:\n  shop:\n    dir: ${dir}\n`,
        );
        const cli = new URL("../../cli/src/index.ts", import.meta.url);
        const child = spawn("bun", [cli.pathname, "mcp", "-c", path]);
        let err = "";
        child.stderr.on("data", (b: Buffer) => {
            err += b.toString();
        });
        const addr = await new Promise<string>((done, fail) => {
            const timer = setTimeout(() => fail(new Error(err)), 20_000);
            child.stderr.on("data", () => {
                const m = /listening on (\S+)/.exec(err);
                if (m === null) return;
                clearTimeout(timer);
                done(m[1] as string);
            });
        });
        const url = `http://${addr}/mcp`;
        const headers = {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
        };
        const init = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "t", version: "1" },
                },
            }),
        });
        const sid = init.headers.get("mcp-session-id") as string;
        await init.text();
        const stream = await fetch(url, {
            headers: { accept: "text/event-stream", "mcp-session-id": sid },
        });
        expect(stream.status).toBe(200);
        const exited = new Promise<number | null>((r) => child.on("exit", r));

        // --- When ---
        child.kill("SIGINT");
        const have = await Promise.race([
            exited,
            new Promise<string>((r) => setTimeout(() => r("running"), 3_000)),
        ]);

        // --- Then ---
        if (have === "running") child.kill("SIGKILL");
        expect(have).toBe(0);
        await stream.body?.cancel().catch(() => {});
    });

    // go: Test_run_http_serves_gap_tools_when_configured
    it("serves the gap tools when configured", async () => {
        // --- Given ---
        const dir = corpusDir();
        const gapsPath = tempDir();
        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                `gaps: ${gapsPath}\n` +
                `sources:\n  shop:\n    dir: ${dir}\n`,
        );
        const srv = start(path);
        const base = `http://${await waitListening(srv.stderr)}`;
        const client = await connect(base);

        // --- When ---
        const res = await call(client, "report_gap", {
            kind: "missing",
            topic: "t",
            demand: "d",
            detail: "x",
        });

        // --- Then ---
        expect(res.isError).toBeFalsy();
        expect(res.structuredContent).toEqual({ gap_id: "gap-0001" });
        const tools = await client.listTools();
        expect(tools.tools).toHaveLength(11);
        await client.close();

        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();

        expect(srv.stderr.toString()).toContain(`gaps folder at ${gapsPath}`);
        expect(fs.readdirSync(gapsPath)).toEqual(["gap-0001-t.md"]);
    });

    // go: Test_run_http_gap_shapes_match
    it("lists a gap in the same shape over MCP and REST", async () => {
        // --- Given --- one gap filed over REST, partly filled by the corpus
        // document's section, then listed over MCP and REST.
        const dir = corpusDir();
        const gapsPath = tempDir();
        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                `gaps: ${gapsPath}\n` +
                `sources:\n  shop:\n    dir: ${dir}\n`,
        );
        const srv = start(path);
        const base = `http://${await waitListening(srv.stderr)}`;
        const post = (url: string, body: string): Promise<Response> =>
            fetch(`${base}${url}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
            });

        let res = await post(
            "/gaps",
            '{"kind":"wrong","topic":"t","demand":"d","detail":"x",' +
                '"doc_id":"shop/catalog/epub.md"}',
        );
        expect(res.status).toBe(201);
        res = await post(
            "/gaps/gap-0001/fill",
            '{"filled_by":["shop/catalog/epub.md"]}',
        );
        expect(res.status).toBe(200);
        const client = await connect(base);

        // --- When ---
        const tool = await call(client, "list_gaps");
        const rest = await fetch(`${base}/gaps`);

        // --- Then ---
        const hTool = JSON.parse(textOf(tool)) as Record<string, unknown>;
        const hRest = (await rest.json()) as Record<string, unknown>;
        expect(hTool).toEqual(hRest);
        const gap = (hRest["gaps"] as Record<string, unknown>[])[0];
        expect(gap?.["doc_id"]).toBe("shop/catalog/epub.md");
        const want = [
            {
                ref: "shop/catalog/epub.md",
                hash: hash("\nReaders download book data as EPUB."),
            },
        ];
        expect(gap?.["filled_by"]).toEqual(want);
        expect(gap).not.toHaveProperty("stale");

        await client.close();
        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();
    });

    // go: Test_run_project_serves_project_ids_and_glossary
    it("serves project IDs and the glossary", async () => {
        // --- Given ---
        const port = await freePort();
        const path = writeProject(port, port);
        const root = dirname(path);
        const srv = start(path);
        await waitListening(srv.stderr);
        // The listener binds every interface; the MCP handler accepts a
        // loopback Host only.
        const client = await connect(`http://127.0.0.1:${port}`);

        // --- When ---
        const docs = await call(client, "list_docs");

        // --- Then --- document paths are relative to the project root.
        expect(docs.isError).toBeFalsy();
        const have = (docs.structuredContent as { docs: unknown[] }).docs;
        expect(have).toContainEqual({
            id: "upstream/glossary/main.md",
            path: "upstream/glossary/main.md",
            rank: 2,
            title: "Main",
        });
        expect(have).toContainEqual(
            expect.objectContaining({
                id: "kb/users.md",
                path: "kb/users.md",
                rank: 1,
            }),
        );
        const srd = have.find(
            (d) => (d as { id: string }).id === "upstream/initiatives/srd.md",
        ) as Record<string, unknown>;
        expect(srd["path"]).toBe("upstream/initiatives/srd.md");
        expect(srd).not.toHaveProperty("rank");

        // --- Then --- the glossary lists its terms.
        const gls = await call(client, "glossary_terms");
        expect(gls.isError).toBeFalsy();
        expect(textOf(gls)).toContain('"term":"Stock Keeping Unit (SKU)"');
        expect(textOf(gls)).not.toContain("Users");

        // --- Then --- MCP adds glossary_terms and the gap tools.
        expect((await client.listTools()).tools).toHaveLength(12);
        await client.close();

        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();

        const out = srv.stderr.toString();
        const want =
            `project ${root}: mcp-server "srd" on port ${port}\n` +
            `source kb at ${join(root, "kb")}\n` +
            `source upstream at ${join(root, "upstream")}\n` +
            `gaps folder at ${join(root, "gaps")}\n` +
            "glossary at upstream/glossary\n" +
            "precedence kb, upstream\n" +
            "initiatives at upstream/initiatives\n";
        expect(out).toContain(want);
        expect(out).not.toContain("warning");
    });

    // go: Test_run_project_warns_without_mcp_json
    it("warns about a project without .mcp.json", async () => {
        // --- Given ---
        const port = await freePort();
        const path = writeProject(port, 0);
        const srv = start(path);
        await waitListening(srv.stderr);

        // --- When ---
        srv.ctl.abort();

        // --- Then ---
        await expect(srv.done).resolves.toBeUndefined();
        const want =
            `warning: no .mcp.json in ${dirname(path)}; cannot confirm ` +
            'that mcp-server "srd" is registered on port ';
        expect(srv.stderr.toString()).toContain(want);
    });

    // go: Test_run_project_error_port_mismatch
    it("errors for a project port mismatch", async () => {
        // --- Given ---
        const path = writeProject(7777, 7778);
        const stderr = new Collector();

        // --- When ---
        const have = run({ config: path, version: "0.0.0-test", stderr });

        // --- Then ---
        const want =
            'server "srd" URL http://localhost:7778/mcp uses port 7778, ' +
            "but mcp-port is 7777";
        await expect(have).rejects.toThrow(want);
        expect(stderr.toString()).toBe("");
    });

    // go: Test_run_project_error_misspelled_precedence
    it("errors for a misspelled precedence entry", async () => {
        // --- Given ---
        const path = writeProject(7777, 7777);
        const front = fs.readFileSync(path, "utf8");
        fs.writeFileSync(
            path,
            front.replace("[kb, upstream]", "[kb, upstraem]"),
        );
        const stderr = new Collector();

        // --- When ---
        const have = run({ config: path, version: "0.0.0-test", stderr });

        // --- Then ---
        const want = /precedence entry "upstraem": stat .*no such file/;
        await expect(have).rejects.toThrow(want);
        expect(stderr.toString()).toBe("");
    });

    // go: Test_run_project_error_gaps_dir_missing
    it("errors for a project without its gaps folder", async () => {
        // --- Given ---
        const path = writeProject(7777, 7777);
        fs.rmdirSync(join(dirname(path), "gaps"));
        const stderr = new Collector();

        // --- When ---
        const have = run({ config: path, version: "0.0.0-test", stderr });

        // --- Then ---
        await expect(have).rejects.toThrow("gaps folder: stat ");
        expect(stderr.toString()).toBe("");
    });

    // go: Test_run_stdio_serves_single_client
    it("serves a single client over stdio", async () => {
        // --- Given ---
        const dir = corpusDir();
        const path = writeConfig(`sources:\n  shop:\n    dir: ${dir}\n`);
        const srvIn = new PassThrough();
        const cliIn = new PassThrough();
        const srv = start(path, { stdio: true, stdin: srvIn, stdout: cliIn });
        const client = new Client({ name: "test", version: "0.1.0" });
        await client.connect(new StdioServerTransport(cliIn, srvIn));

        // --- When ---
        const have = await call(client, "search", { query: "EPUB" });

        // --- Then ---
        expect(have.isError).toBeFalsy();

        await client.close();
        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();

        expect(srv.stderr.toString()).toContain("indexed 1 documents");
    });

    // go: Test_run_watch_reindexes_on_change
    it("reindexes a changed source", async () => {
        // --- Given ---
        const dir = corpusDir();
        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                "watch:\n  enabled: true\n  debounce: 20ms\n" +
                `sources:\n  shop:\n    dir: ${dir}\n`,
        );
        const srv = start(path);
        const base = `http://${await waitListening(srv.stderr)}`;
        await waitOutput(srv.stderr, "watching sources for changes");

        // --- When ---
        writeMD(dir, "formats/paperback.md", "Couriers ship paperbacks.\n");

        // --- Then ---
        await waitOutput(srv.stderr, "reindexed 2 documents");

        const client = await connect(base);
        const have = await call(client, "search", { query: "paperback" });
        expect(textOf(have)).toContain("shop/formats/paperback.md");
        await client.close();

        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();

        const want = "watching sources for changes (debounce 20ms)";
        expect(srv.stderr.toString()).toContain(want);
    });

    // go: Test_run_watch_failed_reindex_keeps_index
    it("keeps the index when a reindex fails", async () => {
        // --- Given ---
        const dir = join(tempDir(), "corpus");
        writeMD(dir, "epub.md", "Readers download book data as EPUB.\n");
        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                "watch:\n  enabled: true\n  debounce: 20ms\n" +
                `sources:\n  shop:\n    dir: ${dir}\n`,
        );
        const srv = start(path);
        const base = `http://${await waitListening(srv.stderr)}`;

        // --- When ---
        fs.rmSync(dir, { recursive: true, force: true });

        // --- Then ---
        await waitOutput(
            srv.stderr,
            "reindex failed, serving previous index: ingest source shop",
        );

        const client = await connect(base);
        const have = await call(client, "search", { query: "EPUB" });
        expect(textOf(have)).toContain("shop/epub.md");
        await client.close();

        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();
    });

    // go: Test_run_logs_internal_request_error
    it("logs an internal request error", async () => {
        // --- Given ---
        const dir = corpusDir();
        const path = writeConfig(
            `listen: "127.0.0.1:0"\nsources:\n  shop:\n    dir: ${dir}\n`,
        );
        const srv = start(path);
        const base = `http://${await waitListening(srv.stderr)}`;
        fs.rmSync(join(dir, "catalog/epub.md"));
        const client = await connect(base);

        // --- When ---
        const have = await call(client, "get_doc", {
            id: "shop/catalog/epub.md",
        });

        // --- Then ---
        expect(have.isError).toBe(true);
        expect(textOf(have)).toBe("internal error");

        const want = "request failed: read shop/catalog/epub.md: open ";
        expect(srv.stderr.toString()).toContain(want);
        await client.close();

        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();
    });

    // go: Test_run_error_watch_setup
    it("refuses to start when a source cannot be watched", async () => {
        // --- Given ---
        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                "watch:\n  enabled: true\n" +
                "sources:\n  gone:\n    dir: /no/such/dir\n",
        );
        const stderr = new Collector();

        // --- When ---
        const have = run({ config: path, version: "0.0.0-test", stderr });

        // --- Then ---
        await expect(have).rejects.toThrow("watch sources: watch /no/such/dir");
        expect(stderr.toString()).toBe("");
    });

    // go: Test_runWith_error_watcher_setup
    it("errors when the source watcher fails to start", async () => {
        // --- Given ---
        const dir = corpusDir();
        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                "watch:\n  enabled: true\n" +
                `sources:\n  shop:\n    dir: ${dir}\n`,
        );
        // Nothing reaches stderr: the failure comes before ingest and
        // listening.
        const stderr = new Collector();
        let haveDirs: string[] = [];
        const newWatcher = (dirs: string[]): Watcher => {
            haveDirs = dirs;
            throw new Error("inotify watch limit reached");
        };

        // --- When ---
        const have = run({
            config: path,
            version: "0.0.0-test",
            stderr,
            newWatcher,
        });

        // --- Then ---
        const want = "watch sources: inotify watch limit reached";
        await expect(have).rejects.toThrow(want);
        expect(haveDirs).toEqual([dir]);
        expect(stderr.toString()).toBe("");
    });

    // go: Test_runWith_error_gap_watcher_setup
    it("errors when the gap watcher fails to start", async () => {
        // --- Given ---
        const dir = corpusDir();
        const gapsPath = tempDir();
        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                `gaps: ${gapsPath}\n` +
                "watch:\n  enabled: true\n" +
                `sources:\n  shop:\n    dir: ${dir}\n`,
        );
        const stderr = new Collector();
        const haveDirs: string[][] = [];
        const newWatcher = (dirs: string[]): Watcher => {
            haveDirs.push(dirs);
            if (haveDirs.length === 1) return nopWatcher();
            throw new Error("inotify watch limit reached");
        };

        // --- When ---
        const have = run({
            config: path,
            version: "0.0.0-test",
            stderr,
            newWatcher,
        });

        // --- Then ---
        const want = "watch gaps folder: inotify watch limit reached";
        await expect(have).rejects.toThrow(want);
        expect(haveDirs).toEqual([[dir], [gapsPath]]);
        expect(stderr.toString()).toBe("");
    });

    // go: Test_run_search_never_returns_gap
    it("never returns a gap from search", async () => {
        // --- Given --- a gap whose topic words the corpus never uses.
        const dir = corpusDir();
        const gapsPath = tempDir();
        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                `gaps: ${gapsPath}\n` +
                `sources:\n  shop:\n    dir: ${dir}\n`,
        );
        const srv = start(path);
        const client = await connect(
            `http://${await waitListening(srv.stderr)}`,
        );
        const rep = await call(client, "report_gap", {
            kind: "missing",
            topic: "Zebra quokka migration",
            demand: "Zebra quokka migration",
            detail: "Zebra quokka",
            search_terms: ["zebra quokka"],
        });
        expect(rep.structuredContent).toEqual({ gap_id: "gap-0001" });

        // --- When ---
        const have = await call(client, "search", {
            query: "Zebra quokka migration",
        });

        // --- Then ---
        expect(have.isError).toBeFalsy();
        expect(textOf(have)).toBe('{"results":[]}');

        const gaps = await call(client, "list_gaps", {
            query: "Zebra quokka migration",
        });
        expect(textOf(gaps)).toContain('"id":"gap-0001"');
        await client.close();

        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();
        expect(srv.stderr.toString()).toContain("indexed 0 gaps in ");
    });

    // go: Test_run_watch_reindexes_gaps_on_edit
    it("reindexes a gap edited on disk", async () => {
        // --- Given --- three gaps written before the start, all matching
        // the query by a search term and gap-0002 also by its topic, which
        // is rewritten on disk while serving, leaving the three tied in ID
        // order.
        const dir = corpusDir();
        const gapsPath = tempDir();
        const seed = newSeed(gapsPath);
        for (const topic of [
            "Shipping rates",
            "EPUB download token lifetime",
            "Gift card expiry",
        ]) {
            await seed.append(newGap(topic, { searchTerms: ["download"] }));
        }
        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                `gaps: ${gapsPath}\n` +
                "watch:\n  enabled: true\n  debounce: 20ms\n" +
                `sources:\n  shop:\n    dir: ${dir}\n`,
        );
        const srv = start(path);
        const client = await connect(
            `http://${await waitListening(srv.stderr)}`,
        );
        await waitOutput(srv.stderr, "watching gaps folder for changes");
        const query = { query: "download token" };
        const before = gapsOf(await call(client, "list_gaps", query));
        expect(before[0]?.["id"]).toBe("gap-0002");

        const name = join(gapsPath, "gap-0002-epub-download-token-lifetime.md");
        const raw = fs
            .readFileSync(name, "utf8")
            .replace("# EPUB download token lifetime", "# EPUB file size");

        // --- When ---
        fs.writeFileSync(name, raw);

        // --- Then ---
        await waitOutput(srv.stderr, "reindexed 3 gaps in ");

        const have = gapsOf(await call(client, "list_gaps", query));
        expect(have).toHaveLength(3);
        expect(have[0]?.["id"]).toBe("gap-0001");
        expect(have[1]?.["id"]).toBe("gap-0002");
        expect(have[1]?.["topic"]).toBe("EPUB file size");
        await client.close();

        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();
        expect(srv.stderr.toString()).toContain("indexed 3 gaps in ");
        expect(srv.stderr.toString()).toContain(
            "watching gaps folder for changes",
        );
    });

    // go: Test_run_watch_reindexes_gaps_in_new_closed_folder
    it("reindexes a gap in a closed folder created while serving", async () => {
        // --- Given --- an empty gaps folder served with watching on, whose
        // closed folder is created only after the start, then a wontfix
        // gap file written into it.
        const gapsPath = tempDir();
        const seedPath = tempDir();
        const seed = newSeed(seedPath);
        await seed.append(newGap("Zebra quokka"));
        await seed.wontfix("gap-0001", "why");
        const name = "gap-0001-zebra-quokka.md";
        const raw = fs.readFileSync(join(seedPath, CLOSED_DIR, name), "utf8");

        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                `gaps: ${gapsPath}\n` +
                "watch:\n  enabled: true\n  debounce: 20ms\n" +
                `sources:\n  shop:\n    dir: ${corpusDir()}\n`,
        );
        const srv = start(path);
        const base = `http://${await waitListening(srv.stderr)}`;
        const closed = join(gapsPath, CLOSED_DIR);
        fs.mkdirSync(closed);
        await waitOutput(srv.stderr, "reindexed 0 gaps in ");

        // --- When ---
        fs.writeFileSync(join(closed, name), raw);

        // --- Then ---
        await waitOutput(srv.stderr, "reindexed 1 gaps in ");

        const client = await connect(base);
        const have = gapsOf(
            await call(client, "list_gaps", { query: "quokka" }),
        );
        expect(have).toHaveLength(1);
        expect(have[0]?.["file"]).toBe(`closed/${name}`);
        expect(have[0]?.["status"]).toBe("wontfix");
        await client.close();

        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();
    });

    // go: Test_run_tidies_gaps_on_start
    it("tidies the gaps folder on start", async () => {
        // --- Given --- a wontfix gap at the top of the gaps folder, as an
        // old flat layout keeps it.
        const gapsPath = tempDir();
        const seed = newSeed(gapsPath);
        await seed.append(newGap("t"));
        await seed.wontfix("gap-0001", "why");
        const closed = join(gapsPath, CLOSED_DIR);
        fs.renameSync(
            join(closed, "gap-0001-t.md"),
            join(gapsPath, "gap-0001-t.md"),
        );
        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                `gaps: ${gapsPath}\n` +
                `sources:\n  shop:\n    dir: ${corpusDir()}\n`,
        );

        // --- When ---
        const srv = start(path);

        // --- Then ---
        await waitListening(srv.stderr);
        const out = srv.stderr.toString();
        expect(out).toContain("moved gap-0001-t.md to closed/\n");
        expect(out).toContain("indexed 1 gaps in ");
        expect(fs.readdirSync(gapsPath)).toEqual([CLOSED_DIR]);
        expect(fs.readdirSync(closed)).toEqual(["gap-0001-t.md"]);

        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();
    });

    // go: Test_run_watch_flags_stale_gap
    it("flags a gap stale when its filling section changes", async () => {
        // --- Given --- a gap filled by a section, served with watching on,
        // then the section edited on disk.
        const dir = tempDir();
        writeMD(dir, "epub.md", "## Tokens\n\nValid 24h.\n\n## Other\n");
        const gapsPath = tempDir();
        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                `gaps: ${gapsPath}\n` +
                "watch:\n  enabled: true\n  debounce: 20ms\n" +
                `sources:\n  shop:\n    dir: ${dir}\n`,
        );
        const srv = start(path);
        const client = await connect(
            `http://${await waitListening(srv.stderr)}`,
        );
        await waitOutput(srv.stderr, "watching sources for changes");

        const rep = await call(client, "report_gap", {
            kind: "wrong",
            topic: "t",
            demand: "d",
            detail: "x",
        });
        expect(rep.structuredContent).toEqual({ gap_id: "gap-0001" });
        const fill = await call(client, "fill_gap", {
            gap_id: "gap-0001",
            filled_by: ["shop/epub.md#tokens"],
            complete: true,
        });
        expect(fill.isError).toBeFalsy();
        const before = gapsOf(await call(client, "list_gaps", { stale: true }));
        expect(before).toHaveLength(0);

        // --- When ---
        writeMD(dir, "epub.md", "## Tokens\n\nValid 48h.\n\n## Other\n");

        // --- Then ---
        await waitOutput(srv.stderr, "stale gaps (1): gap-0001");

        const have = gapsOf(await call(client, "list_gaps", { stale: true }));
        expect(have).toHaveLength(1);
        expect(have[0]?.["status"]).toBe("filled");
        const want = [{ ref: "shop/epub.md#tokens", reason: "changed" }];
        expect(have[0]?.["stale_refs"]).toEqual(want);
        await client.close();

        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();
    });

    // go: Test_run_quarantines_invalid_gap
    it("quarantines an invalid gap file", async () => {
        // --- Given --- three gaps written before the start, the highest
        // numbered one with broken YAML; watching is off.
        const dir = corpusDir();
        const gapsPath = tempDir();
        const seed = newSeed(gapsPath);
        for (const topic of [
            "Shipping rates",
            "Gift card expiry",
            "EPUB download token lifetime",
        ]) {
            await seed.append(newGap(topic));
        }
        const brokenName = "gap-0003-epub-download-token-lifetime.md";
        const brokenPath = join(gapsPath, brokenName);
        const good = fs.readFileSync(brokenPath, "utf8");
        const broken = good.replace("status: open", "status: [open");
        fs.writeFileSync(brokenPath, broken);

        const path = writeConfig(
            'listen: "127.0.0.1:0"\n' +
                `gaps: ${gapsPath}\n` +
                `sources:\n  shop:\n    dir: ${dir}\n`,
        );
        const srv = start(path);
        const client = await connect(
            `http://${await waitListening(srv.stderr)}`,
        );

        // --- When ---
        const have = await call(client, "list_gaps");

        // --- Then ---
        const want = `invalid gap file ${brokenName}: front matter: yaml: `;
        expect(srv.stderr.toString()).toContain(want);
        expect(srv.stderr.toString()).toContain("indexed 2 gaps in ");

        expect(have.isError).toBeFalsy();
        const list = have.structuredContent as {
            gaps: { id: string }[];
            invalid: { file: string; reason: string }[];
        };
        expect(list.gaps.map((g) => g.id)).toEqual(["gap-0001", "gap-0002"]);
        expect(list.invalid).toHaveLength(1);
        expect(list.invalid[0]?.file).toBe(brokenName);
        expect(list.invalid[0]?.reason).toContain("front matter: yaml: ");

        // --- Then --- the valid gaps keep working.
        let res = await call(client, "list_gaps", { query: "gift" });
        expect(res.isError).toBeFalsy();
        expect(textOf(res)).toContain('"id":"gap-0002"');
        res = await call(client, "list_gaps", { query: "download" });
        expect(res.isError).toBeFalsy();
        expect(textOf(res)).toContain('"gaps":[]');
        res = await call(client, "update_gap", {
            gap_id: "gap-0001",
            add_hit: true,
        });
        expect(res.isError).toBeFalsy();
        res = await call(client, "fill_gap", {
            gap_id: "gap-0002",
            filled_by: ["shop/catalog/epub.md"],
            complete: true,
        });
        expect(res.isError).toBeFalsy();
        res = await call(client, "report_gap", {
            kind: "wrong",
            topic: "New",
            demand: "d",
            detail: "x",
        });
        expect(res.isError).toBeFalsy();
        expect(textOf(res)).toBe('{"gap_id":"gap-0004"}');

        // --- Then --- every operation on the invalid gap is refused.
        for (const [name, args] of [
            ["update_gap", { add_hit: true }],
            ["discard_gap", {}],
            ["submit_gap", {}],
            ["fill_gap", { filled_by: ["shop/catalog/epub.md"] }],
            ["reopen_gap", { reason: "r" }],
            ["wontfix_gap", { reason: "r" }],
        ] as const) {
            res = await call(client, name, { gap_id: "gap-0003", ...args });
            expect(res.isError, name).toBe(true);
            expect(textOf(res), name).toContain(
                `invalid gap file ${brokenName}: `,
            );
        }
        expect(fs.readFileSync(brokenPath, "utf8")).toBe(broken);

        // --- Then --- fixing the file makes it valid without a restart.
        fs.writeFileSync(brokenPath, good);
        res = await call(client, "list_gaps", { query: "download" });
        expect(res.isError).toBeFalsy();
        expect(textOf(res)).toContain('"id":"gap-0003"');
        expect(textOf(res)).toContain('"invalid":[]');
        res = await call(client, "wontfix_gap", {
            gap_id: "gap-0003",
            reason: "r",
        });
        expect(res.isError).toBeFalsy();
        await client.close();

        srv.ctl.abort();
        await expect(srv.done).resolves.toBeUndefined();
    });
});

describe("run with a relative config path", () => {
    it("reads the documents under the working directory", async () => {
        // --- Given --- the CLI's default `-c docket-mcp.yaml`, relative to the
        // directory it runs in.
        const dir = fs.mkdtempSync(join(tmpdir(), "mcp-rel-"));
        try {
            fs.mkdirSync(join(dir, "docs"));
            fs.writeFileSync(join(dir, "docs/a.md"), "# A\n\nAlpha text.\n");
            fs.writeFileSync(
                join(dir, "docket-mcp.yaml"),
                "sources:\n  d:\n    dir: docs\n",
            );
            const rpc = [
                {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                        protocolVersion: "2025-06-18",
                        capabilities: {},
                        clientInfo: { name: "t", version: "1" },
                    },
                },
                { jsonrpc: "2.0", method: "notifications/initialized" },
                {
                    jsonrpc: "2.0",
                    id: 2,
                    method: "tools/call",
                    params: { name: "get_doc", arguments: { id: "d/a.md" } },
                },
            ];
            const cli = new URL("../../cli/src/index.ts", import.meta.url);

            // --- When --- input stays open until the call is answered, as
            // stdio serving ends with its input.
            const child = spawn("bun", [cli.pathname, "mcp", "--stdio"], {
                cwd: dir,
            });
            const have = await new Promise<string>((done, fail) => {
                let out = "";
                const timer = setTimeout(() => fail(new Error(out)), 20_000);
                child.stdout.on("data", (b: Buffer) => {
                    out += b.toString();
                    const line = out
                        .split("\n")
                        .find((l) => l.includes('"id":2'));
                    if (line === undefined) return;
                    clearTimeout(timer);
                    child.stdin.end();
                    done(line);
                });
                for (const m of rpc)
                    child.stdin.write(`${JSON.stringify(m)}\n`);
            });

            // --- Then ---
            const call = [JSON.parse(have) as { result: CallToolResult }];
            expect(call).toHaveLength(1);
            expect(call[0]?.result.isError).toBeFalsy();
            expect(JSON.stringify(call[0]?.result)).toContain("Alpha text.");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
