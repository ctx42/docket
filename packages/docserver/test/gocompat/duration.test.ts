// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    DurationParseError,
    formatDuration,
    HOUR,
    MICROSECOND,
    MILLISECOND,
    MINUTE,
    NANOSECOND,
    parseDuration,
    SECOND,
} from "../../src/gocompat/duration.ts";
import { readGolden } from "../support/golden.ts";

interface Golden {
    duration_format: { nanos: string; string: string }[];
    duration_parse: { input: string; nanos?: string; err?: string }[];
}

const golden = readGolden<Golden>(
    new URL("testdata/gocompat.golden.json", import.meta.url),
);

describe("formatDuration", () => {
    it.each(golden.duration_format)("formats $nanos ns as Go", (row) => {
        const have = formatDuration(BigInt(row.nanos));

        expect(have).toBe(row.string);
    });
});

describe("parseDuration", () => {
    const ok = golden.duration_parse.filter((r) => r.err === undefined);
    const bad = golden.duration_parse.filter((r) => r.err !== undefined);

    it.each(ok)("parses $input as Go", (row) => {
        const have = parseDuration(row.input);

        expect(have).toBe(BigInt(row.nanos as string));
    });

    it.each(bad)("rejects $input with Go's error", (row) => {
        const have = () => parseDuration(row.input);

        expect(have).toThrow(DurationParseError);
        expect(have).toThrow(row.err as string);
    });

    it("round-trips Go's formatting", () => {
        const want = 3n * HOUR + 2n * MINUTE + 1n * SECOND + 5n * MILLISECOND;

        const have = parseDuration(formatDuration(want));

        expect(have).toBe(want);
    });

    it("exposes Go's unit constants", () => {
        expect([NANOSECOND, MICROSECOND, MILLISECOND]).toEqual([
            1n,
            1000n,
            1000000n,
        ]);
        expect([SECOND, MINUTE, HOUR]).toEqual([
            1000000000n,
            60000000000n,
            3600000000000n,
        ]);
    });
});
