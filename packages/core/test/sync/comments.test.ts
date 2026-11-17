// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { PageComment } from "../../src/confluence/client.ts";
import {
    planResolves,
    type RecordedThread,
    threadAt,
    threadOf,
    toRenderComments,
} from "../../src/sync/comments.ts";

const thread: RecordedThread = {
    id: "C1",
    markerRef: "M1",
    anchorText: "x",
    version: 1,
    replies: [],
};

const callout = "> [!comment] id:C1 · @u · 2026-01-01T00:00:00Z · open\n> Hi";
const anchored = `Text.[^cf-M1]\n\n${callout}`;
const unanchored = `Text.\n\n${callout}`;

describe("planResolves", () => {
    it("refuses a removed anchor the base render drew", () => {
        expect(() => planResolves([thread], unanchored, anchored)).toThrow(
            "id:C1 (anchor removed)",
        );
    });

    it("keeps a comment whose anchor the base render never drew", () => {
        const have = planResolves([thread], unanchored, unanchored);

        expect(have).toEqual([]);
    });

    it("resolves an anchorless comment once its callout is gone", () => {
        const have = planResolves([thread], "Text.", unanchored);

        expect(have).toEqual([thread]);
    });

    it("expects every anchor when the base render is unknown", () => {
        expect(() => planResolves([thread], unanchored, null)).toThrow(
            "anchor removed",
        );
    });
});

describe("toRenderComments", () => {
    /** A live comment by `authorName`, with `replies`. */
    const live = (
        id: string,
        authorName: string,
        replies: PageComment[] = [],
    ): PageComment => ({
        id,
        kind: "footer",
        resolution: "",
        markerRef: "",
        anchorText: "",
        authorId: `acc-${id}`,
        authorName,
        createdAt: "",
        version: 1,
        adf: "",
        replies,
    });

    it("carries each author's id and name, replies included", () => {
        const have = toRenderComments({
            inline: [],
            footer: [live("F1", "Ann", [live("F2", "Bob")])],
        });

        const f1 = have.trailing[0];
        expect(f1?.authorId).toBe("acc-F1");
        expect(f1?.authorName).toBe("Ann");
        expect(f1?.replies[0]?.authorId).toBe("acc-F2");
        expect(f1?.replies[0]?.authorName).toBe("Bob");
    });
});

describe("threadAt", () => {
    const note = [
        "---", //                                                          0
        'docket_page_id: "555"',
        "---",
        "",
        "Text.[^cf-M1]",
        "", //                                                             5
        "> [!comment] id:C1 · @Jane Doe · 2026-11-10T09:12:44Z · open",
        "> Which devices?",
        ">",
        "> Only loggers?",
        "> > [!comment] id:C2 · @Bob · 2026-11-11T09:00:00Z", //           10
        "> > The T2 ones.",
        "",
        "> A plain quote.",
        "",
        "## Comments", //                                                  15
        "",
        "> [!comment] id:F1 · 2026-11-12T08:00:00Z",
        "> Page note.",
    ].join("\n");

    const cases: Array<{
        name: string;
        line: number;
        want: { id: string; author: string; text: string } | null;
    }> = [
        {
            name: "the tag line",
            line: 6,
            want: {
                id: "C1",
                author: "Jane Doe",
                text: "Which devices?\n\nOnly loggers?",
            },
        },
        {
            name: "a body line",
            line: 9,
            want: {
                id: "C1",
                author: "Jane Doe",
                text: "Which devices?\n\nOnly loggers?",
            },
        },
        {
            name: "a reply, answering its thread",
            line: 11,
            want: {
                id: "C1",
                author: "Jane Doe",
                text: "Which devices?\n\nOnly loggers?",
            },
        },
        {
            name: "a thread with no author",
            line: 18,
            want: { id: "F1", author: "", text: "Page note." },
        },
        { name: "page text", line: 4, want: null },
        { name: "a blank line", line: 12, want: null },
        { name: "a plain quote", line: 13, want: null },
        { name: "the frontmatter", line: 1, want: null },
        { name: "a line past the end", line: 99, want: null },
        { name: "a negative line", line: -1, want: null },
    ];
    for (const tc of cases) {
        it(`finds the thread at ${tc.name}`, () => {
            const have = threadAt(note, tc.line);

            expect(have).toEqual(tc.want);
        });
    }

    it("reads a CRLF note", () => {
        const have = threadAt(note.replaceAll("\n", "\r\n"), 7);

        expect(have).toEqual({
            id: "C1",
            author: "Jane Doe",
            text: "Which devices?\n\nOnly loggers?",
        });
    });
});

describe("threadOf", () => {
    const note = [
        "Text.",
        "",
        "> [!comment] id:C1 · @Jane Doe · 2026-11-10T09:12:44Z · open",
        "> Which devices?",
        "> > [!comment] id:C2 · @Bob · 2026-11-11T09:00:00Z",
        "> > The T2 ones.",
        "",
        "> [!comment] id:C10 · @Ann · 2026-11-12T08:00:00Z",
        "> Another.",
    ].join("\n");
    const c1 = { id: "C1", author: "Jane Doe", text: "Which devices?" };

    it("finds a thread by its root comment", () => {
        expect(threadOf(note, "C1")).toEqual(c1);
    });

    it("finds a thread by one of its replies", () => {
        expect(threadOf(note, "C2")).toEqual(c1);
    });

    it("matches the whole id, not a prefix", () => {
        expect(threadOf(note, "C10")?.id).toBe("C10");
    });

    it("finds a thread by its second sibling reply", () => {
        const siblings = [
            "> [!comment] id:C1 · @Jane Doe",
            "> Which devices?",
            "> > [!comment] id:C2 · @Bob",
            "> > The T2 ones.",
            ">",
            "> > [!comment] id:C3 · @Ann",
            "> > And T3.",
        ].join("\n");

        expect(threadOf(siblings, "C3")).toEqual(c1);
    });

    it("finds nothing for an unknown id", () => {
        expect(threadOf(note, "C3")).toBeNull();
    });

    it("finds nothing for an id named only in page text", () => {
        expect(threadOf("See [!comment] id:C1 here.", "C1")).toBeNull();
    });
});
