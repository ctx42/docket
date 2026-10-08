// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { Engine } from "../../src/engine/engine.ts";
import { Glossary } from "../../src/glossary/glossary.ts";
import { OPENAPI_YAML } from "../../src/rest/openapi.ts";
import {
    atoi,
    cleanPath,
    parseQuery,
    Rest,
    type RestResponse,
} from "../../src/rest/rest.ts";
import { bookshop, ROOT, rankEngine } from "../mcp/support.ts";
import { readGolden } from "../support/golden.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";

/** goldy reads a Go goldy golden file: the content after its "---" line. */
function goldy(name: string): string {
    const raw = readFileSync(
        new URL(`testdata/${name}`, import.meta.url),
        "utf8",
    );
    return raw.slice(raw.indexOf("\n---\n") + 5);
}

/**
 * newRest builds the Go tests' two-file corpus (and a glossary folder when
 * glossaryPath is set) and the REST router over it.
 */
async function newRest(
    glossaryPath = "",
    logErr?: (err: unknown) => void,
): Promise<{ rest: Rest; fs: MemDocFs }> {
    const fs = new MemDocFs()
        .writeFile(
            "/c/catalog/epub.md",
            "---\ntitle: EPUB Editions\n---\n\n" +
                "Readers download book data as EPUB.\n" +
                "See https://docs.example.com/epub\n",
        )
        .writeFile(
            "/c/intro.md",
            "---\nid: intro-1\ntitle: Intro\n---\n\nThe bookshop overview.\n",
        );
    if (glossaryPath !== "") {
        fs.writeFile(
            "/c/glossary/main.md",
            '---\ntitle: Main\nurl: "https://ex.com/glossary"\n---\n\n' +
                "## Stock Keeping Unit (SKU)\n\n" +
                "Identifier of a book edition.\n\n" +
                "## Backorder\n\nOrder for an out-of-stock title.\n",
        );
    }
    const engine = await Engine.create({
        fs,
        sources: [{ name: "shop", dir: "/c" }],
    });
    const rest = new Rest({
        engine,
        version: "x",
        ...(glossaryPath === ""
            ? {}
            : { glossary: new Glossary(engine, glossaryPath) }),
        ...(logErr === undefined ? {} : { logErr }),
    });
    return { rest, fs };
}

/** get sends a GET for target. */
function get(rest: Rest, target: string): Promise<RestResponse> {
    const q = target.indexOf("?");
    return rest.handle({
        method: "GET",
        path: q < 0 ? target : target.slice(0, q),
        query: q < 0 ? "" : target.slice(q + 1),
    });
}

describe("GET /healthz", () => {
    // go: Test_server_healthz
    it("reports liveness", async () => {
        // --- Given ---
        const { rest } = await newRest();

        // --- When ---
        const have = await get(rest, "/healthz");

        // --- Then ---
        expect(have.status).toBe(200);
        expect(have.headers["Content-Type"]).toBe("application/json");
        expect(have.body).toBe(goldy("healthz.golden"));
    });
});

describe("GET /search", () => {
    // go: Test_server_search
    it("ranks sections", async () => {
        // --- Given ---
        const { rest } = await newRest();

        // --- When ---
        const have = await get(rest, "/search?q=EPUB");

        // --- Then ---
        expect(have.status).toBe(200);
        expect(have.body).toBe(goldy("search.golden"));
    });

    // go: Test_server_search_carries_rank
    it("carries the trust rank", async () => {
        // --- Given ---
        const rest = new Rest({ engine: await rankEngine(), version: "x" });

        // --- When ---
        const have = await get(rest, "/search?q=turbine");

        // --- Then ---
        expect(have.status).toBe(200);
        const body = JSON.parse(have.body) as {
            results: { path: string; rank?: number }[];
        };
        const ranks = Object.fromEntries(
            body.results.map((r) => [r.path, r.rank]),
        );
        expect(ranks).toEqual({
            "kb/a.md": 1,
            "doc/reference/b.md": 4,
            "doc/misc/c.md": 5,
            "initiatives/srd.md": undefined,
        });
    });

    // go: Test_server_search_error_tabular
    it.each([
        ["missing q", "/search", "q query parameter is required"],
        ["k not a number", "/search?q=x&k=abc", "k must be a positive integer"],
        ["k zero", "/search?q=x&k=0", "k must be a positive integer"],
        ["k negative", "/search?q=x&k=-2", "k must be a positive integer"],
        ["k over limit", "/search?q=x&k=101", "k must be at most 100"],
    ])("refuses %s", async (_name, target, want) => {
        // --- Given ---
        const { rest } = await newRest();

        // --- When ---
        const have = await get(rest, target);

        // --- Then ---
        expect(have.status).toBe(400);
        expect(have.body).toContain(want);
    });
});

describe("GET /docs", () => {
    // go: Test_server_docs
    it("lists the documents", async () => {
        // --- Given ---
        const { rest } = await newRest();

        // --- When ---
        const have = await get(rest, "/docs");

        // --- Then ---
        expect(have.status).toBe(200);
        expect(have.body).toBe(goldy("docs.golden"));
    });

    // go: Test_server_docs_carries_rank
    it("carries the trust rank", async () => {
        // --- Given ---
        const rest = new Rest({ engine: await rankEngine(), version: "x" });

        // --- When ---
        const have = await get(rest, "/docs");

        // --- Then ---
        expect(have.body).toBe(
            '{"docs":[' +
                '{"id":"doc/misc/c.md","path":"doc/misc/c.md","rank":5,"title":"c"},' +
                '{"id":"doc/reference/b.md","path":"doc/reference/b.md","rank":4,"title":"b"},' +
                '{"id":"initiatives/srd.md","path":"initiatives/srd.md","title":"srd"},' +
                '{"id":"kb/a.md","path":"kb/a.md","rank":1,"title":"a"}]}\n',
        );
    });
});

describe("GET /docs/{id...}", () => {
    // go: Test_server_doc_routes_nested_id
    it("routes a nested id", async () => {
        // --- Given ---
        const { rest } = await newRest();

        // --- When ---
        const have = await get(rest, "/docs/shop/catalog/epub.md");

        // --- Then ---
        expect(have.status).toBe(200);
        expect(have.body).toBe(goldy("doc.golden"));
    });

    // go: Test_server_doc_by_id_or_path_tabular
    it.each([
        ["by id", "/docs/intro-1"],
        ["by path", "/docs/shop/intro.md"],
    ])("finds a document %s", async (_name, target) => {
        // --- Given ---
        const { rest } = await newRest();

        // --- When ---
        const have = await get(rest, target);

        // --- Then ---
        expect(have.status).toBe(200);
        const body = JSON.parse(have.body) as { id: string; path: string };
        expect([body.id, body.path]).toEqual(["intro-1", "shop/intro.md"]);
    });

    // go: Test_server_doc_rank_tabular
    it.each([
        ["kb", "/docs/kb/a.md", 1],
        ["reference docs", "/docs/doc/reference/b.md", 4],
        ["unlisted", "/docs/doc/misc/c.md", 5],
        ["initiatives", "/docs/initiatives/srd.md", undefined],
    ])("carries the %s rank", async (_name, target, want) => {
        // --- Given ---
        const rest = new Rest({ engine: await rankEngine(), version: "x" });

        // --- When ---
        const have = await get(rest, target);

        // --- Then ---
        expect((JSON.parse(have.body) as { rank?: number }).rank).toBe(want);
    });

    // go: Test_server_doc_error_hides_internal_error
    it("hides an internal error", async () => {
        // --- Given ---
        const logged: unknown[] = [];
        const { rest, fs } = await newRest("", (err) => logged.push(err));
        fs.removeAll("/c/intro.md");

        // --- When ---
        const have = await get(rest, "/docs/shop/intro.md");

        // --- Then ---
        expect(have.status).toBe(500);
        expect(have.body).toBe('{"error":"internal error"}\n');
        expect(logged).toHaveLength(1);
        expect((logged[0] as Error).message).toContain(
            "intro.md: no such file or directory",
        );
    });

    // go: Test_server_doc_error_tabular
    it.each([
        ["unknown id", "/docs/shop/absent.md"],
        ["unknown source", "/docs/other/epub.md"],
        ["traversal-shaped id", "/docs/..%2F..%2F..%2Fetc%2Fpasswd"],
        ["bare docs slash", "/docs/"],
    ])("answers 404 for an %s", async (_name, target) => {
        // --- Given ---
        const { rest } = await newRest();

        // --- When ---
        const have = await get(rest, target);

        // --- Then ---
        expect(have.status).toBe(404);
        expect(have.body).toContain("document not found");
    });
});

describe("GET /glossary", () => {
    // go: Test_glossaryServer_terms
    it("lists the terms", async () => {
        // --- Given ---
        const { rest } = await newRest("shop/glossary");

        // --- When ---
        const have = await get(rest, "/glossary");

        // --- Then ---
        expect(have.status).toBe(200);
        expect(have.body).toBe(goldy("glossary.golden"));
    });

    // go: Test_glossaryServer_terms_filter
    it("filters the terms", async () => {
        // --- Given ---
        const { rest } = await newRest("shop/glossary");

        // --- When ---
        const have = await get(rest, "/glossary?term=backorder");

        // --- Then ---
        const body = JSON.parse(have.body) as { terms: { term: string }[] };
        expect(body.terms.map((t) => t.term)).toEqual(["Backorder"]);
    });

    // go: Test_glossaryServer_terms_error_hides_internal_error
    it("hides an internal error", async () => {
        // --- Given ---
        const { rest, fs } = await newRest("shop/glossary");
        fs.chmod("/c/glossary/main.md", 0o000);

        // --- When ---
        const have = await get(rest, "/glossary");

        // --- Then ---
        expect(have.status).toBe(500);
        expect(have.body).toBe('{"error":"internal error"}\n');
    });
});

describe("GET /openapi.yaml", () => {
    // go: Test_server_spec
    it("serves the OpenAPI description", async () => {
        // --- Given ---
        const { rest } = await newRest();
        const spec = readFileSync(
            new URL("testdata/openapi.yaml", import.meta.url),
            "utf8",
        );

        // --- When ---
        const have = await get(rest, "/openapi.yaml");

        // --- Then ---
        expect(have.status).toBe(200);
        expect(have.headers["Content-Type"]).toBe("application/yaml");
        expect(have.body).toBe(OPENAPI_YAML);
        expect(OPENAPI_YAML).toBe(spec);
    });
});

describe("helpers", () => {
    it.each([
        ["", "/"],
        ["a", "/a"],
        ["/a/./b/", "/a/b/"],
        ["/a/../../x", "/x"],
        ["//docs", "/docs"],
        ["/docs/", "/docs/"],
    ])("cleans %j", (p, want) => {
        expect(cleanPath(p)).toBe(want);
    });

    it.each([
        ["7", 7],
        ["-2", -2],
        ["+3", 3],
        ["007", 7],
        ["", undefined],
        [" 1", undefined],
        ["1.0", undefined],
        ["9223372036854775808", undefined],
    ])("atoi %j", (s, want) => {
        expect(atoi(s)).toBe(want);
    });

    it("parses a query like url.Query", () => {
        const have = parseQuery("q=a+b&q=second&k=%zz&x;y=1&e=&n");
        expect([
            have.get("q"),
            have.get("k"),
            have.get("x;y"),
            have.get("e"),
            have.get("n"),
            have.get("zz"),
        ]).toEqual(["a b", "", "", "", "", ""]);
    });
});

/** expandPad expands the cases' "<<pad:c:n>>" markers: n copies of c. */
function expandPad(body: string): string {
    return body.replace(/<<pad:(.):(\d+)>>/g, (_m, c: string, n: string) =>
        c.repeat(Number(n)),
    );
}

interface RestCase {
    name: string;
    no_store?: boolean;
    no_glossary?: boolean;
    files?: Record<string, string>;
    requests: { method: string; target: string; body: string }[];
}

/** REST requests and Go's responses over the bookshop (oracle `rest`). */
type RestGolden = {
    name: string;
    responses: {
        status: number;
        headers: Record<string, string>;
        body: string;
    }[];
}[];
const suites = ["rest-read", "rest-gaps"].map((name) => ({
    name,
    cases: readGolden<RestCase[]>(
        new URL(`testdata/${name}.cases.json`, import.meta.url),
    ),
    golden: readGolden<RestGolden>(
        new URL(`testdata/${name}.golden.json`, import.meta.url),
    ),
}));
const rows = suites.flatMap((s) =>
    s.cases.map((cs, i) => [`${s.name}/${cs.name}`, cs, s.golden[i]] as const),
);

describe("REST routes against Go", () => {
    it.each(rows)("%s matches the Go server", async (_name, cs, want) => {
        // --- Given ---
        const { deps } = await bookshop({
            store: cs.no_store !== true,
            glossary: cs.no_glossary !== true,
            ...(cs.files ? { files: cs.files } : {}),
        });
        const rest = new Rest(deps);

        // --- When ---
        const have: unknown[] = [];
        for (const rq of cs.requests) {
            const q = rq.target.indexOf("?");
            const res = await rest.handle({
                method: rq.method,
                path: q < 0 ? rq.target : rq.target.slice(0, q),
                query: q < 0 ? "" : rq.target.slice(q + 1),
                body: new TextEncoder().encode(expandPad(rq.body)),
            });
            const headers: Record<string, string> = {};
            for (const k of ["Content-Type", "Allow", "Location"]) {
                if (res.headers[k] !== undefined)
                    headers[k] = res.headers[k] as string;
            }
            have.push({
                status: res.status,
                headers,
                body: res.body.replaceAll(ROOT, "<root>"),
            });
        }

        // --- Then --- a recorder keeps a HEAD body a real server drops.
        (want?.responses ?? []).forEach((res, i) => {
            const rq = cs.requests[i] as { method: string; target: string };
            const exp = rq.method === "HEAD" ? { ...res, body: "" } : res;
            expect([rq.method, rq.target, have[i]]).toEqual([
                rq.method,
                rq.target,
                exp,
            ]);
        });
        expect(have).toHaveLength(want?.responses.length ?? -1);
    });
});
