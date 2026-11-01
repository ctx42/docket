// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    detectKeys,
    keyValue,
    setKeyLines,
} from "../../src/mcp/feature-keys.ts";

describe("detectKeys", () => {
    const FILES = [
        "wiki/doc/process/srd-guidelines.md",
        "wiki/doc/glossary/launch-slot.md",
        "wiki/doc/engines/overview.md",
        "wiki/srd/slot-swap/slot-swap-srd.md",
        "kb/billing.md",
        "notes/x.md",
    ];

    it("finds every key in a typical vault", () => {
        const have = detectKeys(FILES, ["wiki", "kb"]);

        expect(have).toEqual({
            initiatives: { value: "wiki/srd" },
            glossary: { value: "wiki/doc/glossary" },
            gaps: { value: "gap" },
            precedence: { value: ["kb", "wiki/doc"] },
        });
    });

    it("finds an SRD folder by its *-srd.md files", () => {
        const files = [
            "docs/specs/pay/pay-srd.md",
            "docs/specs/login/login-srd.md",
            "docs/a.md",
        ];

        const have = detectKeys(files, ["docs"]);

        expect(have.initiatives).toEqual({ value: "docs/specs" });
    });

    it("reports two candidates as not found, naming them", () => {
        const files = ["a/srd/x/x-srd.md", "b/initiatives/y/y-srd.md"];

        const have = detectKeys(files, ["a", "b"]);

        expect(have.initiatives).toEqual({
            candidates: ["a/srd", "b/initiatives"],
        });
    });

    it("reports a missing glossary as not found", () => {
        const have = detectKeys(["docs/a.md"], ["docs"]);

        expect(have.glossary).toEqual({ candidates: [] });
    });

    it("takes a glossary Markdown file", () => {
        const have = detectKeys(["docs/glossary.md", "docs/a.md"], ["docs"]);

        expect(have.glossary).toEqual({ value: "docs/glossary.md" });
    });
});

describe("setKeyLines", () => {
    const NOTE =
        "---\nmcp-server: docs # name\nsources:\n  - docs\ngaps: old\nprecedence:\n  - a\n  - b\nkb: kb\n---\n\n# Body\n";

    it("replaces a scalar key's line and keeps every other byte", () => {
        const have = setKeyLines(NOTE, "gaps", "gap");

        expect(have).toBe(NOTE.replace("gaps: old", "gaps: gap"));
    });

    it("replaces a list key's lines", () => {
        const have = setKeyLines(NOTE, "precedence", ["kb", "docs/api"]);

        expect(have).toBe(
            NOTE.replace(
                "precedence:\n  - a\n  - b\n",
                "precedence:\n  - kb\n  - docs/api\n",
            ),
        );
    });

    it("adds a missing key at the end of the front matter", () => {
        const have = setKeyLines(NOTE, "glossary", "docs/glossary");

        expect(have).toBe(
            NOTE.replace("kb: kb\n---", "kb: kb\nglossary: docs/glossary\n---"),
        );
    });

    it("keeps CRLF line ends", () => {
        const have = setKeyLines("---\r\ngaps: x\r\n---\r\n", "gaps", "gap");

        expect(have).toBe("---\r\ngaps: gap\r\n---\r\n");
    });

    it("error - a note without front matter", () => {
        expect(() => setKeyLines("# Body\n", "gaps", "gap")).toThrow(
            "the config note has no front matter",
        );
    });
});

describe("keyValue", () => {
    const NOTE =
        "---\ngaps: 'gap' # folder\nsources: [docs, kb]\nprecedence:\n  - kb\n  - \"docs/api\"\nempty:\n---\n";

    it.each([
        ["a scalar without quotes and comment", "gaps", "gap"],
        ["a flow list", "sources", ["docs", "kb"]],
        ["a block list", "precedence", ["kb", "docs/api"]],
        ["an empty key", "empty", []],
        ["an unset key", "glossary", undefined],
    ])("%s", (_name, key, want) => {
        expect(keyValue(NOTE, key)).toEqual(want);
    });

    it("is undefined without front matter", () => {
        expect(keyValue("# Body\n", "gaps")).toBeUndefined();
    });
});
