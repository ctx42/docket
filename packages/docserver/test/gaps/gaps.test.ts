// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    checkGap,
    closed,
    EC_INVALID,
    emptyGap,
    type Fill,
    type Filter,
    fileName,
    filePath,
    type Gap,
    GapError,
    gapError,
    hash,
    isGapError,
    matchFilter,
    type Patch,
    validAnswer,
    validateFill,
    validateGap,
    validatePatch,
    validKind,
    validStatus,
    ZERO_TIME,
} from "../../src/gaps/gaps.ts";
import { readGolden } from "../support/golden.ts";

/** AUTHORED is a gap as an author reports it. */
const AUTHORED: Gap = {
    ...emptyGap(),
    kind: "missing",
    answer: "deferred",
    srdRef: "SRD-7 §4.3",
    docID: "docs/catalog/epub.md",
    headingPath: ["Catalog", "Delivery"],
    searchTerms: ["token", "ttl"],
    topic: "EPUB download token TTL",
    demand: "SRD-7 needs the token TTL.",
    detail: "TTL never stated.",
    targetClaim: "Token valid 24h.",
};

/** IMPORTED is a fully specified filled gap. */
const IMPORTED: Gap = {
    ...emptyGap(),
    id: "gap-0007",
    status: "filled",
    kind: "incomplete",
    docID: "docs/catalog/epub.md",
    hits: 3,
    created: { unix: Date.UTC(2026, 4, 2, 8, 30) / 1000, nsec: 0, offset: 0 },
    filledBy: [{ ref: "docs/catalog/epub.md#tokens", hash: "ab" }],
    topic: "EPUB token lifetime",
    demand: "SRD-7 needs it.",
    detail: "Stated now.",
};

/** IMPORTED_NAME is the file name of IMPORTED. */
const IMPORTED_NAME = "gap-0007-epub-token-lifetime.md";

/** invalidMessage asserts fn throws ErrInvalid and returns the message. */
function invalidMessage(fn: () => void): string {
    try {
        fn();
    } catch (err) {
        expect(isGapError(err, EC_INVALID)).toBe(true);
        return (err as Error).message;
    }
    throw new Error("did not throw");
}

// go: Test_Kind_valid_tabular
describe("validKind", () => {
    it.each([
        ["missing", true],
        ["wrong", true],
        ["incomplete", true],
        ["ambiguous", true],
        ["", false],
        ["odd", false],
    ])("%j", (k, want) => {
        expect(validKind(k)).toBe(want);
    });
});

// go: Test_Status_valid_tabular
describe("validStatus", () => {
    it.each([
        ["draft", true],
        ["open", true],
        ["filled", true],
        ["wontfix", true],
        ["", false],
        ["kb", false],
        ["resolved", false],
    ])("%j", (s, want) => {
        expect(validStatus(s)).toBe(want);
    });
});

// go: Test_Status_closed_tabular
describe("closed", () => {
    it.each([
        ["draft", false],
        ["open", false],
        ["filled", true],
        ["wontfix", true],
        ["odd", false],
    ])("%j", (s, want) => {
        expect(closed(s)).toBe(want);
    });
});

// go: Test_Answer_valid_tabular
describe("validAnswer", () => {
    it.each([
        ["", true],
        ["deferred", true],
        ["unknown", true],
        ["maybe", false],
    ])("%j", (a, want) => {
        expect(validAnswer(a)).toBe(want);
    });
});

describe("hash", () => {
    // go: Test_Hash
    it("hashes text with SHA-256", () => {
        expect(hash("abc")).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    });

    // go: Test_Hash_normalizes_tabular
    it.each([
        ["as is", "## A\n\ntext"],
        ["crlf", "## A\r\n\r\ntext"],
        ["trailing newlines", "## A\n\ntext\n\n\n"],
        ["trailing blanks", "## A\n\ntext \t\n  \n"],
        ["crlf and trailing", "## A\r\n\r\ntext\r\n\r\n"],
    ])("normalizes %s", (_, text) => {
        expect(hash(text)).toBe(hash("## A\n\ntext"));
    });

    // go: Test_Hash_differs_tabular
    it.each([
        ["changed word", "## A\n\nother"],
        ["inner trailing blank", "## A \n\ntext"],
        ["leading blank line", "\n## A\n\ntext"],
    ])("differs for %s", (_, text) => {
        expect(hash(text)).not.toBe(hash("## A\n\ntext"));
    });

    it("equals Go's gaps.Hash for every frozen corpus section", () => {
        const golden = readGolden<[string, string][]>(
            new URL("testdata/hash.golden.json", import.meta.url),
        );

        const misses = golden.filter(([text, want]) => hash(text) !== want);

        expect(misses).toEqual([]);
        expect(golden.length).toBeGreaterThan(60);
    });
});

describe("validateGap", () => {
    // go: Test_Gap_validate
    it("accepts an authored gap", () => {
        expect(() => validateGap(AUTHORED)).not.toThrow();
    });

    // go: Test_Gap_validate_error_tabular
    it.each([
        ["kind", { kind: "" }, 'unknown kind ""'],
        ["answer", { answer: "x" }, 'unknown answer "x"'],
        ["blank ask name", { ask: ["Anna", " "] }, "blank ask name"],
        [
            "asked not a date",
            { asked: "04.10.2026" },
            'asked: want a YYYY-MM-DD date, have "04.10.2026"',
        ],
        ["topic", { topic: " " }, "topic is required"],
        ["topic lines", { topic: "a\nb" }, "topic must be one line"],
        ["demand", { demand: "" }, "demand is required"],
        ["detail", { detail: "\n" }, "detail is required"],
        [
            "heading in target",
            { targetClaim: "x\n## Notes" },
            "target_claim must not hold a level-1 or level-2 heading",
        ],
    ])("refuses %s", (_, edit: Partial<Gap>, want) => {
        const have = invalidMessage(() =>
            validateGap({ ...AUTHORED, ...edit }),
        );

        expect(have).toBe(`invalid gap input: ${want}`);
    });
});

describe("checkGap", () => {
    // go: Test_Gap_Check
    it("accepts an imported gap", () => {
        expect(() => checkGap(IMPORTED)).not.toThrow();
    });

    // go: Test_Gap_Check_error_tabular
    it.each([
        ["id", { id: "gap-7" }, "want id gap-NNNN"],
        ["status", { status: "kb" }, 'unknown status "kb"'],
        ["demand", { demand: "" }, "demand is required"],
        ["hits", { hits: 0 }, "hits must be at least 1"],
        ["created", { created: ZERO_TIME }, "created is required"],
        [
            "blank ref",
            { filledBy: [{ ref: " ", hash: "" }] },
            "blank filled_by entry",
        ],
        [
            "filled without refs",
            { filledBy: [] },
            "a filled gap needs filled_by",
        ],
    ])("refuses %s", (_, edit: Partial<Gap>, want) => {
        expect(
            invalidMessage(() => checkGap({ ...IMPORTED, ...edit })),
        ).toContain(want);
    });
});

// go: Test_Gap_FileName_tabular
describe("fileName", () => {
    it.each([
        ["slug", "EPUB token lifetime", IMPORTED_NAME],
        ["no letters", "¿!", "gap-0007-gap.md"],
    ])("%s", (_, topic, want) => {
        expect(fileName({ id: "gap-0007", topic })).toBe(want);
    });
});

// go: Test_Gap_FilePath_tabular
describe("filePath", () => {
    it.each([
        ["draft", IMPORTED_NAME],
        ["open", IMPORTED_NAME],
        ["filled", `closed/${IMPORTED_NAME}`],
        ["wontfix", `closed/${IMPORTED_NAME}`],
    ])("%s", (status, want) => {
        expect(
            filePath({ id: "gap-0007", status, topic: IMPORTED.topic }),
        ).toBe(want);
    });
});

describe("validatePatch", () => {
    // go: Test_Patch_validate_tabular
    it.each([
        ["empty", {}, "nothing to update"],
        ["kind", { kind: "x" }, 'unknown kind "x"'],
        ["answer", { answer: "x" }, 'unknown answer "x"'],
        ["ask", { ask: [""] }, "blank ask name"],
        ["asked", { asked: "2026-13-01" }, "asked: want a YYYY-MM-DD"],
        ["topic", { topic: "" }, "topic is required"],
        ["demand", { demand: "" }, "demand is required"],
        ["detail", { detail: "" }, "detail is required"],
        ["target", { targetClaim: "# x" }, "target_claim must not"],
        ["add hit false alone", { addHit: false }, "nothing to update"],
    ])("refuses %s", (_, pch: Patch, want) => {
        expect(invalidMessage(() => validatePatch(pch))).toContain(want);
    });

    // go: Test_Patch_validate
    it("accepts a cleared target claim with a hit", () => {
        expect(() =>
            validatePatch({ targetClaim: "", addHit: true }),
        ).not.toThrow();
    });

    // go: Test_Patch_validate_clears_ask_and_asked
    it("accepts clearing ask and asked", () => {
        expect(() => validatePatch({ ask: [], asked: "" })).not.toThrow();
    });
});

// go: Test_Fill_validate_tabular
describe("validateFill", () => {
    it.each([
        ["no refs", { refs: [], complete: false }, "filled_by is required"],
        [
            "blank ref",
            { refs: [" "], complete: false },
            "blank filled_by entry",
        ],
        [
            "heading in remaining",
            { refs: ["a"], complete: false, remaining: "# x" },
            "remaining must not hold",
        ],
    ])("refuses %s", (_, fll: Fill, want) => {
        expect(invalidMessage(() => validateFill(fll))).toContain(want);
    });

    it("accepts a valid fill", () => {
        expect(() =>
            validateFill({ refs: ["a#b"], complete: true, remaining: "left" }),
        ).not.toThrow();
    });
});

describe("matchFilter", () => {
    // go: Test_Filter_match_tabular
    it.each([
        ["zero", {}, true],
        ["status match", { status: "draft" }, true],
        ["status mismatch", { status: "open" }, false],
        ["srd ref prefix", { srdRef: "initiatives/checkout" }, true],
        ["srd ref substring", { srdRef: "srd.md" }, true],
        ["srd ref mismatch", { srdRef: "wishlist" }, false],
        ["both match", { status: "draft", srdRef: "checkout" }, true],
        [
            "status mismatch srd ref match",
            { status: "open", srdRef: "checkout" },
            false,
        ],
        ["stale on gap not stale", { stale: true }, false],
    ])("%s", (_, flt: Filter, want) => {
        const gap = {
            ...emptyGap(),
            status: "draft",
            srdRef: "initiatives/checkout/srd.md §4",
        };

        expect(matchFilter(flt, gap)).toBe(want);
    });

    // go: Test_Filter_match_ask_tabular
    it.each([
        ["ask exact", { ask: "Bob" }, true],
        ["ask other case", { ask: "anna m" }, true],
        ["ask substring", { ask: "nna" }, true],
        ["ask padded", { ask: " bob " }, true],
        ["ask blank", { ask: " " }, true],
        ["ask mismatch", { ask: "Carl" }, false],
        ["asked true", { asked: true }, true],
        ["asked false", { asked: false }, false],
        ["ask and asked", { ask: "bob", asked: true }, true],
    ])("%s", (_, flt: Filter, want) => {
        const gap = {
            ...emptyGap(),
            ask: ["Anna M", "Bob"],
            asked: "2026-10-04",
        };

        expect(matchFilter(flt, gap)).toBe(want);
    });

    // go: Test_Filter_match_not_asked_tabular
    it.each([
        ["ask", { ask: "Anna" }, false],
        ["asked true", { asked: true }, false],
        ["asked false", { asked: false }, true],
    ])("not asked: %s", (_, flt: Filter, want) => {
        expect(matchFilter(flt, emptyGap())).toBe(want);
    });

    // go: Test_Filter_match_stale
    it("keeps a stale gap", () => {
        const gap = { ...emptyGap(), status: "filled", stale: true };

        expect(matchFilter({ status: "filled", stale: true }, gap)).toBe(true);
    });
});

describe("gapError", () => {
    it("wraps Go's sentinel texts with their codes", () => {
        const err = gapError("ECGapNotFound", "gap-0001");

        expect(err).toBeInstanceOf(GapError);
        expect(err.message).toBe("gap not found: gap-0001");
        expect(gapError("ECGapStatus").message).toBe(
            "gap status does not allow the operation",
        );
        expect(
            isGapError(new Error("x", { cause: err }), "ECGapNotFound"),
        ).toBe(true);
        expect(isGapError(err, "ECGapInvalid")).toBe(false);
    });
});
