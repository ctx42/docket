// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import type { Chunk, Doc } from "../../src/corpus/corpus.ts";
import {
    BM25,
    BOOST_HEADING,
    BOOST_TEXT,
    BOOST_TITLE,
    DEFAULT_K,
    MAX_K,
    type Query,
    type Result,
    searchText,
    titleText,
} from "../../src/search/retrieval.ts";
import { readGolden } from "../support/golden.ts";

/** chunk builds a chunk with zero values for unspecified fields. */
function chunk(over: Partial<Chunk>): Chunk {
    return {
        docID: "",
        docPath: "",
        title: "",
        headingPath: [],
        text: "",
        sourceURL: "",
        aliases: [],
        startLine: 0,
        ...over,
    };
}

/** doc builds a document around its chunks. */
function doc(over: Partial<Doc> & { chunks: Chunk[] }): Doc {
    return { id: "", path: "", title: "", sourceURL: "", aliases: [], ...over };
}

/**
 * corpusDocs is the shared three-document fixture: every chunk mentions
 * "book"; "EPUB" is unique to the first, the only one with an id.
 */
function corpusDocs(): Doc[] {
    return [
        doc({
            id: "epub-12",
            path: "shop/catalog/epub.md",
            title: "EPUB Editions",
            chunks: [
                chunk({
                    docID: "epub-12",
                    docPath: "shop/catalog/epub.md",
                    title: "EPUB Editions",
                    headingPath: ["Connectivity"],
                    text: "Field readers download book data as EPUB files.",
                    sourceURL: "https://docs.example.com/epub",
                }),
            ],
        }),
        doc({
            id: "shop/catalog/paperback.md",
            path: "shop/catalog/paperback.md",
            title: "Paperback Editions",
            chunks: [
                chunk({
                    docID: "shop/catalog/paperback.md",
                    docPath: "shop/catalog/paperback.md",
                    title: "Paperback Editions",
                    headingPath: ["Connectivity"],
                    text: "Couriers ship book orders as paperbacks.",
                }),
            ],
        }),
        doc({
            id: "shop/guides/intro.md",
            path: "shop/guides/intro.md",
            title: "Getting Started",
            chunks: [
                chunk({
                    docID: "shop/guides/intro.md",
                    docPath: "shop/guides/intro.md",
                    title: "Getting Started",
                    text: "The book dashboard shows store status.",
                }),
            ],
        }),
    ];
}

describe("BM25", () => {
    // go: Test_NewBM25
    it("indexes chunks and returns their citation data", async () => {
        const bm = new BM25(corpusDocs());

        const have = await bm.search({ text: "EPUB" });

        expect(have).toHaveLength(1);
        expect(have[0]?.docID).toBe("epub-12");
        expect(have[0]?.docPath).toBe("shop/catalog/epub.md");
        expect(have[0]?.title).toBe("EPUB Editions");
        expect(have[0]?.headingPath).toEqual(["Connectivity"]);
        expect(have[0]?.sourceURL).toBe("https://docs.example.com/epub");
        expect(have[0]?.score).toBeGreaterThan(0);
    });

    // go: Test_BM25_Search_ranks_best_match_first
    it("ranks the best match first", async () => {
        const have = await new BM25(corpusDocs()).search({
            text: "EPUB files book",
        });

        expect(have).toHaveLength(3);
        expect(have[0]?.docPath).toBe("shop/catalog/epub.md");
        expect(have[0]?.score).toBeGreaterThan(have[1]?.score as number);
    });

    // go: Test_BM25_Search_ranks_heading_match_above_body_match
    it("ranks a heading match above a body match", async () => {
        const docs = [
            doc({
                id: "s/body.md",
                path: "s/body.md",
                title: "Doc B",
                chunks: [
                    chunk({
                        docID: "s/body.md",
                        docPath: "s/body.md",
                        title: "Doc B",
                        headingPath: ["General"],
                        text: "The photon appears only in this section body.",
                    }),
                ],
            }),
            doc({
                id: "s/heading.md",
                path: "s/heading.md",
                title: "Doc H",
                chunks: [
                    chunk({
                        docID: "s/heading.md",
                        docPath: "s/heading.md",
                        title: "Doc H",
                        headingPath: ["Photon"],
                        text: "This section body mentions the term nowhere else.",
                    }),
                ],
            }),
        ];

        const have = await new BM25(docs).search({ text: "photon" });

        expect(have).toHaveLength(2);
        expect(have[0]?.docPath).toBe("s/heading.md");
        expect(have[0]?.score).toBeGreaterThan(have[1]?.score as number);
    });

    // go: Test_BM25_Search_matches_alias
    it("matches an alias with the title boost", async () => {
        const docs = [
            doc({
                id: "shop/catalog/epub.md",
                path: "shop/catalog/epub.md",
                title: "EPUB Editions",
                aliases: ["eBook"],
                chunks: [
                    chunk({
                        docID: "shop/catalog/epub.md",
                        docPath: "shop/catalog/epub.md",
                        title: "EPUB Editions",
                        aliases: ["eBook"],
                        text: "Field readers download book data.",
                    }),
                ],
            }),
        ];

        const have = await new BM25(docs).search({ text: "eBook" });

        expect(have).toHaveLength(1);
        expect(have[0]?.docPath).toBe("shop/catalog/epub.md");
        expect(have[0]?.title).toBe("EPUB Editions");
    });

    // go: Test_BM25_Search_breaks_ties_by_doc_path_then_line
    it("breaks ties by document path, then line", async () => {
        const c = (id: string, path: string, head: string, line: number) =>
            chunk({
                docID: id,
                docPath: path,
                headingPath: [head],
                text: "gift card",
                startLine: line,
            });
        const docs = [
            doc({
                id: "a",
                path: "s/berry.md",
                title: "T",
                chunks: [
                    c("a", "s/berry.md", "B9", 9),
                    c("a", "s/berry.md", "B3", 3),
                ],
            }),
            doc({
                id: "z",
                path: "s/apple.md",
                title: "T",
                chunks: [
                    c("z", "s/apple.md", "A9", 9),
                    c("z", "s/apple.md", "A3", 3),
                ],
            }),
        ];

        const have = await new BM25(docs).search({ text: "gift" });

        expect(have).toHaveLength(4);
        expect(have[0]?.score).toBe(have[3]?.score);
        expect(have.map((r: Result) => r.headingPath)).toEqual([
            ["A3"],
            ["A9"],
            ["B3"],
            ["B9"],
        ]);
    });

    // go: Test_BM25_Search_matches_source_name_in_path
    it("matches the source name in the path", async () => {
        const have = await new BM25(corpusDocs()).search({
            text: "guides intro",
        });

        expect(have[0]?.docPath).toBe("shop/guides/intro.md");
    });

    // go: Test_BM25_Search_matches_word_stem
    it("matches a word stem", async () => {
        const have = await new BM25(corpusDocs()).search({ text: "reader" });

        expect(have).toHaveLength(1);
        expect(have[0]?.docPath).toBe("shop/catalog/epub.md");
    });

    // go: Test_BM25_Search_limits_to_K
    it("limits the results to k", async () => {
        const have = await new BM25(corpusDocs()).search({
            text: "book",
            k: 2,
        });

        expect(have).toHaveLength(2);
    });

    // go: Test_BM25_Search_nonpositive_K_returns_all_matches
    it("uses the default k for a non-positive k", async () => {
        const have = await new BM25(corpusDocs()).search({
            text: "book",
            k: 0,
        });

        expect(have).toHaveLength(3);
        expect(DEFAULT_K).toBe(10);
        expect(MAX_K).toBe(100);
    });

    // go: Test_BM25_Close
    it("closes", async () => {
        await expect(new BM25(corpusDocs()).close()).resolves.toBeUndefined();
    });

    // go: Test_indexMapping
    it("indexes three boosted text fields", () => {
        expect([BOOST_TEXT, BOOST_TITLE, BOOST_HEADING]).toEqual([1, 3, 2]);
    });
});

// go: Test_searchText_tabular
describe("searchText", () => {
    it.each([
        [
            "path words split on separators and prepended",
            "a/b_c.md",
            "a b c\nbody",
        ],
        ["single path segment", "a/b.md", "a b\nbody"],
        ["hyphens split too", "a/b-c.md", "a b c\nbody"],
    ])("%s", (_, docPath, want) => {
        expect(searchText({ docPath, text: "body" })).toBe(want);
    });

    it("does not index the identity", () => {
        expect(
            searchText(
                chunk({ docID: "doc-12", docPath: "a/b.md", text: "body" }),
            ),
        ).toBe("a b\nbody");
    });
});

describe("titleText", () => {
    it("appends aliases to the title", () => {
        expect(titleText({ title: "T", aliases: [] })).toBe("T");
        expect(titleText({ title: "T", aliases: ["a", "b"] })).toBe("T a b");
    });
});

interface GoChunk {
    DocID: string;
    DocPath: string;
    Title: string;
    HeadingPath: string[] | null;
    Text: string;
    SourceURL: string;
    Aliases: string[] | null;
    StartLine: number;
}

interface GoGolden {
    docs: {
        ID: string;
        Path: string;
        Title: string;
        SourceURL: string;
        Aliases: string[] | null;
        Chunks: GoChunk[] | null;
    }[];
    queries: {
        query: { Text: string; K: number };
        results: (GoChunk & { Score: number; Rank: number })[];
    }[];
}

/** Go's corpus docs and BM25 results over the bookshop example. */
const golden = readGolden<GoGolden>(
    new URL("testdata/search.golden.json", import.meta.url),
);

// go: Test_NewBM25_scores_with_bm25
describe("BM25 against the Go retriever (bleve BM25 scores)", () => {
    const docs: Doc[] = golden.docs.map((d) => ({
        id: d.ID,
        path: d.Path,
        title: d.Title,
        sourceURL: d.SourceURL,
        aliases: d.Aliases ?? [],
        chunks: (d.Chunks ?? []).map((c) => ({
            docID: c.DocID,
            docPath: c.DocPath,
            title: c.Title,
            headingPath: c.HeadingPath ?? [],
            text: c.Text,
            sourceURL: c.SourceURL,
            aliases: c.Aliases ?? [],
            startLine: c.StartLine,
        })),
    }));
    const bm = new BM25(docs);

    it.each(golden.queries.map((q) => [JSON.stringify(q.query), q] as const))(
        "matches Go for %s",
        async (_, q) => {
            const query: Query = { text: q.query.Text, k: q.query.K };

            const have = await bm.search(query);

            const want = q.results.map((r) => ({
                docID: r.DocID,
                docPath: r.DocPath,
                title: r.Title,
                headingPath: r.HeadingPath ?? [],
                text: r.Text,
                sourceURL: r.SourceURL,
                score: r.Score,
                rank: r.Rank,
            }));
            expect(have).toEqual(want);
        },
    );
});
