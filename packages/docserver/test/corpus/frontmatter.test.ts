// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    closingFence,
    EC_FRONT_MATTER,
    emptyFrontMatter,
    type FrontMatter,
    FrontMatterError,
    parseFrontMatter,
    unmarshalDocID,
} from "../../src/corpus/frontmatter.ts";
import { parseYaml, type YamlNode } from "../../src/yamlv3/node.ts";
import { readGolden } from "../support/golden.ts";

/** fm builds expected front matter from the fields that differ from zero. */
function fm(over: Partial<FrontMatter>): FrontMatter {
    return { ...emptyFrontMatter(), ...over };
}

/** rootOf parses a YAML snippet and returns its root node. */
function rootOf(src: string): YamlNode {
    return parseYaml(src) as YamlNode;
}

// go: Test_docID_UnmarshalYAML_tabular
describe("unmarshalDocID", () => {
    it.each([
        ["string", "doc-12", "doc-12"],
        ["quoted number", '"007"', "007"],
        ["integer", "12", "12"],
        ["hex integer", "0x1F", "31"],
        ["unsigned integer", "18446744073709551615", "18446744073709551615"],
        ["float", "1.5", "1.5"],
    ])("reads %s", (_, src, want) => {
        const have = unmarshalDocID(rootOf(src));

        expect(have).toBe(want);
    });
});

// go: Test_docID_UnmarshalYAML_error_tabular
describe("unmarshalDocID errors", () => {
    it.each([
        ["empty", '""', "id must not be empty"],
        ["hash", "doc#12", 'id must not contain "#" or whitespace'],
        ["space", '"doc 12"', 'id must not contain "#" or whitespace'],
        ["tab", '"doc\\t12"', 'id must not contain "#" or whitespace'],
        ["sequence", "[a, b]", "id must be a scalar"],
        ["mapping", "{a: b}", "id must be a scalar"],
    ])("rejects %s", (_, src, want) => {
        const have = () => unmarshalDocID(rootOf(src));

        expect(have).toThrow(want);
    });
});

// go: Test_parseFrontMatter_tabular
describe("parseFrontMatter", () => {
    it.each([
        ["no front matter", "# Title\n\nbody", fm({}), "# Title\n\nbody"],
        [
            "valid",
            '---\ntitle: "T"\n---\n\nbody\n',
            fm({ title: "T" }),
            "\nbody\n",
        ],
        [
            "id parsed",
            '---\nid: doc-12\ntitle: "T"\n---\nbody',
            fm({ id: "doc-12", title: "T" }),
            "body",
        ],
        [
            "numeric id parsed",
            "---\nid: 12\n---\nbody",
            fm({ id: "12" }),
            "body",
        ],
        [
            "null id unset",
            '---\nid:\ntitle: "T"\n---\nbody',
            fm({ title: "T" }),
            "body",
        ],
        [
            "writer private keys ignored",
            '---\ntitle: "T"\nupstream_version: 7\nupstream_space: "SHOP"\n---\nbody',
            fm({ title: "T" }),
            "body",
        ],
        [
            "unknown fields ignored",
            '---\ntitle: "T"\nunknown: x\n---\nbody',
            fm({ title: "T" }),
            "body",
        ],
        [
            "aliases parsed",
            '---\ntitle: "T"\naliases: [eBook, "e-book"]\n---\nbody',
            fm({ title: "T", aliases: ["eBook", "e-book"] }),
            "body",
        ],
        [
            "url parsed",
            '---\ntitle: "T"\nurl: "https://ex.com/t"\n---\nbody',
            fm({ title: "T", url: "https://ex.com/t" }),
            "body",
        ],
        [
            "no closing fence",
            "---\ntitle: T\nbody continues",
            fm({}),
            "---\ntitle: T\nbody continues",
        ],
        [
            "thematic break opens body",
            "---\nSome prose.\n---\nbody",
            fm({}),
            "---\nSome prose.\n---\nbody",
        ],
        [
            "byte order mark",
            '\ufeff---\ntitle: "T"\n---\nbody',
            fm({ title: "T" }),
            "body",
        ],
        ["empty block", "---\n---\nbody", fm({}), "body"],
    ])("%s", (_, src, wantFM, wantBody) => {
        const have = parseFrontMatter(src);

        expect(have.fm).toEqual(wantFM);
        expect(have.body).toBe(wantBody);
    });
});

/** frontMatterError captures the error parseFrontMatter throws for src. */
function frontMatterError(src: string): FrontMatterError {
    try {
        parseFrontMatter(src);
    } catch (err) {
        return err as FrontMatterError;
    }
    throw new Error("parseFrontMatter did not throw");
}

describe("parseFrontMatter errors", () => {
    // go: Test_parseFrontMatter_error_malformed_yaml
    it("reports malformed YAML", () => {
        const src = '---\ntitle: "unterminated\ncount: [1, 2\n---\nbody';

        const have = frontMatterError(src);

        expect(have).toBeInstanceOf(FrontMatterError);
        expect(have.message).toMatch(
            /^front-matter: yaml: .*found unexpected end of stream/,
        );
        expect(have.code).toBe(EC_FRONT_MATTER);
    });

    // go: Test_parseFrontMatter_error_field_type
    it("reports a field of the wrong type", () => {
        const have = frontMatterError("---\ntitle: [a, b]\n---\nbody");

        expect(have.message).toContain("cannot unmarshal !!seq into string");
        expect(have.code).toBe(EC_FRONT_MATTER);
    });

    // go: Test_parseFrontMatter_error_id
    it("reports an invalid id", () => {
        const have = frontMatterError('---\nid: "doc#12"\n---\nbody');

        expect(have.message).toContain('id must not contain "#" or whitespace');
        expect(have.code).toBe(EC_FRONT_MATTER);
    });
});

// go: Test_closingFence_tabular
describe("closingFence", () => {
    it.each([
        ["present", "a\n---\nbody", 2, 6],
        ["at end without newline", "a\n---", 2, 5],
        ["absent", "a\nb\n", -1, -1],
    ])("%s", (_, rest, wantEnd, wantBodyStart) => {
        const have = closingFence(rest);

        expect(have).toEqual([wantEnd, wantBodyStart]);
    });
});

interface GoldenRow {
    src: string;
    fm?: FrontMatter;
    body?: string;
    err?: string;
    code?: string;
}

const golden = readGolden<GoldenRow[]>(
    new URL("testdata/frontmatter.golden.json", import.meta.url),
);

/**
 * LINE_ONLY lists sources whose yaml.v3 syntax error the `yaml` parser
 * reports on another line: only the "line N: " prefix may differ.
 */
const LINE_ONLY = new Set(["---\ntitle: T\n  indented: x\n---\nbody\n"]);

describe("parseFrontMatter against the Go oracle", () => {
    it.each(golden.map((r) => [JSON.stringify(r.src), r] as const))(
        "matches Go for %s",
        (_, row) => {
            if (row.err === undefined) {
                const have = parseFrontMatter(row.src);

                expect(have).toEqual({ fm: row.fm, body: row.body });
                return;
            }
            const have = frontMatterError(row.src);

            expect(have.code).toBe(row.code);
            if (LINE_ONLY.has(row.src)) {
                const strip = (s: string) =>
                    s.replace(/yaml: line \d+: /, "yaml: ");
                expect(strip(have.message)).toBe(strip(row.err));
            } else {
                expect(have.message).toBe(row.err);
            }
        },
    );
});
