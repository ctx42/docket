// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    encodeJSON,
    encodeJSONLine,
    encodeString,
    formatFloat,
    JSONEncodeError,
} from "../../src/gocompat/json.ts";
import { readGolden } from "../support/golden.ts";

interface Golden {
    json_string: { input: string; escaped: string; raw: string }[];
    json_float: { input: string; output?: string; err?: string }[];
}

/** goFloat parses s like Go strconv.ParseFloat, which spells infinity "+Inf". */
function goFloat(s: string): number {
    if (s === "+Inf") return Number.POSITIVE_INFINITY;
    if (s === "-Inf") return Number.NEGATIVE_INFINITY;
    return Number(s);
}

const golden = readGolden<Golden>(
    new URL("testdata/gocompat.golden.json", import.meta.url),
);

describe("encodeString", () => {
    it.each(golden.json_string)("encodes $input as Go", (row) => {
        expect(encodeString(row.input)).toBe(row.escaped);
        expect(encodeString(row.input, false)).toBe(row.raw);
    });

    it("writes U+FFFD for a lone surrogate, keeps a pair", () => {
        const have = encodeString("a\ud800b\udc00c😀\ud83d");

        expect(have).toBe('"a\\ufffdb\\ufffdc😀\\ufffd"');
    });
});

describe("formatFloat", () => {
    const ok = golden.json_float.filter((r) => r.err === undefined);
    const bad = golden.json_float.filter((r) => r.err !== undefined);

    it.each(ok)("formats $input as Go", (row) => {
        const have = formatFloat(goFloat(row.input));

        expect(have).toBe(row.output);
    });

    it.each(bad)("rejects $input with Go's error", (row) => {
        const have = () => formatFloat(goFloat(row.input));

        expect(have).toThrow(JSONEncodeError);
        expect(have).toThrow(row.err as string);
    });
});

describe("encodeJSON", () => {
    it("keeps field order, omits undefined, nests values", () => {
        const v = {
            z: 1,
            a: [true, false, null, "x<y"],
            skip: undefined,
            n: { big: 9007199254740993n, f: 0.5 },
            e: [],
            o: {},
        };

        const have = encodeJSON(v);

        const want =
            '{"z":1,"a":[true,false,null,"x\\u003cy"],' +
            '"n":{"big":9007199254740993,"f":0.5},"e":[],"o":{}}';
        expect(have).toBe(want);
    });

    it("escapes keys and honours escapeHTML false", () => {
        const have = encodeJSON({ "<k>": "&" }, { escapeHTML: false });

        expect(have).toBe('{"<k>":"&"}');
    });

    it("appends a newline like json.Encoder", () => {
        const have = encodeJSONLine({ error: "a & b" });

        expect(have).toBe('{"error":"a \\u0026 b"}\n');
    });

    it("refuses a non-finite number", () => {
        const have = () => encodeJSON({ score: Number.NaN });

        expect(have).toThrow("json: unsupported value: NaN");
    });
});
