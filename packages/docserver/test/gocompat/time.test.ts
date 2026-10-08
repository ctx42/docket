// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    formatDateOnly,
    formatRFC3339,
    formatRFC3339Nano,
    fromDate,
    type GoTime,
    marshalTimeJSON,
    parseTime,
    type TimeLayout,
    TimeParseError,
    timeQuote,
} from "../../src/gocompat/time.ts";
import { readGolden } from "../support/golden.ts";

interface Golden {
    time_format: (GoTime & {
        rfc3339: string;
        json: string;
        date_only: string;
    })[];
    time_parse: (GoTime & {
        layout: TimeLayout;
        value: string;
        err?: string;
    })[];
}

const golden = readGolden<Golden>(
    new URL("testdata/gocompat.golden.json", import.meta.url),
);

describe("time formatting", () => {
    it.each(golden.time_format)(
        "formats unix $unix nsec $nsec offset $offset as Go",
        (row) => {
            const t = { unix: row.unix, nsec: row.nsec, offset: row.offset };

            expect(formatRFC3339(t)).toBe(row.rfc3339);
            expect(formatDateOnly(t)).toBe(row.date_only);
            if (row.json.startsWith("error: ")) {
                expect(() => marshalTimeJSON(t)).toThrow(row.json.slice(7));
            } else {
                expect(marshalTimeJSON(t)).toBe(row.json);
                expect(formatRFC3339Nano(t)).toBe(row.json.slice(1, -1));
            }
        },
    );
});

describe("parseTime", () => {
    const ok = golden.time_parse.filter((r) => r.err === undefined);
    const bad = golden.time_parse.filter((r) => r.err !== undefined);

    it.each(ok)("parses $layout $value as Go", (row) => {
        const have = parseTime(row.layout, row.value);

        const want = { unix: row.unix, nsec: row.nsec, offset: row.offset };
        expect(have).toEqual(want);
    });

    it.each(bad)("rejects $layout $value with Go's error", (row) => {
        const have = () => parseTime(row.layout, row.value);

        expect(have).toThrow(TimeParseError);
        expect(have).toThrow(row.err as string);
    });

    it("round-trips its own RFC 3339 output", () => {
        const want = { unix: 1784016000, nsec: 0, offset: -19800 };

        const have = parseTime("RFC3339", formatRFC3339(want));

        expect(have).toEqual(want);
    });
});

describe("fromDate", () => {
    it("splits milliseconds and keeps the given offset", () => {
        const d = new Date(Date.UTC(2026, 6, 14, 10, 0, 0, 250));

        const have = fromDate(d, 7200);

        expect(have).toEqual({
            unix: 1784023200,
            nsec: 250000000,
            offset: 7200,
        });
        expect(formatRFC3339(have)).toBe("2026-07-14T12:00:00+02:00");
    });

    it("defaults to the date's local offset", () => {
        const d = new Date(Date.UTC(2026, 6, 14, 10, 0, 0));

        const have = fromDate(d);

        expect(have.offset).toBe(-d.getTimezoneOffset() * 60);
    });

    it("handles instants before the epoch", () => {
        const have = fromDate(new Date(-1));

        expect([have.unix, have.nsec]).toEqual([-1, 999000000]);
    });
});

describe("timeQuote", () => {
    it("escapes quotes, backslashes, control and non-ASCII bytes", () => {
        const have = timeQuote('a"b\\c\u0001é');

        expect(have).toBe('"a\\"b\\\\c\\x01\\xc3\\xa9"');
    });
});
