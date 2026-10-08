// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    DEFAULT_WHOLE_FILE_TOKENS,
    headingLevel,
    headingLines,
    headingText,
    isFence,
    setHeading,
    splitSections,
} from "../../src/corpus/chunker.ts";
import { readGolden } from "../support/golden.ts";

describe("splitSections", () => {
    // go: Test_splitSections_whole_file
    it("keeps a short body whole", () => {
        const body = "# Title\n\nshort body\n";

        const have = splitSections(body, DEFAULT_WHOLE_FILE_TOKENS);

        expect(have).toHaveLength(1);
        expect(have[0]?.text).toBe("# Title\n\nshort body");
        expect(have[0]?.startLine).toBe(1);
        expect(have[0]?.headingPath).toEqual([]);
    });

    // go: Test_splitSections_splits_on_headings
    it("splits on level 1 and 2 headings", () => {
        const table = "| P | Proto |\n|---|---|\n| X | EPUB |";
        const body =
            "# Doc\n\nintro\n\n" +
            "## Family A\n\n" +
            table +
            "\n\n" +
            "## Family B\n\nnotes\n";

        const have = splitSections(body, 1);

        expect(have).toHaveLength(3);
        expect(have[0]?.headingPath).toEqual(["Doc"]);
        expect(have[1]?.headingPath).toEqual(["Doc", "Family A"]);
        expect(have[2]?.headingPath).toEqual(["Doc", "Family B"]);
        expect(have[1]?.text).toContain(table);
    });

    // go: Test_splitSections_ignores_fenced_headings
    it("ignores headings inside fences", () => {
        const body = "## Real\n\n```\n## fake\n```\n\nafter\n";

        const have = splitSections(body, 1);

        expect(have).toHaveLength(1);
        expect(have[0]?.headingPath).toEqual(["Real"]);
        expect(have[0]?.text).toContain("## fake");
    });

    it("keeps preamble, deep headings, start lines and drops blank parts", () => {
        const body =
            "preamble\n\n# A\n\n### deep\n\ntext\n## B\n\n\n# C\n#### D\n";

        const have = splitSections(body, 1);

        expect(have).toEqual([
            { headingPath: [], text: "preamble", startLine: 1 },
            {
                headingPath: ["A"],
                text: "# A\n\n### deep\n\ntext",
                startLine: 3,
            },
            { headingPath: ["A", "B"], text: "## B", startLine: 8 },
            { headingPath: ["C"], text: "# C\n#### D", startLine: 11 },
        ]);
    });

    it("returns nothing for a blank body", () => {
        expect(splitSections(" \n\u0085\n", 1)).toEqual([]);
    });
});

// go: Test_headingLines_tabular
describe("headingLines", () => {
    it.each([
        ["empty", "", []],
        ["no headings", "text\n#hashtag\n", []],
        [
            "every level",
            "# A\n## B\n### C\n#### D\n##### E\n###### F\n",
            [0, 1, 2, 3, 4, 5],
        ],
        ["empty heading", "## \ntext\n", [0]],
        ["backtick fence", "# A\n```\n## B\n```\n## C\n", [0, 4]],
        ["tilde fence", "# A\n~~~\n## B\n~~~\n", [0]],
    ])("%s", (_, body, want) => {
        const have = headingLines(body);

        expect(have).toEqual(want);
    });
});

// go: Test_isFence_tabular
describe("isFence", () => {
    it.each([
        ["backticks", "```go", true],
        ["tildes", "~~~", true],
        ["indented", "   ```", true],
        ["prose", "code here", false],
        ["inline code", "`x`", false],
    ])("%s", (_, line, want) => {
        const have = isFence(line);

        expect(have).toBe(want);
    });
});

// go: Test_headingLevel_tabular
describe("headingLevel", () => {
    it.each([
        ["h1", "# x", 1],
        ["h2", "## x", 2],
        ["h6", "###### x", 6],
        ["prose", "text", 0],
        ["no space", "#x", 0],
        ["seven hashes", "####### x", 0],
        ["tab separator", "#\tx", 1],
        ["vertical tab is not RE2 space", "#\u000bx", 0],
        ["no-break space is not RE2 space", "# x", 0],
    ])("%s", (_, line, want) => {
        const have = headingLevel(line);

        expect(have).toBe(want);
    });
});

// go: Test_headingText_tabular
describe("headingText", () => {
    it.each([
        ["simple", "## Foo Bar", "Foo Bar"],
        ["extra spaces", "#   Spaced", "Spaced"],
        ["single word", "### x", "x"],
    ])("%s", (_, line, want) => {
        const have = headingText(line);

        expect(have).toBe(want);
    });
});

// go: Test_setHeading_tabular
describe("setHeading", () => {
    it.each([
        ["append at level one", [], 1, "A", ["A"]],
        ["replace same level", ["A"], 1, "B", ["B"]],
        ["deeper level", ["A"], 2, "B", ["A", "B"]],
        ["truncate deeper levels", ["A", "B", "C"], 2, "X", ["A", "X"]],
        ["skipped level pads", [], 3, "C", ["", "", "C"]],
    ])("%s", (_, path, level, text, want) => {
        const have = setHeading(path, level, text);

        expect(have).toEqual(want);
    });
});

interface ChunkRow {
    body: string;
    tokens: number;
    sections: { heading_path: string[]; text: string; start_line: number }[];
}

const golden = readGolden<ChunkRow[]>(
    new URL("testdata/chunks.golden.json", import.meta.url),
);

describe("splitSections against the Go oracle", () => {
    it.each(
        golden.map((r) => [JSON.stringify(r.body).slice(0, 60), r] as const),
    )("matches Go for %s", (_, row) => {
        const have = splitSections(row.body, row.tokens);

        const want = row.sections.map((s) => ({
            headingPath: s.heading_path,
            text: s.text,
            startLine: s.start_line,
        }));
        expect(have).toEqual(want);
    });
});
