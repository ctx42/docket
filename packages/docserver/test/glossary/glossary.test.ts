// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    type DocInfo,
    type Document,
    NotFoundError,
} from "../../src/engine/engine.ts";
import {
    type Docs,
    fenceMark,
    Glossary,
    newTerm,
    parse,
    plainText,
    type Term,
} from "../../src/glossary/glossary.ts";
import { DocFsError } from "../../src/ports.ts";
import { readGolden } from "../support/golden.ts";

/**
 * FakeDocs maps document paths to texts; a path in ids has that identity,
 * any other its path; a path in errs fails getDoc with that error.
 */
class FakeDocs implements Docs {
    constructor(
        private readonly texts: Record<string, string> = {},
        private readonly ids: Record<string, string> = {},
        private readonly errs: Record<string, Error> = {},
    ) {}

    listDocs(): DocInfo[] {
        return Object.keys(this.texts)
            .sort()
            .map((path) => ({
                id: this.identity(path),
                path,
                rank: 0,
                title: "",
            }));
    }

    async getDoc(ref: string): Promise<Document> {
        const err = this.errs[ref];
        if (err !== undefined)
            throw new Error(`read ${ref}: ${err.message}`, { cause: err });
        return {
            id: this.identity(ref),
            path: ref,
            rank: 0,
            title: "",
            sourceURL: "",
            text: this.texts[ref] ?? "",
        };
    }

    private identity(path: string): string {
        return this.ids[path] ?? path;
    }
}

/** TEST_INFO is the listing entry of the document a parse test reads. */
const TEST_INFO: DocInfo = {
    id: "doc-1",
    path: "c/g/main.md",
    rank: 0,
    title: "",
};

/** GLOSSARY_DOC is a glossary document as a sync tool writes it. */
const GLOSSARY_DOC = [
    "---",
    'title: "Main Glossary"',
    'url: "https://ex.com/glossary"',
    "---",
    "",
    "Intro paragraph that defines nothing.",
    "",
    "```adf",
    "type: toc",
    "## Not A Term",
    "```",
    "",
    "## Stock Keeping Unit (SKU)",
    "",
    "Identifier assigned to each [edition](main.md#Edition) of a book.",
    "",
    "## Retail Price (RP)",
    "",
    "Single *suggested* price for a [^fn-1][title](#TI).",
    "",
    "*type:* float  \\",
    "   *example:* `4.20`",
    "",
    "## Exit Rate ",
    "",
    "> [!comment] id:1 · open",
    "> reword this",
    "",
    "![[image.png]]",
    "",
    "Percentage of visits",
    "that end on a page.",
    "",
    "### Sub heading",
    "",
    "Not part of the definition.",
    "",
    "## Empty",
    "",
].join("\n");

/** term builds an expected term with zero values for the rest. */
function term(over: Partial<Term>): Term {
    return {
        term: "",
        name: "",
        abbreviation: "",
        id: "",
        path: "",
        anchor: "",
        definition: "",
        ...over,
    };
}

/** termsError returns what terms rejects with. */
async function termsError(gls: Glossary): Promise<Error> {
    try {
        await gls.terms("");
    } catch (err) {
        return err as Error;
    }
    throw new Error("terms did not throw");
}

describe("Glossary", () => {
    // go: Test_New
    it("drops a trailing slash from its path", () => {
        expect(new Glossary(new FakeDocs(), "upstream/glossary/").path()).toBe(
            "upstream/glossary",
        );
    });

    // go: Test_Glossary_Terms
    it("lists the terms of the covered documents", async () => {
        const fds = new FakeDocs(
            {
                "c/glossary/b.md": "## Beta\n\nSecond.\n",
                "c/glossary/a.md":
                    "## Alpha (A)\n\nFirst.\n\n## Gamma\n\nThird.\n",
                "c/glossary.md": "## Outside\n\nNot covered.\n",
                "c/glossary-old/x.md": "## Old\n\nNot covered.\n",
            },
            { "c/glossary/b.md": "gl-b" },
        );

        const have = await new Glossary(fds, "c/glossary").terms("");

        expect(have).toEqual([
            term({
                term: "Alpha (A)",
                name: "Alpha",
                abbreviation: "A",
                id: "c/glossary/a.md",
                path: "c/glossary/a.md",
                anchor: "alpha-a",
                definition: "First.",
            }),
            term({
                term: "Gamma",
                name: "Gamma",
                id: "c/glossary/a.md",
                path: "c/glossary/a.md",
                anchor: "gamma",
                definition: "Third.",
            }),
            term({
                term: "Beta",
                name: "Beta",
                id: "gl-b",
                path: "c/glossary/b.md",
                anchor: "beta",
                definition: "Second.",
            }),
        ]);
    });

    // go: Test_Glossary_Terms_single_document
    it("covers a single document", async () => {
        const fds = new FakeDocs({
            "c/main.md": "## Alpha\n\nFirst.\n",
            "c/main.md.d": "## Other\n\nNot covered.\n",
        });

        const have = await new Glossary(fds, "c/main.md").terms("");

        expect(have.map((t) => t.term)).toEqual(["Alpha"]);
    });

    // go: Test_Glossary_Terms_filter
    it("filters by heading text ignoring case", async () => {
        const fds = new FakeDocs({
            "c/g/a.md":
                "## Backorder Line (BL)\n\nx\n\n## Bulk Backorder\n\ny\n\n## Asset\n\nz\n",
        });

        const have = await new Glossary(fds, "c/g").terms(" BACKORDER ");

        expect(have.map((t) => t.term)).toEqual([
            "Backorder Line (BL)",
            "Bulk Backorder",
        ]);
    });

    // go: Test_Glossary_Terms_empty
    it("returns an empty list", async () => {
        expect(await new Glossary(new FakeDocs(), "c/g").terms("")).toEqual([]);
    });

    // go: Test_Glossary_Terms_skips_deleted_document
    it("skips a deleted document", async () => {
        const fds = new FakeDocs(
            {
                "c/g/a.md": "",
                "c/g/b.md": "## Beta\n\nSecond.\n",
                "c/g/c.md": "",
            },
            {},
            {
                "c/g/a.md": new DocFsError({
                    code: "ENOENT",
                    op: "open",
                    path: "/x/a.md",
                }),
                "c/g/c.md": new NotFoundError("c/g/c.md"),
            },
        );

        const have = await new Glossary(fds, "c/g").terms("");

        expect(have.map((t) => t.term)).toEqual(["Beta"]);
    });

    // go: Test_Glossary_Terms_error_read
    it("fails on a read error", async () => {
        const fds = new FakeDocs(
            { "c/g/a.md": "" },
            {},
            { "c/g/a.md": new Error("disk on fire") },
        );

        const have = await termsError(new Glossary(fds, "c/g"));

        expect(have.message).toBe("glossary: read c/g/a.md: disk on fire");
    });

    // go: Test_Glossary_Terms_error_front_matter
    it("fails on malformed front matter", async () => {
        const fds = new FakeDocs({ "c/g/a.md": "---\na: [\n---\n" });

        const have = await termsError(new Glossary(fds, "c/g"));

        expect(have.message).toMatch(/^glossary: c\/g\/a\.md: front-matter/);
    });

    // go: Test_Glossary_covers_tabular
    it.each([
        ["equal", "c/g", true],
        ["beneath", "c/g/a.md", true],
        ["deep", "c/g/x/a.md", true],
        ["sibling prefix", "c/glossary/a.md", false],
        ["parent", "c/a.md", false],
    ])("covers: %s", (_, path, want) => {
        expect(new Glossary(new FakeDocs(), "c/g").covers(path)).toBe(want);
    });
});

describe("parse", () => {
    // go: Test_parse
    it("parses terms, abbreviations, anchors and definitions", () => {
        const have = parse(TEST_INFO, GLOSSARY_DOC);

        const base = { id: "doc-1", path: "c/g/main.md" };
        expect(have).toEqual([
            term({
                ...base,
                term: "Stock Keeping Unit (SKU)",
                name: "Stock Keeping Unit",
                abbreviation: "SKU",
                anchor: "stock-keeping-unit-sku",
                definition: "Identifier assigned to each edition of a book.",
            }),
            term({
                ...base,
                term: "Retail Price (RP)",
                name: "Retail Price",
                abbreviation: "RP",
                anchor: "retail-price-rp",
                definition: "Single suggested price for a title.",
            }),
            term({
                ...base,
                term: "Exit Rate",
                name: "Exit Rate",
                anchor: "exit-rate",
                definition: "Percentage of visits that end on a page.",
            }),
            term({ ...base, term: "Empty", name: "Empty", anchor: "empty" }),
        ]);
    });

    // go: Test_parse_ignores_heading_in_tilde_fence
    it("ignores a heading in a tilde fence", () => {
        const have = parse(TEST_INFO, "## A\n\n~~~\n## B\n~~~\n\nDefined.\n");

        expect(have.map((t) => t.definition)).toEqual(["Defined."]);
    });

    // go: Test_parse_hashtag_is_not_heading
    it("keeps a hashtag line as text", () => {
        expect(
            parse(TEST_INFO, "## A\n\n#tag line\n").map((t) => t.definition),
        ).toEqual(["#tag line"]);
    });

    // go: Test_parse_keeps_line_prefix_as_text
    it("keeps a line prefix as text", () => {
        expect(
            parse(TEST_INFO, "## A\n\n1> Defined.\n").map((t) => t.definition),
        ).toEqual(["1> Defined."]);
    });

    // go: Test_parse_duplicate_heading_anchor
    it("uses the suffixed anchor of a duplicate heading", () => {
        const have = parse(
            TEST_INFO,
            "## A\n\nFirst.\n\n### A\n\n## A\n\nSecond.\n",
        );

        expect(have.map((t) => t.anchor)).toEqual(["a", "a-2"]);
    });

    // go: Test_parse_error_front_matter
    it("fails on malformed front matter", () => {
        expect(() => parse(TEST_INFO, "---\ntitle: [\n---\n## A\n")).toThrow(
            /front-matter/,
        );
    });
});

// go: Test_newTerm_tabular
describe("newTerm", () => {
    it.each([
        ["plain", "Customer", "Customer", ""],
        ["abbreviation", "Asset (AST)", "Asset", "AST"],
        [
            "synonym and abbreviation",
            "Channel [Data Channel] (CH)",
            "Channel [Data Channel]",
            "CH",
        ],
        [
            "synonym only",
            "Late Delivery [Delayed Delivery]",
            "Late Delivery [Delayed Delivery]",
            "",
        ],
        ["parenthesis inside", "A (b) c", "A (b) c", ""],
        ["only parentheses", "(X)", "(X)", ""],
        ["no-break space is not RE2 space", "A (X)", "A ", "X"],
    ])("%s", (_, heading, wantName, wantAbbr) => {
        const have = newTerm(TEST_INFO, heading);

        expect([
            have.term,
            have.name,
            have.abbreviation,
            have.id,
            have.path,
        ]).toEqual([heading, wantName, wantAbbr, "doc-1", "c/g/main.md"]);
    });
});

// go: Test_fenceMark_tabular
describe("fenceMark", () => {
    it.each([
        ["backticks", "```", "```"],
        ["backticks with info", "```adf", "```"],
        ["tildes", "~~~", "~~~"],
        ["text", "text", ""],
        ["inline code", "`x`", ""],
    ])("%s", (_, line, want) => {
        expect(fenceMark(line)).toBe(want);
    });
});

// go: Test_plainText_tabular
describe("plainText", () => {
    it.each([
        ["plain", "A value.", "A value."],
        ["link", "See [Asset (AST)](main.md#Asset-(AST)).", "See Asset (AST)."],
        ["footnote anchor", "a [^fn-e68a][Backorder](x.md) b", "a Backorder b"],
        ["emphasis", "*type:* **bold** ***both***", "type: bold both"],
        ["code", "`4.20`", "4.20"],
        ["hard break", "float \\ example", "float example"],
        ["trailing hard break", "float \\", "float"],
        ["whitespace", "  a \t b  ", "a b"],
    ])("%s", (_, md, want) => {
        expect(plainText(md)).toBe(want);
    });
});

interface GoldenCase {
    name: string;
    path: string;
    docs: { id: string; path: string; text: string }[];
}

interface GoldenRow {
    name: string;
    filter: string;
    terms: Term[] | null;
}

/** Inputs (bookshop glossary, edge cases) and Go's terms (oracle `glossary`). */
const cases = readGolden<GoldenCase[]>(
    new URL("testdata/glossary.cases.json", import.meta.url),
);
const golden = readGolden<GoldenRow[]>(
    new URL("testdata/glossary.golden.json", import.meta.url),
);

describe("Glossary against the Go glossary", () => {
    it.each(
        golden.map(
            (r) => [`${r.name} ${JSON.stringify(r.filter)}`, r] as const,
        ),
    )("matches Go for %s", async (_, row) => {
        const c = cases.find((x) => x.name === row.name) as GoldenCase;
        const texts = Object.fromEntries(c.docs.map((d) => [d.path, d.text]));
        const ids = Object.fromEntries(c.docs.map((d) => [d.path, d.id]));

        const have = await new Glossary(new FakeDocs(texts, ids), c.path).terms(
            row.filter,
        );

        expect(have).toEqual(row.terms ?? []);
    });
});
