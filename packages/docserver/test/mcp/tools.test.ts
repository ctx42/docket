// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { FileStore } from "../../src/gaps/file-store.ts";
import { Glossary } from "../../src/glossary/glossary.ts";
import { TOOL_DEFS } from "../../src/mcp/tool-defs.ts";
import {
    clientError,
    errorResult,
    RPCError,
    SERVER_NAME,
    sortKeys,
    ToolError,
    Tools,
} from "../../src/mcp/tools.ts";
import { IndexTracker } from "../../src/watch/status.ts";
import { readGolden } from "../support/golden.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";
import {
    bookshop,
    connect,
    contentText,
    decode,
    glossaryEngine,
    identityEngine,
    newEngine,
    ROOT,
    rankEngine,
} from "./support.ts";

/** names returns the tool names a client lists. */
async function names(client: Awaited<ReturnType<typeof connect>>) {
    return (await client.listTools()).tools.map((t) => t.name);
}

/** newStore returns an empty in-memory gap store. */
function newStore(): FileStore {
    const fs = new MemDocFs().mkdirp("/gaps");
    return new FileStore(
        fs,
        "/gaps",
        () => ({ unix: 0, nsec: 0, offset: 0 }),
        undefined,
    );
}

interface Section {
    id: string;
    path: string;
    title: string;
    rank?: number;
    source_url?: string;
    text: string;
}

describe("tools/list", () => {
    // go: Test_New_registers_tools
    it("registers the read tools", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({ engine, version: "0.0.0-test" });

        // --- When ---
        const have = await names(client);

        // --- Then ---
        expect(have).toHaveLength(4);
        expect(have).toEqual(
            expect.arrayContaining(["search", "get_doc", "list_docs"]),
        );
    });

    // go: Test_New_registers_gap_tools_only_with_store
    it("registers the gap tools with a store", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({
            engine,
            version: "x",
            store: newStore(),
        });

        // --- When ---
        const have = await names(client);

        // --- Then ---
        expect(have).toHaveLength(12);
        expect(have).toEqual(
            expect.arrayContaining([
                "report_gap",
                "list_gaps",
                "update_gap",
                "submit_gap",
                "discard_gap",
                "fill_gap",
                "reopen_gap",
                "wontfix_gap",
            ]),
        );
        expect(have).not.toContain("glossary_terms");
    });

    // go: Test_New_registers_glossary_tool_only_with_glossary
    it("registers the glossary tool with a glossary", async () => {
        // --- Given ---
        const { engine } = await glossaryEngine();
        const glossary = new Glossary(engine, "shop/glossary");
        const client = await connect({ engine, version: "x", glossary });

        // --- When ---
        const have = await names(client);

        // --- Then ---
        expect(have).toHaveLength(5);
        expect(have).toContain("glossary_terms");
        expect(have).not.toContain("report_gap");
    });

    // go: Test_New_omits_gap_tools_without_store
    it("omits the gap tools without a store", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const have = await names(client);

        // --- Then ---
        expect(have).toEqual(["check_refs", "get_doc", "list_docs", "search"]);
    });

    it("equals the Go server's tools/list and server info", async () => {
        // --- Given ---
        const golden = readGolden<{
            serverInfo: { name: string; version: string };
            tools: unknown[];
        }>(new URL("testdata/tools.golden.json", import.meta.url));
        const { deps } = await bookshop();
        const client = await connect(deps);

        // --- When ---
        const have = await client.listTools();

        // --- Then ---
        expect(have.tools).toEqual(golden.tools);
        expect(TOOL_DEFS).toEqual(golden.tools);
        expect(client.getServerVersion()).toEqual(golden.serverInfo);
        expect(client.getServerCapabilities()).toEqual({
            logging: {},
            tools: { listChanged: true },
        });
        expect(SERVER_NAME).toBe("docket");
    });
});

describe("search", () => {
    // go: Test_tools_search
    it("returns ranked sections with citations", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const res = await client.callTool({
            name: "search",
            arguments: { query: "EPUB" },
        });

        // --- Then ---
        expect(res.isError).toBeFalsy();
        const have = decode<{ results: Section[] }>(res);
        expect(have.results).toHaveLength(1);
        expect(have.results[0]?.id).toBe("shop/catalog/epub.md");
        expect(have.results[0]?.path).toBe("shop/catalog/epub.md");
        expect(have.results[0]?.title).toBe("EPUB Editions");
        expect(have.results[0]?.source_url).toBe(
            "https://docs.example.com/epub",
        );
    });

    // go: Test_tools_search_error_tabular
    it.each([
        ["error - empty query", { query: " " }, "query is required"],
        [
            "error - negative k",
            { query: "EPUB", k: -1 },
            "k must be between 1 and 100",
        ],
        [
            "error - k over limit",
            { query: "EPUB", k: 101 },
            "k must be between 1 and 100",
        ],
    ])("%s", async (_name, args, want) => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const res = await client.callTool({ name: "search", arguments: args });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toContain(want);
    });

    it("keeps only the sections of a folder", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const inside = await client.callTool({
            name: "search",
            arguments: { query: "EPUB", folder: "shop/catalog" },
        });
        const outside = await client.callTool({
            name: "search",
            arguments: { query: "EPUB", folder: "shop/guides" },
        });

        // --- Then ---
        expect(decode<{ results: Section[] }>(inside).results).toHaveLength(1);
        expect(decode<{ results: Section[] }>(outside).results).toEqual([]);
    });

    // go: Test_tools_search_carries_identity_and_path
    it("carries the identity and path", async () => {
        // --- Given ---
        const { engine } = await identityEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const res = await client.callTool({
            name: "search",
            arguments: { query: "License Plan" },
        });

        // --- Then ---
        const have = decode<{ results: Section[] }>(res);
        expect(have.results[0]?.id).toBe("doc-12");
        expect(have.results[0]?.path).toBe("shop/g.md");
        expect(have.results[0]?.source_url).toBe("https://docs.example.com/g");
    });

    // go: Test_tools_search_carries_rank
    it("carries the trust rank", async () => {
        // --- Given ---
        const client = await connect({
            engine: await rankEngine(),
            version: "x",
        });

        // --- When ---
        const res = await client.callTool({
            name: "search",
            arguments: { query: "turbine" },
        });

        // --- Then ---
        const have = decode<{ results: Section[] }>(res);
        const ranks = Object.fromEntries(
            have.results.map((h) => [h.path, h.rank]),
        );
        expect(ranks).toEqual({
            "kb/a.md": 1,
            "doc/reference/b.md": 4,
            "doc/misc/c.md": 5,
            "initiatives/srd.md": undefined,
        });
    });
});

describe("page_status", () => {
    it("asks the page port about each document's file", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        let asked: readonly string[] = [];
        const pages = async (files: readonly string[]) => {
            asked = files;
            return files.map((file) => ({
                file,
                state: "remote-moved",
                localVersion: 77,
                remoteVersion: 78,
                reason: "",
            }));
        };
        const client = await connect({ engine, version: "x", pages });

        // --- When ---
        const res = await client.callTool({
            name: "page_status",
            arguments: { refs: ["shop/catalog/epub.md", "gone.md"] },
        });

        // --- Then ---
        expect(res.isError).toBeFalsy();
        expect(asked).toEqual(["/shop/catalog/epub.md"]);
        expect(decode(res)).toEqual({
            pages: [
                {
                    ref: "shop/catalog/epub.md",
                    id: "shop/catalog/epub.md",
                    path: "shop/catalog/epub.md",
                    state: "remote-moved",
                    local_version: 77,
                    remote_version: 78,
                    reason: "",
                },
                {
                    ref: "gone.md",
                    state: "unknown",
                    reason: '"gone.md" names no corpus document',
                },
            ],
        });
    });

    it("refuses an empty list", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({
            engine,
            version: "x",
            pages: async () => [],
        });

        // --- When ---
        const res = await client.callTool({
            name: "page_status",
            arguments: { refs: [] },
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toContain(
            "refs must hold 1 to 100 references",
        );
    });

    it("is not offered without a page port", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const have = (await client.listTools()).tools.map((t) => t.name);

        // --- Then ---
        expect(have).not.toContain("page_status");
    });
});

describe("index_status", () => {
    it("reports the index, and reindexes when asked", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const index = new IndexTracker(engine, () => 0, true);
        index.signal();
        const client = await connect({ engine, version: "x", index });

        // --- When ---
        const before = decode(
            await client.callTool({ name: "index_status", arguments: {} }),
        );
        const after = decode(
            await client.callTool({
                name: "index_status",
                arguments: { reindex: true },
            }),
        );

        // --- Then ---
        expect(before).toEqual({
            generation: 0,
            indexed_at: "1970-01-01T00:00:00.000Z",
            docs: 1,
            watching: true,
            pending: true,
            last_error: "",
        });
        expect(after).toMatchObject({ generation: 1, pending: false });
    });

    it("is not offered without an index tracker", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const have = (await client.listTools()).tools.map((t) => t.name);

        // --- Then ---
        expect(have).not.toContain("index_status");
    });
});

describe("check_refs", () => {
    it("reports each reference", async () => {
        // --- Given ---
        const { engine } = await identityEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const res = await client.callTool({
            name: "check_refs",
            arguments: { refs: ["doc-12#license-plan", "gone.md"] },
        });

        // --- Then ---
        expect(res.isError).toBeFalsy();
        expect(decode(res)).toEqual({
            refs: [
                {
                    ref: "doc-12#license-plan",
                    found: true,
                    match: "id",
                    id: "doc-12",
                    path: "shop/g.md",
                    anchor: "license-plan",
                },
                {
                    ref: "gone.md",
                    found: false,
                    reason: '"gone.md" names no corpus document',
                    candidates: [],
                },
            ],
        });
    });

    it.each([
        ["no refs", { refs: [] }, "refs must hold 1 to 100 references"],
        [
            "too many refs",
            { refs: Array.from({ length: 101 }, (_, i) => `r${i}`) },
            "refs must hold 1 to 100 references",
        ],
    ])("refuses %s", async (_, args, want) => {
        // --- Given ---
        const { engine } = await identityEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const res = await client.callTool({
            name: "check_refs",
            arguments: args,
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toContain(want);
    });
});

describe("get_doc", () => {
    // go: Test_tools_getDoc
    it("returns the whole document", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const res = await client.callTool({
            name: "get_doc",
            arguments: { id: "shop/catalog/epub.md" },
        });

        // --- Then ---
        expect(res.isError).toBeFalsy();
        const have = decode<Section>(res);
        expect(have.id).toBe("shop/catalog/epub.md");
        expect(have.path).toBe("shop/catalog/epub.md");
        expect(have.title).toBe("EPUB Editions");
        expect(have.text).toContain("Readers download book data as EPUB.");
    });

    it("returns one section for an id with an anchor", async () => {
        // --- Given ---
        const { engine } = await identityEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const res = await client.callTool({
            name: "get_doc",
            arguments: { id: "doc-12#license-plan" },
        });

        // --- Then ---
        expect(res.isError).toBeFalsy();
        const have = decode<Section>(res);
        expect(have.id).toBe("doc-12");
        expect(have.text).toMatch(
            /^## License Plan\n\nA contracted service tier\./,
        );
        expect(have.text).not.toContain("## Overview");
    });

    // go: Test_tools_getDoc_by_id_or_path_tabular
    it.each([
        ["by id", "doc-12"],
        ["by path", "shop/g.md"],
    ])("finds a document %s", async (_name, ref) => {
        // --- Given ---
        const { engine } = await identityEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const res = await client.callTool({
            name: "get_doc",
            arguments: { id: ref },
        });

        // --- Then ---
        const have = decode<Section>(res);
        expect(have.id).toBe("doc-12");
        expect(have.path).toBe("shop/g.md");
        expect(have.source_url).toBe("https://docs.example.com/g");
    });

    // go: Test_tools_getDoc_rank_tabular
    it.each([
        ["kb", "kb/a.md", 1],
        ["reference docs", "doc/reference/b.md", 4],
        ["unlisted", "doc/misc/c.md", 5],
        ["initiatives", "initiatives/srd.md", undefined],
    ])("carries the %s rank", async (_name, ref, want) => {
        // --- Given ---
        const client = await connect({
            engine: await rankEngine(),
            version: "x",
        });

        // --- When ---
        const res = await client.callTool({
            name: "get_doc",
            arguments: { id: ref },
        });

        // --- Then ---
        expect(decode<Section>(res).rank).toBe(want);
    });

    // go: Test_tools_getDoc_error_hides_internal_error
    it("hides an internal error", async () => {
        // --- Given ---
        const { engine, mfs } = await (await import("./support.ts")).engineOver(
            {
                "a.md": "alpha\n",
            },
        );
        const logged: unknown[] = [];
        const client = await connect({
            engine,
            version: "x",
            logErr: (err) => logged.push(err),
        });
        mfs.removeAll("/shop/a.md");

        // --- When ---
        const res = await client.callTool({
            name: "get_doc",
            arguments: { id: "shop/a.md" },
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toBe("internal error");
        expect(logged).toHaveLength(1);
    });

    // go: Test_tools_getDoc_unknown_id
    it("reports an unknown id", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const res = await client.callTool({
            name: "get_doc",
            arguments: { id: "does/not/exist.md" },
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toContain("document not found");
    });
});

describe("list_docs", () => {
    // go: Test_tools_listDocs
    it("lists every document", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const res = await client.callTool({ name: "list_docs", arguments: {} });

        // --- Then ---
        expect(decode(res)).toEqual({
            docs: [
                {
                    id: "shop/catalog/epub.md",
                    path: "shop/catalog/epub.md",
                    title: "EPUB Editions",
                },
            ],
        });
    });

    it("lists only the documents of a folder", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const res = await client.callTool({
            name: "list_docs",
            arguments: { folder: "shop/guides" },
        });

        // --- Then ---
        expect(decode(res)).toEqual({ docs: [] });
    });

    it("adds the asked fields of each document", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const res = await client.callTool({
            name: "list_docs",
            arguments: { fields: ["title", "status"] },
        });

        // --- Then ---
        expect(decode(res)).toEqual({
            docs: [
                {
                    id: "shop/catalog/epub.md",
                    path: "shop/catalog/epub.md",
                    title: "EPUB Editions",
                    fields: { title: "EPUB Editions" },
                },
            ],
        });
    });

    // go: Test_tools_listDocs_carries_identity_and_path
    it("carries the identity and path", async () => {
        // --- Given ---
        const { engine } = await identityEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const res = await client.callTool({ name: "list_docs", arguments: {} });

        // --- Then ---
        expect(decode(res)).toEqual({
            docs: [{ id: "doc-12", path: "shop/g.md", title: "G" }],
        });
    });

    // go: Test_tools_listDocs_carries_rank
    it("carries the trust rank", async () => {
        // --- Given ---
        const client = await connect({
            engine: await rankEngine(),
            version: "x",
        });

        // --- When ---
        const res = await client.callTool({ name: "list_docs", arguments: {} });

        // --- Then ---
        expect(decode(res)).toEqual({
            docs: [
                {
                    id: "doc/misc/c.md",
                    path: "doc/misc/c.md",
                    rank: 5,
                    title: "c",
                },
                {
                    id: "doc/reference/b.md",
                    path: "doc/reference/b.md",
                    rank: 4,
                    title: "b",
                },
                {
                    id: "initiatives/srd.md",
                    path: "initiatives/srd.md",
                    title: "srd",
                },
                { id: "kb/a.md", path: "kb/a.md", rank: 1, title: "a" },
            ],
        });
    });
});

describe("glossary_terms", () => {
    // go: Test_glossaryTool_terms
    it("lists the terms", async () => {
        // --- Given ---
        const { engine } = await glossaryEngine();
        const glossary = new Glossary(engine, "shop/glossary");
        const client = await connect({ engine, version: "x", glossary });

        // --- When ---
        const res = await client.callTool({
            name: "glossary_terms",
            arguments: {},
        });

        // --- Then ---
        expect(res.isError).toBeFalsy();
        expect(decode(res)).toEqual({
            terms: [
                {
                    term: "Stock Keeping Unit (SKU)",
                    name: "Stock Keeping Unit",
                    abbreviation: "SKU",
                    id: "shop/glossary/main.md",
                    path: "shop/glossary/main.md",
                    anchor: "stock-keeping-unit-sku",
                    definition: "Identifier of a book edition.",
                },
                {
                    term: "Backorder",
                    name: "Backorder",
                    abbreviation: "",
                    id: "shop/glossary/main.md",
                    path: "shop/glossary/main.md",
                    anchor: "backorder",
                    definition: "Order for an out-of-stock title.",
                },
            ],
        });
    });

    // go: Test_glossaryTool_terms_filter_and_fresh_text
    it("filters and reads the text fresh", async () => {
        // --- Given --- the glossary edited after indexing.
        const { engine, mfs } = await glossaryEngine();
        const glossary = new Glossary(engine, "shop/glossary");
        const client = await connect({ engine, version: "x", glossary });
        mfs.writeFile(
            "/shop/glossary/main.md",
            "## Backorder\n\nEdited definition.\n\n## Asset\n\nx\n",
        );

        // --- When ---
        const res = await client.callTool({
            name: "glossary_terms",
            arguments: { term: "backorder" },
        });

        // --- Then ---
        const have = decode<{ terms: { definition: string }[] }>(res);
        expect(have.terms).toHaveLength(1);
        expect(have.terms[0]?.definition).toBe("Edited definition.");
    });

    // go: Test_glossaryTool_terms_error_hides_internal_error
    it("hides an internal error", async () => {
        // --- Given ---
        const { engine, mfs } = await glossaryEngine();
        const logged: unknown[] = [];
        const glossary = new Glossary(engine, "shop/glossary");
        const client = await connect({
            engine,
            version: "x",
            glossary,
            logErr: (err) => logged.push(err),
        });
        mfs.chmod("/shop/glossary/main.md", 0o000);

        // --- When ---
        const res = await client.callTool({ name: "glossary_terms" });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toBe("internal error");
        expect(logged).toHaveLength(1);
    });
});

describe("tool errors", () => {
    it("answers an unknown tool with a JSON-RPC error", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const client = await connect({ engine, version: "x" });

        // --- When ---
        const call = client.callTool({ name: "nope", arguments: {} });

        // --- Then ---
        await expect(call).rejects.toMatchObject({
            code: -32602,
            message: 'MCP error -32602: unknown tool "nope"',
        });
    });

    it("refuses a gap tool without a store", async () => {
        // --- Given ---
        const { engine } = await newEngine();
        const tools = new Tools({ engine, version: "x" });

        // --- When ---
        const call = tools.call("report_gap", {});

        // --- Then ---
        await expect(call).rejects.toBeInstanceOf(RPCError);
    });

    it("passes client errors through and hides the rest", () => {
        // --- Given ---
        const logged: unknown[] = [];
        const log = (err: unknown) => logged.push(err);

        // --- When ---
        const pass = clientError(log, new ToolError("query is required"));
        const hide = clientError(log, new Error("/secret/path: EIO"));

        // --- Then ---
        expect(pass.message).toBe("query is required");
        expect(hide.message).toBe("internal error");
        expect(logged).toHaveLength(1);
    });

    it("builds error results and sorted output", () => {
        expect(errorResult("x")).toEqual({
            content: [{ type: "text", text: "x" }],
            isError: true,
        });
        expect(
            JSON.stringify(sortKeys({ b: 1, a: [{ d: 1, c: undefined }] })),
        ).toBe('{"a":[{"d":1}],"b":1}');
    });
});

interface CallCase {
    name: string;
    calls: { name: string; arguments?: Record<string, unknown> }[];
}

/** Read-tool calls and Go's raw tools/call results (oracle `call`). */
const cases = readGolden<CallCase[]>(
    new URL("testdata/call-read.cases.json", import.meta.url),
);
const golden = readGolden<{ name: string; results: unknown[] }[]>(
    new URL("testdata/call-read.golden.json", import.meta.url),
);

describe("read tool calls", () => {
    const rows = (cases[0] as CallCase).calls.map(
        (call, i) =>
            [
                i,
                call,
                (golden[0] as { results: unknown[] }).results[i],
            ] as const,
    );

    it.each(rows)("call %i matches the Go server", async (_i, call, want) => {
        // --- Given ---
        const { tools } = await bookshop();

        // --- When ---
        let have: unknown;
        try {
            have = await tools.call(call.name, call.arguments);
        } catch (err) {
            const e = err as RPCError;
            have = { error: { code: e.code, message: e.message } };
        }

        // --- Then ---
        expect(
            JSON.parse(JSON.stringify(have).replaceAll(ROOT, "<root>")),
        ).toEqual(want);
    });
});
