// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    badFile,
    claimedID,
    FileError,
    filler,
    parseBody,
    parseGapFile,
    renderBody,
    spans,
    splitMeta,
    topic,
    trimBlank,
} from "../../src/gaps/format.ts";
import {
    checkAsk,
    checkAsked,
    checkDate,
    checkSection,
    EC_BAD_FILE,
    EC_INVALID,
    emptyGap,
    isGapError,
} from "../../src/gaps/gaps.ts";
import { formatRFC3339Nano } from "../../src/gocompat/time.ts";
import { readGolden } from "../support/golden.ts";

/** MINIMAL_FILE is a valid gap file carrying only the required keys. */
const MINIMAL_FILE =
    "---\nid: gap-0003\nstatus: open\nkind: wrong\nhits: 2\ncreated: 2026-07-14T10:00:00Z\n---\n" +
    "# Topic\n## Demand\n## Detail\n## Target claim";

/** TEST_EPOCH is the fixed creation time of the test gaps. */
const TEST_EPOCH = {
    unix: Date.UTC(2026, 6, 14, 10) / 1000,
    nsec: 0,
    offset: 0,
};

const HEAD =
    "---\nid: gap-0003\nstatus: open\nkind: wrong\nhits: 1\ncreated: 2026-07-14T10:00:00Z\n";
const TAIL = "---\n# T\n## Demand\n## Detail\n## Target claim\n";

/** parseError returns the FileError parsing src as name throws. */
function parseError(name: string, src: string): FileError {
    try {
        parseGapFile(name, src);
    } catch (err) {
        return err as FileError;
    }
    throw new Error("parseGapFile did not throw");
}

describe("parseGapFile", () => {
    // go: Test_parseGapFile
    it("parses a minimal file and keeps its text", () => {
        const have = parseGapFile("gap-0003-topic.md", MINIMAL_FILE);

        expect(have.gap).toEqual({
            ...emptyGap(),
            id: "gap-0003",
            status: "open",
            kind: "wrong",
            hits: 2,
            created: TEST_EPOCH,
            topic: "Topic",
            file: "gap-0003-topic.md",
        });
        const text = `---\n${have.meta.lines.map((l) => `${l}\n`).join("")}---\n${renderBody(have.body)}`;
        expect(text).toBe(MINIMAL_FILE);
    });

    // go: Test_parseGapFile_error_tabular
    it.each([
        ["no front matter", "gap-0003.md", "# T\n", "no front matter"],
        ["unclosed", "gap-0003.md", "---\nid: x\n", "front matter not closed"],
        ["bad yaml", "gap-0003.md", "---\n: [\n---\n", "front matter: yaml"],
        ["not mapping", "gap-0003.md", "---\n- a\n---\n", "is not a mapping"],
        [
            "missing key",
            "gap-0003.md",
            `---\nid: gap-0003\n${TAIL}`,
            'missing required key "status"',
        ],
        [
            "duplicate key",
            "gap-0003.md",
            `${HEAD}kind: wrong\n${TAIL}`,
            'duplicate key "kind"',
        ],
        ["bad id", "gap-3.md", `---\nid: gap-3\n${TAIL}`, "want gap-NNNN"],
        [
            "name mismatch",
            "gap-0004-t.md",
            HEAD + TAIL,
            'file name does not match id "gap-0003"',
        ],
        [
            "unknown status",
            "gap-0003.md",
            `---\nstatus: kb\n${TAIL}`,
            'unknown status "kb"',
        ],
        [
            "unknown kind",
            "gap-0003.md",
            `---\nkind: x\n${TAIL}`,
            "unknown kind",
        ],
        [
            "unknown answer",
            "gap-0003.md",
            `---\nanswer: x\n${TAIL}`,
            "unknown answer",
        ],
        [
            "ask as scalar",
            "gap-0003.md",
            `${HEAD}ask: Anna M\n${TAIL}`,
            'key "ask": want a list',
        ],
        [
            "asked not a date",
            "gap-0003.md",
            `${HEAD}asked: last week\n${TAIL}`,
            'key "asked": want a YYYY-MM-DD date, have "last week"',
        ],
        [
            "asked with time",
            "gap-0003.md",
            `${HEAD}asked: 2026-10-04T10:00\n${TAIL}`,
            'key "asked": want a YYYY-MM-DD date',
        ],
        ["zero hits", "gap-0003.md", `---\nhits: 0\n${TAIL}`, "at least 1"],
        [
            "bad created",
            "gap-0003.md",
            `---\ncreated: today\n${TAIL}`,
            'key "created": parsing time',
        ],
        [
            "list as scalar",
            "gap-0003.md",
            `---\nsearch_terms: x\n${TAIL}`,
            "want a list",
        ],
        [
            "filled_by without ref",
            "gap-0003.md",
            `---\nfilled_by: [{hash: x}]\n${TAIL}`,
            "entry without ref",
        ],
        [
            "filled without filled_by",
            "gap-0003.md",
            `---\nid: gap-0003\nstatus: filled\nkind: wrong\nhits: 1\ncreated: 2026-07-14T10:00:00Z\n${TAIL}`,
            "filled gap without filled_by",
        ],
        ["no topic", "gap-0003.md", `${HEAD}---\ntext\n`, "missing topic"],
        [
            "no detail",
            "gap-0003.md",
            `${HEAD}---\n# T\n## Demand\n## Target claim\n`,
            'missing "## Detail" heading',
        ],
    ])("refuses %s", (_, name, src, want) => {
        const have = parseError(name, src);

        expect(isGapError(have, EC_BAD_FILE)).toBe(true);
        expect(have.message).toContain(want);
    });
});

// go: Test_badFile
describe("badFile", () => {
    it("names the file and keeps the reason as cause", () => {
        const reason = new Error("no front matter");

        const have = badFile("gap-0003-x.md", reason);

        expect(have.message).toBe(
            "invalid gap file gap-0003-x.md: no front matter",
        );
        expect(isGapError(have, EC_BAD_FILE)).toBe(true);
        expect(have.cause).toBe(reason);
    });
});

// go: Test_fileError_entry
describe("FileError.entry", () => {
    it("returns the file and reason", () => {
        expect(new FileError("gap-0003-x.md", "why").entry()).toEqual({
            file: "gap-0003-x.md",
            reason: "why",
        });
    });
});

// go: Test_claimedID_tabular
describe("claimedID", () => {
    it.each([
        ["valid", MINIMAL_FILE, "gap-0003"],
        ["bad body", "---\nid: gap-0009\n---\nno headings\n", "gap-0009"],
        ["no id", "---\nstatus: open\n---\n", ""],
        ["null id", "---\nid:\n---\n", ""],
        ["list id", "---\nid: [gap-0003]\n---\n", ""],
        ["no front matter", "# T\n", ""],
        ["bad yaml", "---\nid: gap-0003\nstatus: [\n---\n", ""],
    ])("%s", (_, src, want) => {
        expect(claimedID(src)).toBe(want);
    });
});

describe("decodeKey", () => {
    // go: Test_Gap_decodeKey_filled_by
    it("reads filled_by and nulls", () => {
        const src =
            "---\nid: gap-0003\nstatus: filled\nkind: wrong\nhits: 1\ncreated: 2026-07-14T10:00:00Z\n" +
            "filled_by:\n  - ref: kb/a.md#b\n    hash: 9f2c\n  - ref: kb/c.md\nanswer: ~\nheading_path: ~\n" +
            "---\n# T\n## Demand\n## Detail\n## Target claim\n";

        const have = parseGapFile("gap-0003-t.md", src).gap;

        expect(have.filledBy).toEqual([
            { ref: "kb/a.md#b", hash: "9f2c" },
            { ref: "kb/c.md", hash: "" },
        ]);
        expect(have.answer).toBe("");
        expect(have.headingPath).toEqual([]);
    });

    // go: Test_Gap_decodeKey_ask_as_obsidian_writes
    it("reads ask and asked as Obsidian writes them", () => {
        const src =
            "---\nid: gap-0003\nstatus: open\nkind: wrong\nask:\n  - Anna M\n" +
            '  - "Bob: support lead"\n  -\n  - anna m\nasked: 2026-10-04\nhits: 1\n' +
            "created: 2026-07-14T10:00:00Z\n---\n# T\n## Demand\n## Detail\n## Target claim\n";

        const have = parseGapFile("gap-0003-t.md", src).gap;

        expect(have.ask).toEqual(["Anna M", "Bob: support lead"]);
        expect(have.asked).toBe("2026-10-04");
    });

    // go: Test_Gap_decodeKey_ask_and_asked_empty_tabular
    it.each([
        ["absent", ""],
        ["null", "ask:\nasked:\n"],
        ["empty", 'ask: []\nasked: ""\n'],
    ])("reads empty ask and asked: %s", (_, meta) => {
        const have = parseGapFile("gap-0003-t.md", HEAD + meta + TAIL).gap;

        expect([have.ask, have.asked]).toEqual([[], ""]);
    });
});

// go: Test_parseBody
describe("parseBody", () => {
    it("splits the body into segments", () => {
        const src =
            "lead\n# Topic \nintro\n## Demand\nd\n## Detail\n~~~\n# not a heading\n~~~\n" +
            "## Target claim\nc\n### Sub\ns\n# Appendix\na\n";

        const have = parseBody(src);

        expect(have).toEqual({
            lead: "lead\n",
            h1: "# Topic \n",
            intro: "intro\n",
            headDemand: "## Demand\n",
            demand: "d\n",
            headDetail: "## Detail\n",
            detail: "~~~\n# not a heading\n~~~\n",
            headTarget: "## Target claim\n",
            target: "c\n### Sub\ns\n",
            tail: "# Appendix\na\n",
        });
        expect(renderBody(have)).toBe(src);
        expect(topic(have)).toBe("Topic");
    });
});

// go: Test_trimBlank_tabular
describe("trimBlank", () => {
    it.each([
        ["empty", "", ""],
        ["blank lines", "\n \n", ""],
        ["keeps indent", "\n\n    code\nnext  \n\n", "    code\nnext"],
    ])("%s", (_, text, want) => {
        expect(trimBlank(text)).toBe(want);
    });
});

/** invalidOrUndefined runs fn and returns whether it threw ErrInvalid. */
function throwsInvalid(fn: () => void): boolean {
    try {
        fn();
        return false;
    } catch (err) {
        expect(isGapError(err, EC_INVALID)).toBe(true);
        return true;
    }
}

// go: Test_checkAsk_tabular
describe("checkAsk", () => {
    it.each([
        ["nil", [], false],
        ["names", ["Anna M", "anna m"], false],
        ["empty name", ["Anna M", ""], true],
        ["blank name", [" \t"], true],
    ])("%s", (_, names, want) => {
        expect(throwsInvalid(() => checkAsk(names))).toBe(want);
    });
});

// go: Test_checkAsked
describe("checkAsked", () => {
    it("accepts a date", () => {
        expect(() => checkAsked("2026-10-04")).not.toThrow();
    });

    it("refuses a malformed date", () => {
        expect(() => checkAsked("2026-10-4")).toThrow(
            "asked: want a YYYY-MM-DD date",
        );
    });
});

// go: Test_checkDate_tabular
describe("checkDate", () => {
    it.each([
        ["empty", "", true],
        ["date", "2026-10-04", true],
        ["leap day", "2028-02-29", true],
        ["no leap day", "2026-02-29", false],
        ["short month", "2026-1-04", false],
        ["time", "2026-10-04T10:00:00Z", false],
        ["padded", " 2026-10-04", false],
        ["words", "today", false],
    ])("%s", (_, date, want) => {
        expect(checkDate(date) === undefined).toBe(want);
    });
});

// go: Test_checkSection_tabular
describe("checkSection", () => {
    it.each([
        ["plain", "text", false],
        ["level 3", "### Sub", false],
        ["hash tag", "#tag", false],
        ["level 1", "a\n# H", true],
        ["level 2 bare", "##", true],
    ])("%s", (_, text, want) => {
        expect(throwsInvalid(() => checkSection("detail", text))).toBe(want);
    });
});

interface GoldenRow {
    name: string;
    src: string;
    gap?: Record<string, unknown>;
    bad?: { file: string; reason: string };
}

/** Gap files and what Go's FileStore made of them (oracle `gapparse`). */
const golden = readGolden<GoldenRow[]>(
    new URL("testdata/gapparse.golden.json", import.meta.url),
);

/** SYNTAX_WORDING lists the one case whose YAML syntax wording differs (accepted). */
const SYNTAX_WORDING = new Set(["---\n: [\n---\n"]);

describe("parseGapFile against Go", () => {
    it.each(
        golden.map(
            (r, i) =>
                [`#${i} ${JSON.stringify(r.src).slice(0, 40)}`, r] as const,
        ),
    )("matches Go for %s", (_, r) => {
        if (r.bad !== undefined) {
            const err = parseError(r.name, r.src);
            if (SYNTAX_WORDING.has(r.src))
                expect(err.reason).toMatch(/^front matter: yaml: /);
            else expect(err.entry()).toEqual(r.bad);
            return;
        }
        const g = parseGapFile(r.name, r.src).gap;

        expect({
            id: g.id,
            status: g.status,
            kind: g.kind,
            answer: g.answer,
            ask: g.ask,
            asked: g.asked,
            srd_ref: g.srdRef,
            doc_id: g.docID,
            heading_path: g.headingPath,
            search_terms: g.searchTerms,
            hits: g.hits,
            created: formatRFC3339Nano(g.created),
            filled_by: g.filledBy.map((f) =>
                f.hash !== "" ? f : { ref: f.ref },
            ),
            topic: g.topic,
            demand: g.demand,
            detail: g.detail,
            target_claim: g.targetClaim,
            file: g.file,
        }).toEqual(r.gap);
    });
});

describe("spans", () => {
    it("gives each key its lines, comments and blanks going to the next key", () => {
        const { meta } = splitMeta(
            "---\n# lead\nid: gap-0003  # c\n\n# about status\nstatus: open\nask:\n  - a\n  - b\n\n---\n",
        );

        const have = spans(meta);

        expect(have).toEqual([
            { start: 1, end: 2 },
            { start: 4, end: 5 },
            { start: 5, end: 8 },
        ]);
    });

    it("refuses a flow mapping and keys sharing a line", () => {
        expect(
            spans(splitMeta("---\n{id: a, status: b}\n---\n").meta),
        ).toBeUndefined();
        const shared = splitMeta("---\nid: a\nstatus: b\n---\n").meta;
        shared.root.content[2] = {
            ...(shared.root.content[2] as (typeof shared.root.content)[number]),
            line: 1,
        };
        expect(spans(shared)).toBeUndefined();
        const outside = splitMeta("---\nid: a\n---\n").meta;
        outside.root.content[0] = {
            ...(outside.root
                .content[0] as (typeof outside.root.content)[number]),
            line: 9,
        };
        expect(spans(outside)).toBeUndefined();
    });

    it("tells filler lines", () => {
        expect([
            filler(""),
            filler("  "),
            filler(" # x"),
            filler("a: 1"),
        ]).toEqual([true, true, true, false]);
    });
});
