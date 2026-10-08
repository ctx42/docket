// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { SECOND } from "../../src/gocompat/duration.ts";
import {
    type Decoded,
    decodeInto,
    type Schema,
    type YamlDecodeError,
} from "../../src/yamlv3/decode.ts";
import { parseYaml, type YamlNode } from "../../src/yamlv3/node.ts";

const SCHEMA = {
    kind: "struct",
    type: "x.T",
    fields: {
        s: { kind: "string" },
        b: { kind: "bool" },
        i: { kind: "int" },
        d: { kind: "duration" },
        p: { kind: "ptr", of: { kind: "duration" } },
        l: { kind: "list", of: { kind: "string" }, type: "[]string" },
        m: {
            kind: "map",
            of: { kind: "int" },
            type: "map[string]int",
            zero: () => 0,
        },
        n: { kind: "struct", type: "x.N", fields: { v: { kind: "string" } } },
    },
} as const satisfies Schema;

/** decode decodes yaml into a fresh target with defaults. */
function decode(yaml: string, knownFields = false): Decoded {
    const target: Decoded = {
        s: "def",
        b: false,
        i: 7,
        d: 5n,
        p: null,
        l: null,
        m: null,
        n: { v: "" },
    };
    decodeInto(parseYaml(yaml) as YamlNode, SCHEMA, target, { knownFields });
    return target;
}

/** errors returns the type errors decoding yaml reports. */
function errors(yaml: string, knownFields = false): readonly string[] {
    try {
        decode(yaml, knownFields);
    } catch (err) {
        return (err as YamlDecodeError).errors;
    }
    return [];
}

describe("decodeInto", () => {
    it("decodes every kind", () => {
        const have = decode(
            "s: 12\nb: yes\ni: 0x10\nd: 2s\np: 1s\nl: [a, ~, 2]\nm: {a: 1, b: ~}\nn: {v: w}\n",
        );

        expect(have).toEqual({
            s: "12",
            b: true,
            i: 16,
            d: 2n * SECOND,
            p: 1n * SECOND,
            l: ["a", "2"],
            m: new Map([
                ["a", 1],
                ["b", 0],
            ]),
            n: { v: "w" },
        });
    });

    it("keeps values for null scalars and clears null collections", () => {
        const have = decode("s: ~\nb: ~\ni: ~\nd: ~\np: ~\nl: ~\nm: ~\nn: ~\n");

        expect(have).toEqual({
            s: "def",
            b: false,
            i: 7,
            d: 5n,
            p: null,
            l: null,
            m: null,
            n: { v: "" },
        });
    });

    it.each([
        ["b: off", "b", false],
        ["b: N", "b", false],
        ["b: TRUE", "b", true],
        ["b: False", "b", false],
        ["i: 3.9", "i", 3],
        ["i: -2", "i", -2],
        ["i: 1_000", "i", 1000],
        ["i: 1e3", "i", 1000],
        ["i: !!int '12'", "i", 12],
    ])("decodes %j", (yaml, field, want) => {
        expect(decode(yaml)[field]).toBe(want);
    });

    it("follows aliases", () => {
        expect(decode("s: &a hi\nl: [*a]\n")).toMatchObject({
            s: "hi",
            l: ["hi"],
        });
    });

    it.each([
        ["s: [1]", "line 1: cannot unmarshal !!seq into string"],
        ["b: 1", "line 1: cannot unmarshal !!int `1` into bool"],
        ['b: "true"', "line 1: cannot unmarshal !!str `true` into bool"],
        ["i: abc", "line 1: cannot unmarshal !!str `abc` into int"],
        ["i: .inf", "line 1: cannot unmarshal !!float `.inf` into int"],
        [
            "i: 99999999999999999999",
            "line 1: cannot unmarshal !!float `9999999...` into int",
        ],
        ["d: 5", "line 1: cannot unmarshal !!int `5` into time.Duration"],
        ["d: nope", "line 1: cannot unmarshal !!str `nope` into time.Duration"],
        ["l: x", "line 1: cannot unmarshal !!str `x` into []string"],
        ["m: [1]", "line 1: cannot unmarshal !!seq into map[string]int"],
        ["n: x", "line 1: cannot unmarshal !!str `x` into x.N"],
        [
            "m: {a: 1, a: 2}",
            'line 1: mapping key "a" already defined at line 1',
        ],
    ])("reports %j", (yaml, want) => {
        expect(errors(yaml)).toEqual([want]);
    });

    it("refuses unknown fields only with knownFields, and keys must be scalars", () => {
        expect(errors("zz: 1\n")).toEqual([]);
        expect(errors("zz: 1\nn: {q: 2}\n", true)).toEqual([
            "line 1: field zz not found in type x.T",
            "line 2: field q not found in type x.N",
        ]);
        expect(errors("? [k]\n: 1\n")).toEqual([
            "line 1: cannot unmarshal !!seq into string",
        ]);
    });

    it("throws a YamlDecodeError listing every error", () => {
        expect(() => decode("s: [1]\nb: 2\n")).toThrow(
            "yaml: unmarshal errors:\n" +
                "  line 1: cannot unmarshal !!seq into string\n" +
                "  line 2: cannot unmarshal !!int `2` into bool",
        );
    });
});
