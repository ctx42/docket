// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    parseYaml,
    resolve,
    scalarText,
    shortTag,
    TAG,
    type YamlNode,
    YamlSyntaxError,
    YamlValueError,
} from "../../src/yamlv3/node.ts";

function root(src: string): YamlNode {
    return parseYaml(src) as YamlNode;
}

describe("resolve", () => {
    it.each([
        ["", TAG.null, undefined],
        ["~", TAG.null, undefined],
        ["NULL", TAG.null, undefined],
        ["True", TAG.bool, undefined],
        ["FALSE", TAG.bool, undefined],
        ["yes", TAG.str, undefined],
        [".inf", TAG.float, undefined],
        ["-.Inf", TAG.float, undefined],
        [".NaN", TAG.float, undefined],
        [".5", TAG.float, undefined],
        [".x", TAG.str, undefined],
        ["<<", TAG.str, undefined],
        ["12", TAG.int, 12n],
        ["-12", TAG.int, -12n],
        ["+12", TAG.int, 12n],
        ["017", TAG.int, 15n],
        ["0o17", TAG.int, 15n],
        ["0x1f", TAG.int, 31n],
        ["0X1F", TAG.int, 31n],
        ["0b101", TAG.int, 5n],
        ["-0b11", TAG.int, -3n],
        ["-0o17", TAG.int, -15n],
        ["1_000", TAG.int, 1000n],
        ["9223372036854775807", TAG.int, 9223372036854775807n],
        ["18446744073709551615", TAG.int, 18446744073709551615n],
        ["18446744073709551616", TAG.float, undefined],
        [
            "0b1111111111111111111111111111111111111111111111111111111111111111",
            TAG.int,
            18446744073709551615n,
        ],
        [
            "-0b1111111111111111111111111111111111111111111111111111111111111111",
            TAG.str,
            undefined,
        ],
        ["0b2", TAG.str, undefined],
        ["08", TAG.float, undefined],
        ["1.5", TAG.float, undefined],
        ["1e3", TAG.float, undefined],
        ["0x", TAG.str, undefined],
        ["-", TAG.str, undefined],
        ["2026-07-14", TAG.timestamp, undefined],
        ["2026-07-14T10:00:00Z", TAG.timestamp, undefined],
        ["abc", TAG.str, undefined],
    ])("resolves %j", (value, wantTag, wantInt) => {
        const have = resolve(value);

        expect(have.tag).toBe(wantTag);
        expect(have.int).toBe(wantInt);
    });
});

describe("parseYaml", () => {
    it("builds yaml.v3-shaped nodes with lines and styles", () => {
        const have = root(
            "a: 1\nb: 'q'\nc: \"d\"\nd: |\n  lit\ne: >\n  fold\nf: [x]\ng:\n  - y\nh: {k: v}\n",
        );

        expect(have.kind).toBe("mapping");
        const vals = have.content.filter((_, i) => i % 2 === 1);
        expect(vals.map((v) => v.style)).toEqual([
            "plain",
            "single",
            "double",
            "literal",
            "folded",
            "flow",
            "block",
            "flow",
        ]);
        expect(vals.map((v) => v.line)).toEqual([1, 2, 3, 4, 6, 8, 10, 11]);
        expect(vals.map(shortTag)).toEqual([
            TAG.int,
            TAG.str,
            TAG.str,
            TAG.str,
            TAG.str,
            TAG.seq,
            TAG.seq,
            TAG.map,
        ]);
    });

    it("keeps explicit tags short and binary text as written", () => {
        const have = root(
            'a: !!int "12"\nb: !x y\nc: !!binary aGk=\nd: ! 12\n',
        );

        const vals = have.content.filter((_, i) => i % 2 === 1);
        expect(vals.map((v) => v.tag)).toEqual([
            "!!int",
            "!x",
            "!!binary",
            "!",
        ]);
        expect(vals[2]?.value).toBe("aGk=");
        expect(scalarText(vals[2] as YamlNode)).toBe("hi");
        expect(shortTag(vals[3] as YamlNode)).toBe(TAG.int);
    });

    it("gives a plain << the merge tag", () => {
        const have = root("<<: {a: 1}\n'<<': 2\n!!str <<: 3\n");

        const keys = have.content.filter((_, i) => i % 2 === 0);
        expect(keys.map((k) => k.tag)).toEqual([TAG.merge, "", TAG.str]);
        expect(keys.map((k) => k.tagged)).toEqual([undefined, undefined, true]);
    });

    it("decodes URI escapes in tags", () => {
        const have = root("a: !e%C3%A9 x\nb: !!in%74 1\nc: !x%FF y\n");

        const vals = have.content.filter((_, i) => i % 2 === 1);
        expect(vals.map((v) => v.tag)).toEqual(["!eé", TAG.int, "!x%FF"]);
    });

    it("records anchors", () => {
        const have = root("a: &x v\nb: &y [1]\n");

        expect(have.content[1]?.anchor).toBe("x");
        expect(have.content[3]?.anchor).toBe("y");
    });

    it("refuses malformed binary text when decoding it", () => {
        const have = root("a: !!binary 'a#=='\n").content[1] as YamlNode;

        expect(() => scalarText(have)).toThrow(YamlValueError);
        expect(() => scalarText(have)).toThrow(
            "yaml: !!binary value contains invalid base64 data",
        );
    });

    it("links aliases to their anchors", () => {
        const have = root("a: &x v\nb: *x\nc: *x\n");

        const b = have.content[3] as YamlNode;
        expect(b.kind).toBe("alias");
        expect(b.value).toBe("x");
        expect(b.alias).toBe(have.content[1]);
        expect(shortTag(b)).toBe(TAG.str);
        expect((have.content[5] as YamlNode).alias).toBe(b.alias);
    });

    it("fills empty keys and values with null scalars", () => {
        const have = root("a:\n? b\n");

        expect(have.content.map((n) => [n.value, shortTag(n)])).toEqual([
            ["a", TAG.str],
            ["", TAG.null],
            ["b", TAG.str],
            ["", TAG.null],
        ]);
    });

    it("reads only the first document", () => {
        const have = root("a: 1\n---\n: : bad\n");

        expect(have.content).toHaveLength(2);
    });

    it("returns undefined for an empty document", () => {
        expect(parseYaml("")).toBeUndefined();
        expect(parseYaml("# comment\n")).toBeUndefined();
    });

    it.each([
        ["a: *nope\n", "unknown anchor 'nope' referenced"],
        ["a: b: c\n", "mapping values are not allowed in this context"],
        ["a: 1\nb: 'x\n", "found unexpected end of stream"],
        ["a: 1\nb\n", "line 2: could not find expected ':'"],
        ["a: [x, y\n", "line 1: did not find expected ',' or ']'"],
        ["[a\n", "line 1: did not find expected ',' or ']'"],
        ["a: {b: 1\n", "line 1: did not find expected ',' or '}'"],
        ["{a: 1\n", "line 1: did not find expected ',' or '}'"],
        [
            "a: 1\n\tb: 2\n",
            "line 2: found a tab character that violates indentation",
        ],
        ['a: "\\q"\n', "found unknown escape character"],
        ["a: @x\n", "found character that cannot start any token"],
    ])("words a syntax error in %j like yaml.v3", (src, want) => {
        const have = () => parseYaml(src);

        expect(have).toThrow(YamlSyntaxError);
        expect(have).toThrow(want);
    });

    it("falls back to the parser's own message", () => {
        const have = () => parseYaml('a: "x" y\n');

        expect(have).toThrow(YamlSyntaxError);
        expect(have).toThrow(/^Unexpected scalar/);
    });
});
