// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { metadataTable, plainCell } from "../../src/corpus/metadata.ts";

describe("metadataTable", () => {
    it("reads the leading two-column table as plain text", () => {
        const body = [
            "",
            "|                |                     |",
            "|----------------|---------------------|",
            "| ****Status**** | `adf:!PROPOSED\\|color=neutral;style=bold` |",
            "| ****Owners**** | `adf:@Ann Lee``adf:@Bo Ek` |",
            "| **Designs**    | <https://ex.com/d>  |",
            "",
            "# Intro",
        ].join("\n");

        const have = metadataTable(body);

        expect(have).toEqual({
            Status: "PROPOSED",
            Owners: "Ann Lee, Bo Ek",
            Designs: "https://ex.com/d",
        });
    });

    it("keeps a header row that names a field", () => {
        const have = metadataTable(
            "| Status | Draft |\n|---|---|\n| Owner | Ann |",
        );

        expect(have).toEqual({ Status: "Draft", Owner: "Ann" });
    });

    it("keeps the first of two rows with one key", () => {
        const have = metadataTable("| A | 1 |\n|---|---|\n| A | 2 |");

        expect(have).toEqual({ A: "1" });
    });

    it("skips rows that are not two cells", () => {
        const have = metadataTable("| A | 1 | x |\n|---|---|---|\n| B | 2 |");

        expect(have).toEqual({ B: "2" });
    });

    it("reads nothing when the body does not open with a table", () => {
        const have = metadataTable("# Intro\n\n| Status | Draft |");

        expect(have).toEqual({});
    });

    it("reads nothing from an empty body", () => {
        expect(metadataTable("")).toEqual({});
    });
});

describe("plainCell", () => {
    it.each([
        ["status label", "`adf:!IN PROGRESS|color=blue`", "IN PROGRESS"],
        ["mention", "`adf:@Ann Lee`", "Ann Lee"],
        ["code span", "`v2`", "v2"],
        ["link", "[the spec](https://ex.com/s)", "the spec"],
        ["autolink", "<https://ex.com/s>", "https://ex.com/s"],
        ["bold", "****Status****", "Status"],
        ["double underscore", "__Owner__", "Owner"],
        ["snake case stays", "page_version", "page_version"],
        ["spaces", "  a   b  ", "a b"],
    ])("%s", (_, in_, want) => {
        expect(plainCell(in_)).toBe(want);
    });
});
