// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    type ClosableRetriever,
    ClosedError,
    CloseReplacedError,
    type DocInfo,
    EC_DOC_NOT_FOUND,
    Engine,
    isDocNotFound,
    type Ranking,
    rank,
    type Source,
    under,
} from "../../src/engine/engine.ts";
import type { Result, Retriever } from "../../src/search/retrieval.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";

/** RANK_PRECEDENCE is the precedence the ranking tests configure. */
const RANK_PRECEDENCE = ["kb", "doc/handbook", "doc/catalog", "doc/reference"];

/**
 * rankSources writes a corpus over the sources doc, initiatives and kb: one
 * document each in kb, doc/reference, the unlisted doc/misc, and
 * initiatives. Every one mentions "turbine", initiatives most and kb least,
 * so a search ranks them in reverse trust order.
 */
function rankSources(fs: MemDocFs): Source[] {
    const filler = " Unrelated maintenance notes follow here.";
    fs.writeFile("/r/kb/a.md", `turbine${filler}${filler}${filler}\n`)
        .writeFile("/r/doc/reference/b.md", `turbine${filler}${filler}\n`)
        .writeFile("/r/doc/misc/c.md", `turbine turbine${filler}\n`)
        .writeFile("/r/initiatives/srd.md", "turbine turbine turbine\n");
    return [
        { name: "doc", dir: "/r/doc" },
        { name: "initiatives", dir: "/r/initiatives" },
        { name: "kb", dir: "/r/kb" },
    ];
}

/** create builds an engine over sources on fs. */
function create(
    fs: MemDocFs,
    sources: Source[],
    ranking: Ranking = {},
): Promise<Engine> {
    return Engine.create({ fs, sources, ranking });
}

/** createError returns what Engine.create throws. */
async function createError(fs: MemDocFs, sources: Source[]): Promise<Error> {
    try {
        await create(fs, sources);
    } catch (err) {
        return err as Error;
    }
    throw new Error("create did not throw");
}

// go: Test_Ranking_rank_tabular
describe("rank", () => {
    it.each([
        ["first entry", "kb/a.md", 1],
        ["subfolder entry", "doc/catalog/pump.md", 3],
        ["nested under entry", "doc/reference/x/b.md", 4],
        ["longest match wins", "doc/catalog/old/c.md", 2],
        ["unlisted folder", "doc/misc/c.md", 5],
        ["unlisted source", "notes/n.md", 5],
        ["segment prefix only", "doc/catalog2/d.md", 5],
        ["initiatives", "doc/catalog/srd/s.md", 0],
    ])("%s", (_, path, want) => {
        const rnk: Ranking = {
            precedence: [
                "kb",
                "doc/catalog/old",
                "doc/catalog",
                "doc/reference",
            ],
            unranked: "doc/catalog/srd",
        };

        expect(rank(rnk, path)).toBe(want);
    });

    // go: Test_Ranking_rank_without_precedence
    it("ranks nothing without precedence", () => {
        expect(rank({ unranked: "initiatives" }, "kb/a.md")).toBe(0);
    });
});

// go: Test_under_tabular
describe("under", () => {
    it.each([
        ["equal", "kb/a.md", "kb/a.md", true],
        ["child", "kb/a.md", "kb", true],
        ["sibling prefix", "kbx/a.md", "kb", false],
        ["other", "doc/a.md", "kb", false],
        ["empty prefix", "kb/a.md", "", false],
    ])("%s", (_, path, pfx, want) => {
        expect(under(path, pfx)).toBe(want);
    });
});

describe("Engine.create", () => {
    // go: Test_New_mints_ids_per_source
    it("mints document paths per source", async () => {
        const fs = new MemDocFs()
            .writeFile("/d/a.md", "---\ntitle: A\n---\nalpha body\n")
            .writeFile("/d/sub/b.md", "---\ntitle: B\n---\nbeta body\n")
            .writeFile("/d/note.txt", "not markdown")
            .writeFile("/f/c.md", "---\ntitle: C\n---\ngamma\n");

        const have = await create(fs, [
            { name: "docs", dir: "/d" },
            { name: "notes", file: "/f/c.md" },
        ]);

        const want: DocInfo[] = [
            { id: "docs/a.md", path: "docs/a.md", rank: 0, title: "A" },
            { id: "docs/sub/b.md", path: "docs/sub/b.md", rank: 0, title: "B" },
            { id: "notes/c.md", path: "notes/c.md", rank: 0, title: "C" },
        ];
        expect(have.listDocs()).toEqual(want);
    });

    // go: Test_New_skips_non_regular_files
    it("skips a dangling symlink", async () => {
        const fs = new MemDocFs()
            .writeFile("/d/a.md", "alpha\n")
            .symlink("user@host.123", "/d/.#a.md");

        const have = await create(fs, [{ name: "docs", dir: "/d" }]);

        expect(have.listDocs()).toEqual([
            { id: "docs/a.md", path: "docs/a.md", rank: 0, title: "a" },
        ]);
    });

    // go: Test_New_follows_symlinked_file
    it("follows a symlinked file", async () => {
        const fs = new MemDocFs()
            .writeFile("/t/b.md", "beta\n")
            .symlink("/t/b.md", "/d/link.md");

        const have = await create(fs, [{ name: "docs", dir: "/d" }]);

        expect(have.listDocs()).toEqual([
            {
                id: "docs/link.md",
                path: "docs/link.md",
                rank: 0,
                title: "link",
            },
        ]);
    });

    it("does not enter a symlinked directory or a symlinked root", async () => {
        const fs = new MemDocFs()
            .writeFile("/d/a.md", "alpha\n")
            .writeFile("/other/x.md", "x\n")
            .symlink("/other", "/d/linked")
            .symlink("/d", "/rootlink");

        const have = await create(fs, [{ name: "docs", dir: "/d" }]);
        const viaLink = await create(fs, [{ name: "docs", dir: "/rootlink" }]);

        expect(have.listDocs().map((d) => d.path)).toEqual(["docs/a.md"]);
        expect(viaLink.listDocs()).toEqual([]);
    });

    // go: Test_New_error_missing_dir
    it("fails on a missing directory", async () => {
        const have = await createError(new MemDocFs(), [
            { name: "gone", dir: "/no/such/dir" },
        ]);

        expect(have.message).toContain(
            "ingest source gone: lstat /no/such/dir: no such file",
        );
    });

    // go: Test_New_error_missing_file
    it("fails on a missing file", async () => {
        const have = await createError(new MemDocFs(), [
            { name: "gone", file: "/no/such/file.md" },
        ]);

        expect(have.message).toContain(
            "ingest source gone: read: open /no/such/file.md: no such",
        );
    });

    // go: Test_New_error_duplicate_path
    it("fails on a duplicate document path", async () => {
        const fs = new MemDocFs().writeFile("/d/a.md", "alpha\n");

        const have = await createError(fs, [
            { name: "src", dir: "/d" },
            { name: "src", file: "/d/a.md" },
        ]);

        expect(have.message).toMatch(
            /duplicate document path src\/a\.md: \/.*\/a\.md and \/.*\/a\.md/,
        );
    });

    // go: Test_New_id_equal_to_own_path
    it("accepts an id equal to the document's own path", async () => {
        const fs = new MemDocFs().writeFile(
            "/d/a.md",
            "---\nid: docs/a.md\n---\nalpha\n",
        );

        const have = await create(fs, [{ name: "docs", dir: "/d" }]);

        expect(have.listDocs()).toEqual([
            { id: "docs/a.md", path: "docs/a.md", rank: 0, title: "a" },
        ]);
    });

    // go: Test_New_error_duplicate_id
    it("fails on a duplicate id", async () => {
        const fs = new MemDocFs()
            .writeFile("/d/a.md", "---\nid: doc-12\n---\nalpha\n")
            .writeFile("/d/b.md", "---\nid: doc-12\n---\nbeta\n");

        const have = await createError(fs, [{ name: "docs", dir: "/d" }]);

        expect(have.message).toMatch(
            /document id doc-12 of \/.*\/b\.md is taken by \/.*\/a\.md/,
        );
    });

    // go: Test_New_error_id_equal_to_other_path
    it("fails on an id equal to another document's path", async () => {
        const fs = new MemDocFs()
            .writeFile("/d/a.md", "---\nid: docs/b.md\n---\nalpha\n")
            .writeFile("/d/b.md", "beta\n");

        const have = await createError(fs, [{ name: "docs", dir: "/d" }]);

        expect(have.message).toMatch(
            /document id docs\/b\.md of \/.*\/a\.md is taken by \/.*\/b\.md/,
        );
    });

    it("fails on an unreadable subdirectory and a broken retriever", async () => {
        const fs = new MemDocFs()
            .writeFile("/d/sub/a.md", "alpha\n")
            .chmod("/d/sub", 0o300);

        const have = await createError(fs, [{ name: "docs", dir: "/d" }]);
        const broken = Engine.create({
            fs: new MemDocFs().writeFile("/d/a.md", "x\n"),
            sources: [{ name: "docs", dir: "/d" }],
            newRetriever: () => {
                throw new Error("boom");
            },
        });

        expect(have.message).toBe(
            "ingest source docs: open /d/sub: permission denied",
        );
        await expect(broken).rejects.toThrow("build index: boom");
    });

    // go: Test_newEngine_uses_custom_retriever
    it("uses a custom retriever", async () => {
        const hits: Result[] = [
            {
                docID: "canned",
                docPath: "",
                title: "",
                headingPath: [],
                text: "",
                sourceURL: "",
                score: 0,
                rank: 0,
            },
        ];
        const fake: Retriever = { search: async () => hits };

        const eng = await Engine.create({
            fs: new MemDocFs().writeFile("/d/a.md", "alpha\n"),
            sources: [{ name: "docs", dir: "/d" }],
            newRetriever: () => fake,
        });

        expect(await eng.search({ text: "" })).toEqual(hits);
    });
});

// go: Test_Engine_Unranked_tabular
describe("Engine.unranked", () => {
    it.each([
        ["under prefix", "docs/initiatives", "docs/initiatives/a.md", true],
        ["prefix itself", "docs/initiatives", "docs/initiatives", true],
        ["outside prefix", "docs/initiatives", "docs/kb/a.md", false],
        ["segment prefix only", "docs/init", "docs/initiatives/a.md", false],
        ["no prefix", "", "docs/initiatives/a.md", false],
    ])("%s", async (_, unranked, path, want) => {
        const eng = await create(new MemDocFs(), [], { unranked });

        expect(eng.unranked(path)).toBe(want);
    });
});

describe("Engine.listDocs", () => {
    // go: Test_Engine_ListDocs_sorted_by_path
    it("sorts by path", async () => {
        const fs = new MemDocFs()
            .writeFile("/d/z.md", "zulu\n")
            .writeFile("/d/a.md", "---\nid: zz\n---\nalpha\n");

        const have = (
            await create(fs, [{ name: "docs", dir: "/d" }])
        ).listDocs();

        expect(have).toEqual([
            { id: "zz", path: "docs/a.md", rank: 0, title: "a" },
            { id: "docs/z.md", path: "docs/z.md", rank: 0, title: "z" },
        ]);
    });

    // go: Test_Engine_ListDocs_carries_rank
    it("carries the trust rank", async () => {
        const fs = new MemDocFs();
        const eng = await create(fs, rankSources(fs), {
            precedence: RANK_PRECEDENCE,
            unranked: "initiatives",
        });

        const have = eng.listDocs();

        expect(have).toEqual([
            { id: "doc/misc/c.md", path: "doc/misc/c.md", rank: 5, title: "c" },
            {
                id: "doc/reference/b.md",
                path: "doc/reference/b.md",
                rank: 4,
                title: "b",
            },
            {
                id: "initiatives/srd.md",
                path: "initiatives/srd.md",
                rank: 0,
                title: "srd",
            },
            { id: "kb/a.md", path: "kb/a.md", rank: 1, title: "a" },
        ]);
    });
});

/** CloseRetriever is an empty retriever recording its close. */
class CloseRetriever implements ClosableRetriever {
    closed = false;

    constructor(private readonly err?: Error) {}

    async search(): Promise<Result[]> {
        return [];
    }

    async close(): Promise<void> {
        this.closed = true;
        if (this.err) throw this.err;
    }
}

/** withRetrievers builds an engine whose retrievers are recorded in rets. */
async function withRetrievers(
    fs: MemDocFs,
    rets: CloseRetriever[],
    err?: Error,
): Promise<Engine> {
    return Engine.create({
        fs,
        sources: [{ name: "docs", dir: "/d" }],
        newRetriever: () => {
            const ret = new CloseRetriever(err);
            rets.push(ret);
            return ret;
        },
    });
}

/** errorOf returns the rejection of p. */
async function errorOf(p: Promise<unknown>): Promise<Error> {
    try {
        await p;
    } catch (err) {
        return err as Error;
    }
    throw new Error("promise did not reject");
}

describe("Engine.reload", () => {
    // go: Test_Engine_Reload
    it("picks up edited, added and removed documents", async () => {
        const fs = new MemDocFs()
            .writeFile("/d/edit.md", "---\ntitle: Old\n---\nalpha\n")
            .writeFile("/d/gone.md", "beta\n");
        const eng = await create(fs, [{ name: "docs", dir: "/d" }]);
        fs.writeFile("/d/edit.md", "---\ntitle: New\n---\nEPUB readers\n")
            .writeFile("/d/sub/add.md", "gamma\n")
            .removeAll("/d/gone.md");

        await eng.reload();

        expect(eng.listDocs()).toEqual([
            { id: "docs/edit.md", path: "docs/edit.md", rank: 0, title: "New" },
            {
                id: "docs/sub/add.md",
                path: "docs/sub/add.md",
                rank: 0,
                title: "add",
            },
        ]);
        const hits = await eng.search({ text: "EPUB" });
        expect(hits.map((h) => h.docID)).toEqual(["docs/edit.md"]);
        expect(isDocNotFound(await errorOf(eng.getDoc("docs/gone.md")))).toBe(
            true,
        );
    });

    // go: Test_Engine_Reload_error_keeps_previous_snapshot
    it("keeps the previous snapshot on error", async () => {
        const fs = new MemDocFs().writeFile(
            "/r/docs/epub.md",
            "EPUB readers\n",
        );
        const eng = await create(fs, [{ name: "docs", dir: "/r/docs" }]);
        fs.removeAll("/r/docs");

        const have = await errorOf(eng.reload());

        expect(have.message).toMatch(
            /^ingest source docs: lstat .*: no such file/,
        );
        expect(eng.listDocs()).toEqual([
            {
                id: "docs/epub.md",
                path: "docs/epub.md",
                rank: 0,
                title: "epub",
            },
        ]);
        expect(await eng.search({ text: "EPUB" })).toHaveLength(1);
    });

    // go: Test_Engine_Reload_recovers_after_error
    it("recovers after an error", async () => {
        const fs = new MemDocFs().writeFile("/r/docs/a.md", "alpha\n");
        const eng = await create(fs, [{ name: "docs", dir: "/r/docs" }]);
        fs.removeAll("/r/docs");
        await expect(eng.reload()).rejects.toThrow();
        fs.writeFile("/r/docs/b.md", "beta\n");

        await eng.reload();

        expect(eng.listDocs()).toEqual([
            { id: "docs/b.md", path: "docs/b.md", rank: 0, title: "b" },
        ]);
    });

    // go: Test_Engine_Reload_closes_replaced_index
    it("closes the replaced index", async () => {
        const rets: CloseRetriever[] = [];
        const eng = await withRetrievers(
            new MemDocFs().writeFile("/d/a.md", "alpha\n"),
            rets,
        );

        await eng.reload();

        expect(rets.map((r) => r.closed)).toEqual([true, false]);
    });

    it("closes the replaced index only after in-flight searches return", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const slow = new CloseRetriever();
        slow.search = async () => {
            await gate;
            expect(slow.closed).toBe(false);
            return [];
        };
        let first = true;
        const eng = await Engine.create({
            fs: new MemDocFs().writeFile("/d/a.md", "alpha\n"),
            sources: [{ name: "docs", dir: "/d" }],
            newRetriever: () => {
                if (!first) return new CloseRetriever();
                first = false;
                return slow;
            },
        });
        const search = eng.search({ text: "alpha" });
        const reload = eng.reload();
        await Promise.resolve();

        expect(eng.generation()).toBe(0);
        release();
        await search;
        await reload;
        expect(slow.closed).toBe(true);
        expect(eng.generation()).toBe(1);
    });

    // go: Test_Engine_Reload_error_close_replaced
    it("reports a failure to close the replaced index", async () => {
        const rets: CloseRetriever[] = [];
        const fs = new MemDocFs().writeFile("/d/a.md", "alpha\n");
        const eng = await withRetrievers(fs, rets, new Error("disk on fire"));
        fs.writeFile("/d/b.md", "beta\n");

        const have = await errorOf(eng.reload());

        expect(have).toBeInstanceOf(CloseReplacedError);
        expect(have.message).toContain("disk on fire");
        expect(eng.listDocs()).toHaveLength(2);
    });

    // go: Test_Engine_Reload_concurrent_with_searches
    it("serves searches while reloading", async () => {
        const fs = new MemDocFs().writeFile("/d/epub.md", "EPUB readers\n");
        const eng = await create(fs, [{ name: "docs", dir: "/d" }]);
        let stop = false;
        const loops = Array.from({ length: 4 }, async () => {
            while (!stop) {
                const hits = await eng.search({ text: "EPUB" });
                expect(hits).toHaveLength(1);
                expect(eng.listDocs()).toHaveLength(1);
                await new Promise((r) => setTimeout(r, 0));
            }
        });

        for (let i = 0; i < 20; i++) await eng.reload();
        stop = true;
        await Promise.all(loops);

        expect(eng.generation()).toBe(20);
    });

    // go: Test_Engine_Reload_error_closed
    it("refuses to reload after close", async () => {
        const rets: CloseRetriever[] = [];
        const eng = await withRetrievers(
            new MemDocFs().writeFile("/d/a.md", "alpha\n"),
            rets,
        );
        await eng.close();

        const have = await errorOf(eng.reload());

        expect(have).toBeInstanceOf(ClosedError);
        expect(have.message).toBe("engine closed");
        expect(rets).toHaveLength(1);
    });
});

describe("Engine.search", () => {
    // go: Test_Engine_Search
    it("ranks the best section first", async () => {
        const fs = new MemDocFs()
            .writeFile("/d/epub.md", "Field readers download data as EPUB.\n")
            .writeFile("/d/paperback.md", "Couriers ship paperback orders.\n");
        const eng = await create(fs, [{ name: "docs", dir: "/d" }]);

        const have = await eng.search({ text: "EPUB readers" });

        expect(have[0]?.docID).toBe("docs/epub.md");
    });

    // go: Test_Engine_Search_carries_rank
    it("carries each document's rank", async () => {
        const fs = new MemDocFs();
        const eng = await create(fs, rankSources(fs), {
            precedence: RANK_PRECEDENCE,
            unranked: "initiatives",
        });

        const have = await eng.search({ text: "turbine" });

        expect(
            Object.fromEntries(have.map((h) => [h.docPath, h.rank])),
        ).toEqual({
            "kb/a.md": 1,
            "doc/reference/b.md": 4,
            "doc/misc/c.md": 5,
            "initiatives/srd.md": 0,
        });
    });

    // go: Test_Engine_Search_rank_keeps_order
    it("keeps the retriever's order whatever the rank", async () => {
        const fs = new MemDocFs();
        const sources = rankSources(fs);
        const want = await (await create(fs, sources)).search({
            text: "turbine",
        });
        const eng = await create(fs, sources, {
            precedence: RANK_PRECEDENCE,
            unranked: "initiatives",
        });

        const have = await eng.search({ text: "turbine" });

        expect(have.map((h) => [h.docPath, h.score])).toEqual(
            want.map((h) => [h.docPath, h.score]),
        );
        expect(have[0]?.docPath).toBe("initiatives/srd.md");
    });

    // go: Test_Engine_Search_reordered_precedence_flips_rank
    it("follows a reordered precedence", async () => {
        const fs = new MemDocFs();
        const eng = await create(fs, rankSources(fs), {
            precedence: ["doc/reference", "doc/catalog", "doc/handbook", "kb"],
            unranked: "initiatives",
        });

        const have = await eng.search({ text: "turbine" });

        const ranks = Object.fromEntries(have.map((h) => [h.docPath, h.rank]));
        expect(ranks["doc/reference/b.md"]).toBe(1);
        expect(ranks["kb/a.md"]).toBe(4);
    });

    // go: Test_Engine_Search_section_cites_document_url
    it("cites the document url from a section", async () => {
        const filler = "filler ".repeat(500);
        const content =
            '---\nid: doc-12\ntitle: G\nurl: "https://docs.example.com/g"\n---\n\n' +
            `## Overview\n\n${filler}\n\n## License Plan\n\nA contracted service tier. ${filler}\n`;
        const eng = await create(new MemDocFs().writeFile("/d/g.md", content), [
            { name: "docs", dir: "/d" },
        ]);

        const have = await eng.search({ text: "License Plan" });

        expect(have[0]?.sourceURL).toBe("https://docs.example.com/g");
        expect(have[0]?.docID).toBe("doc-12");
        expect(have[0]?.docPath).toBe("docs/g.md");
    });
});

describe("Engine.getDoc", () => {
    // go: Test_Engine_GetDoc
    it("returns the whole file with its metadata", async () => {
        const content = "---\ntitle: B\n---\nsee https://docs.example.com/b\n";
        const eng = await create(
            new MemDocFs().writeFile("/d/sub/b.md", content),
            [{ name: "docs", dir: "/d" }],
        );

        const have = await eng.getDoc("docs/sub/b.md");

        expect(have).toEqual({
            id: "docs/sub/b.md",
            path: "docs/sub/b.md",
            rank: 0,
            title: "B",
            sourceURL: "https://docs.example.com/b",
            text: content,
        });
    });

    // go: Test_Engine_GetDoc_by_id_or_path_tabular
    it.each([
        ["by id", "doc-12"],
        ["by path", "docs/g.md"],
    ])("finds a document %s", async (_, ref) => {
        const content =
            '---\nid: doc-12\ntitle: G\nurl: "https://docs.example.com/g"\n---\nbody\n';
        const eng = await create(new MemDocFs().writeFile("/d/g.md", content), [
            { name: "docs", dir: "/d" },
        ]);

        const have = await eng.getDoc(ref);

        expect([have.id, have.path, have.sourceURL, have.text]).toEqual([
            "doc-12",
            "docs/g.md",
            "https://docs.example.com/g",
            content,
        ]);
    });

    // go: Test_Engine_GetDoc_rank_tabular
    it.each([
        ["kb", "kb/a.md", 1],
        ["reference docs", "doc/reference/b.md", 4],
        ["unlisted", "doc/misc/c.md", 5],
        ["initiatives", "initiatives/srd.md", 0],
    ])("carries the rank: %s", async (_, ref, want) => {
        const fs = new MemDocFs();
        const eng = await create(fs, rankSources(fs), {
            precedence: RANK_PRECEDENCE,
            unranked: "initiatives",
        });

        expect((await eng.getDoc(ref)).rank).toBe(want);
    });

    // go: Test_Engine_GetDoc_reads_fresh_text_from_disk
    it("reads fresh text from disk", async () => {
        const fs = new MemDocFs().writeFile("/d/a.md", "original EPUB text\n");
        const eng = await create(fs, [{ name: "docs", dir: "/d" }]);
        fs.writeFile("/d/a.md", "rewritten body\n");

        const have = await eng.getDoc("docs/a.md");

        expect(have.text).toBe("rewritten body\n");
        const hits = await eng.search({ text: "EPUB" });
        expect(hits.map((h) => h.docID)).toEqual(["docs/a.md"]);
    });

    // go: Test_Engine_GetDoc_error_tabular
    it.each([
        ["unknown id", "docs/absent.md"],
        ["unknown source", "other/a.md"],
        ["traversal-shaped id", "../../etc/passwd"],
        ["empty id", ""],
    ])("reports %s as not found", async (_, ref) => {
        const eng = await create(
            new MemDocFs().writeFile("/d/a.md", "alpha\n"),
            [{ name: "docs", dir: "/d" }],
        );

        const have = await errorOf(eng.getDoc(ref));

        expect(isDocNotFound(have)).toBe(true);
        expect(have.message).toBe(`document not found: ${ref}`);
        expect((have as { code?: string }).code).toBe(EC_DOC_NOT_FOUND);
    });

    // go: Test_Engine_GetDoc_error_file_removed
    it("fails when the file was removed", async () => {
        const fs = new MemDocFs().writeFile("/d/a.md", "alpha\n");
        const eng = await create(fs, [{ name: "docs", dir: "/d" }]);
        fs.removeAll("/d/a.md");

        const have = await errorOf(eng.getDoc("docs/a.md"));

        expect(have.message).toContain("read docs/a.md");
        expect(isDocNotFound(have)).toBe(false);
    });
});

describe("Engine.generation", () => {
    // go: Test_Engine_Generation
    it("starts at 0", async () => {
        const eng = await create(
            new MemDocFs().writeFile("/d/a.md", "alpha\n"),
            [{ name: "docs", dir: "/d" }],
        );

        expect(eng.generation()).toBe(0);
    });

    // go: Test_Engine_Generation_counts_reloads
    it("counts reloads", async () => {
        const eng = await create(
            new MemDocFs().writeFile("/d/a.md", "alpha\n"),
            [{ name: "docs", dir: "/d" }],
        );
        await eng.reload();
        await eng.reload();

        expect(eng.generation()).toBe(2);
    });

    // go: Test_Engine_Generation_kept_on_failed_reload
    it("is kept on a failed reload", async () => {
        const fs = new MemDocFs().writeFile("/r/docs/a.md", "alpha\n");
        const eng = await create(fs, [{ name: "docs", dir: "/r/docs" }]);
        await eng.reload();
        fs.removeAll("/r/docs");
        await expect(eng.reload()).rejects.toThrow();

        expect(eng.generation()).toBe(1);
    });
});

describe("Engine.close", () => {
    // go: Test_Engine_Close
    it("closes", async () => {
        const rets: CloseRetriever[] = [];
        const eng = await withRetrievers(
            new MemDocFs().writeFile("/d/a.md", "alpha\n"),
            rets,
        );

        await eng.close();

        expect(rets[0]?.closed).toBe(true);
    });

    // go: Test_Engine_Close_twice
    it("is a no-op the second time", async () => {
        const eng = await create(
            new MemDocFs().writeFile("/d/a.md", "alpha\n"),
            [{ name: "docs", dir: "/d" }],
        );
        await eng.close();

        await expect(eng.close()).resolves.toBeUndefined();
    });

    // go: Test_Engine_Close_retriever_without_closer
    it("closes a retriever without a close method", async () => {
        const eng = await Engine.create({
            fs: new MemDocFs().writeFile("/d/a.md", "alpha\n"),
            sources: [{ name: "docs", dir: "/d" }],
            newRetriever: () => ({ search: async () => [] }),
        });

        await expect(eng.close()).resolves.toBeUndefined();
    });
});
