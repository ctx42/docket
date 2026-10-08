// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { DEFAULT_WHOLE_FILE_TOKENS } from "../../src/corpus/chunker.ts";
import {
    anchors,
    type Chunk,
    CorpusError,
    chunkPrefix,
    type Doc,
    frontMatterURL,
    type Heading,
    headings,
    Loader,
    section,
    slug,
} from "../../src/corpus/corpus.ts";
import { EC_FRONT_MATTER } from "../../src/corpus/frontmatter.ts";
import { isNotExist } from "../../src/ports.ts";
import { readGolden } from "../support/golden.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";

/** load writes content to /w/<name> and loads it at docPath. */
async function load(
    name: string,
    content: string,
    docPath: string,
    tokens = 0,
): Promise<Doc> {
    const fs = new MemDocFs().writeFile(`/w/${name}`, content);
    return new Loader(fs, tokens).file(docPath, `/w/${name}`);
}

/** loadError returns what Loader.file throws for path on fs. */
async function loadError(
    fs: MemDocFs,
    docPath: string,
    path: string,
): Promise<CorpusError> {
    try {
        await new Loader(fs).file(docPath, path);
    } catch (err) {
        return err as CorpusError;
    }
    throw new Error("file did not throw");
}

// go: Test_Chunk_Prefix_tabular
describe("chunkPrefix", () => {
    it.each([
        ["title only", "T", [], "T"],
        ["title and path", "T", ["A", "B"], "T > A > B"],
        ["skips empty parts", "T", ["", "B"], "T > B"],
        ["no title", "", ["A"], "A"],
    ])("%s", (_, title, headingPath, want) => {
        const have = chunkPrefix({ title, headingPath });

        expect(have).toBe(want);
    });
});

// go: Test_Loader_wholeFileTokens_tabular
describe("Loader.wholeFileTokens", () => {
    it.each([
        ["zero uses default", 0, DEFAULT_WHOLE_FILE_TOKENS],
        ["negative uses default", -5, DEFAULT_WHOLE_FILE_TOKENS],
        ["positive kept", 100, 100],
    ])("%s", (_, input, want) => {
        const have = new Loader(new MemDocFs(), input).wholeFileTokens();

        expect(have).toBe(want);
    });
});

describe("Loader.file", () => {
    // go: Test_Loader_File
    it("loads a document and its chunks", async () => {
        const table = "| P | Proto |\n|---|---|\n| X | EPUB |";
        const content =
            '---\ntitle: "Catalog"\n---\n\n' +
            "## Family A\n\n" +
            table +
            "\n\n" +
            "## Family B\n\nnotes\n";

        const have = await load("d.md", content, "src/d.md", 1);

        expect(have.id).toBe("src/d.md");
        expect(have.path).toBe("src/d.md");
        expect(have.title).toBe("Catalog");
        expect(have.chunks).toHaveLength(2);
        expect(have.chunks[0]?.headingPath).toEqual(["Family A"]);
        expect(have.chunks[0]?.docID).toBe("src/d.md");
        expect(have.chunks[0]?.docPath).toBe("src/d.md");
        expect(have.chunks[0]?.text).toContain(table);
    });

    // go: Test_Loader_File_keeps_body_as_written
    it("keeps the body as written", async () => {
        const content =
            '---\ntitle: "Catalog"\n---\n\n' +
            "## Family A\n\ntext\n\n[[*caption:]]\n\nmore text\n";

        const have = await load("d.md", content, "src/d.md", 1);

        expect(have.chunks).toHaveLength(1);
        expect(have.chunks[0]?.text).toContain("[[*caption:]]");
    });

    // go: Test_Loader_File_carries_aliases_onto_doc_and_chunks
    it("carries aliases onto the doc and its chunks", async () => {
        const content =
            '---\ntitle: "Catalog"\naliases: [eBook]\n---\n\nbody\n';

        const have = await load("d.md", content, "src/d.md");

        expect(have.aliases).toEqual(["eBook"]);
        expect(have.chunks).toHaveLength(1);
        expect(have.chunks[0]?.aliases).toEqual(["eBook"]);
    });

    // go: Test_Loader_File_identity_from_front_matter_id
    it("takes the identity from the front-matter id", async () => {
        const content =
            '---\nid: 12\ntitle: "Glossary"\n' +
            'url: "https://ex.com/12"\n---\n\n## License Plan\n\ntext\n';

        const have = await load("g.md", content, "src/g.md", 1);

        expect(have.id).toBe("12");
        expect(have.path).toBe("src/g.md");
        expect(have.sourceURL).toBe("https://ex.com/12");
        expect(have.chunks).toHaveLength(1);
        expect(have.chunks[0]?.docID).toBe("12");
        expect(have.chunks[0]?.docPath).toBe("src/g.md");
        expect(have.chunks[0]?.sourceURL).toBe("https://ex.com/12");
    });

    // go: Test_Loader_File_builds_no_url_from_writer_private_keys
    it("builds no url from writer-private keys", async () => {
        const content =
            '---\ntitle: "Glossary"\nupstream_page: "12"\n' +
            'upstream_domain: "docs.example.com"\n---\n\n' +
            "## License Plan\n\ntext\n";

        const have = await load("g.md", content, "src/g.md", 1);

        expect(have.sourceURL).toBe("");
        expect(have.chunks).toHaveLength(1);
        expect(have.chunks[0]?.sourceURL).toBe("");
    });

    // go: Test_Loader_File_falls_back_to_body_url
    it("falls back to the first body url", async () => {
        const content =
            '---\ntitle: "D"\n---\n\n## H\n\nsee https://ex.com/p\n';

        const have = await load("d.md", content, "src/d.md", 1);

        expect(have.sourceURL).toBe("https://ex.com/p");
        expect(have.chunks).toHaveLength(1);
        expect(have.chunks[0]?.sourceURL).toBe("https://ex.com/p");
    });

    // go: Test_Loader_File_front_matter_url_wins
    it("prefers the front-matter url", async () => {
        const content =
            '---\ntitle: "D"\nurl: "https://ex.com/d"\n---\n\n' +
            "## H\n\nsee https://docs.example.com/other\n";

        const have = await load("d.md", content, "src/d.md", 1);

        expect(have.sourceURL).toBe("https://ex.com/d");
        expect(have.chunks).toHaveLength(1);
        expect(have.chunks[0]?.sourceURL).toBe("https://ex.com/d");
    });

    // go: Test_Loader_File_front_matter_url_only
    it("uses a front-matter url without a title", async () => {
        const content = '---\nurl: "https://ex.com/d"\n---\n\nbody\n';

        const have = await load("d.md", content, "src/d.md");

        expect(have.sourceURL).toBe("https://ex.com/d");
    });

    // go: Test_Loader_File_sections_cite_document_url_tabular
    it.each([
        [
            "front matter url",
            'url: "https://ex.com/d"\n',
            "intro\n\n# Doc\n\n### Deep\n\nd\n\n## Last\n\nl\n",
            ["https://ex.com/d", "https://ex.com/d", "https://ex.com/d"],
        ],
        [
            "body url",
            "title: T\n",
            "## A\n\nsee https://ex.com/p\n\n## B\n\nb\n",
            ["https://ex.com/p", "https://ex.com/p"],
        ],
    ])(
        "cites the document url from every section: %s",
        async (_, front, body, want) => {
            const have = await load(
                "d.md",
                `---\n${front}---\n\n${body}`,
                "src/d.md",
                1,
            );

            expect(have.chunks.map((c: Chunk) => c.sourceURL)).toEqual(want);
        },
    );

    // go: Test_Loader_File_title_falls_back_to_filename
    it("falls back to the file name for the title", async () => {
        const have = await load(
            "no_front_matter.md",
            "just body text\n",
            "src/no_front_matter.md",
        );

        expect(have.title).toBe("no_front_matter");
        expect(have.chunks).toHaveLength(1);
    });

    // go: Test_Loader_File_error_missing_file
    it("fails on a missing file", async () => {
        const have = await loadError(
            new MemDocFs(),
            "src/absent.md",
            "/w/absent.md",
        );

        expect(isNotExist(have)).toBe(true);
        expect(have.message).toContain("read: open ");
    });

    // go: Test_Loader_File_error_front_matter
    it("fails on malformed front matter", async () => {
        const fs = new MemDocFs().writeFile(
            "/w/bad.md",
            "---\ntitle: [a\n---\nbody",
        );

        const have = await loadError(fs, "src/bad.md", "/w/bad.md");

        expect(have.message).toMatch(/bad\.md: front-matter: yaml/);
        expect(have.code).toBe(EC_FRONT_MATTER);
    });
});

describe("anchors", () => {
    // go: Test_Anchors
    it("maps body lines to heading anchors", () => {
        const src =
            '---\nurl: "https://ex.com/d"\n---\n' +
            "# A\n\n```\n## fake\n```\n\n## B\n### A\n";

        const have = anchors(src);

        expect(have.body).toBe("# A\n\n```\n## fake\n```\n\n## B\n### A\n");
        expect(have.anchors).toEqual(
            new Map([
                [0, "a"],
                [6, "b"],
                [7, "a-1"],
            ]),
        );
    });

    // go: Test_Anchors_no_headings
    it("returns no anchors for a body without headings", () => {
        const have = anchors("text\n");

        expect(have.body).toBe("text\n");
        expect(have.anchors).toEqual(new Map());
    });

    // go: Test_Anchors_error_front_matter
    it("fails on malformed front matter", () => {
        expect(() => anchors("---\ntitle: [\n---\nbody\n")).toThrow(
            /front-matter/,
        );
    });
});

describe("frontMatterURL", () => {
    // go: Test_FrontMatterURL_tabular
    it.each([
        ["set", "---\nurl: https://ex.com/d\n---\n# A\n", "https://ex.com/d"],
        ["body url only", "# A\n\nSee https://ex.com/b.\n", ""],
        ["no front matter", "# A\n", ""],
    ])("%s", (_, src, want) => {
        const have = frontMatterURL(src);

        expect(have).toBe(want);
    });

    // go: Test_FrontMatterURL_error_front_matter
    it("fails on malformed front matter", () => {
        expect(() => frontMatterURL("---\nurl: [\n---\nbody\n")).toThrow(
            /front-matter/,
        );
    });
});

// go: Test_Slug_tabular
describe("slug", () => {
    it.each([
        ["plain", "Project timezones", "project-timezones"],
        ["punctuation", "What's new? (2026)", "whats-new-2026"],
        ["keeps dash and underscore", "a-b_c", "a-b_c"],
        ["unicode letters", "Größe", "größe"],
        ["trims", "  x  ", "x"],
        ["legacy fragment", "Sensor-type", "sensor-type"],
        ["dotted capital I lowers to i", "İz", "iz"],
        ["no final sigma", "ΟΔΟΣ", "οδοσ"],
        ["decimal digits only", "Ⅻ ½ ٣", "--٣"],
    ])("%s", (_, text, want) => {
        const have = slug(text);

        expect(have).toBe(want);
    });
});

describe("headings", () => {
    // go: Test_Headings
    it("lists body headings with unique anchors", () => {
        const src =
            "# Token TTL (v2)!\n\n```\n## fake\n```\n\n## FAQ\n### FAQ\n" +
            "## FAQ\n#### Größe_ändern - x\n";

        const have = headings(src);

        const want: Heading[] = [
            { level: 1, text: "Token TTL (v2)!", anchor: "token-ttl-v2" },
            { level: 2, text: "FAQ", anchor: "faq" },
            { level: 3, text: "FAQ", anchor: "faq-1" },
            { level: 2, text: "FAQ", anchor: "faq-2" },
            { level: 4, text: "Größe_ändern - x", anchor: "größe_ändern---x" },
        ];
        expect(have).toEqual(want);
    });

    // go: Test_Headings_error_front_matter
    it("fails on malformed front matter", () => {
        expect(() => headings("---\ntitle: [\n---\nbody\n")).toThrow(
            /front-matter/,
        );
    });
});

describe("section", () => {
    const src =
        "---\n" +
        "title: T\n" +
        "---\n" +
        "# Top\n" +
        "\n" +
        "intro\n" +
        "\n" +
        "## A\n" +
        "\n" +
        "a text\n" +
        "```\n" +
        "# not a heading\n" +
        "```\n" +
        "### A1\n" +
        "\n" +
        "a1 text\n" +
        "## B\n" +
        "b text\n";

    // go: Test_Section_tabular
    it.each([
        [
            "nested until same level",
            "a",
            "## A\n\na text\n```\n# not a heading\n```\n### A1\n\na1 text",
        ],
        ["deeper until higher level", "a1", "### A1\n\na1 text"],
        ["last until body end", "b", "## B\nb text\n"],
        ["top level", "top", src.slice("---\ntitle: T\n---\n".length)],
    ])("%s", (_, anchor, want) => {
        const have = section(src, anchor);

        expect(have).toEqual({ text: want, found: true });
    });

    // go: Test_Section_duplicate_heading
    it("finds a duplicate heading by its suffix", () => {
        const have = section("## FAQ\nfirst\n## FAQ\nsecond\n", "faq-1");

        expect(have).toEqual({ text: "## FAQ\nsecond\n", found: true });
    });

    // go: Test_Section_not_found
    it("reports a missing anchor", () => {
        const have = section("## A\ntext\n", "b");

        expect(have).toEqual({ text: "", found: false });
    });

    // go: Test_Section_error_front_matter
    it("fails on malformed front matter", () => {
        expect(() => section("---\ntitle: [\n---\n## A\n", "a")).toThrow(
            /front-matter/,
        );
    });
});

describe("CorpusError", () => {
    it("wraps a non-Error cause without a code", () => {
        const have = new CorpusError("read", "boom");

        expect(have.message).toBe("read: boom");
        expect(have.code).toBeUndefined();
    });
});

interface SectionsRow {
    name: string;
    src: string;
    body: string;
    headings: Heading[];
    anchors: Record<string, string> | null;
    sections: Record<string, string>;
    err?: string;
}

const golden = readGolden<SectionsRow[]>(
    new URL("testdata/sections.golden.json", import.meta.url),
);

describe("corpus sections against the Go oracle", () => {
    it.each(golden.map((r) => [r.name, r] as const))(
        "matches Go for %s",
        (_, row) => {
            if (row.err !== undefined) {
                // YAML syntax-error wording is an accepted difference (see
                // the front-matter golden); the class and prefix must match.
                expect(row.err).toMatch(/^front-matter: yaml: /);
                expect(() => headings(row.src)).toThrow(
                    /^front-matter: yaml: /,
                );
                return;
            }
            const have = anchors(row.src);

            expect(have.body).toBe(row.body);
            expect(
                Object.fromEntries(
                    [...have.anchors].map(([k, v]) => [String(k), v]),
                ),
            ).toEqual(row.anchors ?? {});
            expect(headings(row.src)).toEqual(row.headings);
            for (const [anchor, text] of Object.entries(row.sections)) {
                expect(section(row.src, anchor)).toEqual({ text, found: true });
            }
        },
    );
});
