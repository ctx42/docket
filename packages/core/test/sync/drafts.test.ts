// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Reply drafts: `> [!reply] draft` blocks a user keeps in a note under a
// comment thread until a push sends them. Read, checked, re-placed after a
// pull, and written by the reply dialog.

import { describe, expect, it } from "vitest";
import type { PageComment } from "../../src/confluence/client.ts";
import {
    checkDrafts,
    draftBlock,
    draftOf,
    placeDrafts,
    readDrafts,
    removeDraft,
    replyLabel,
    threadGone,
    upsertDraft,
} from "../../src/sync/drafts.ts";

/** md joins lines into a body. */
const md = (...lines: string[]): string => lines.join("\n");

const THREAD = md(
    "> [!comment] id:C1 · @Jane Doe · 2026-11-10T09:12:44Z · open",
    "> Which devices?",
);
const OTHER = md("> [!comment] id:C2 · @Bob · 2026-11-11T09:00:00Z · open");

describe("draftBlock", () => {
    it("quotes every line, a blank one as a bare marker", () => {
        expect(draftBlock("Only T2.\n\nSee the list.")).toBe(
            md("> [!reply] draft", "> Only T2.", ">", "> See the list."),
        );
    });

    it("adds a mark to the tag line", () => {
        expect(draftBlock("x", "thread id:C1 is gone")).toBe(
            md("> [!reply] draft · thread id:C1 is gone", "> x"),
        );
    });
});

describe("readDrafts", () => {
    it("reads a draft under its thread", () => {
        const body = md(
            "Text.[^cf-M1]",
            "",
            THREAD,
            "",
            "> [!reply] draft",
            "> Only T2.",
            "",
            "After.",
        );

        const have = readDrafts(body);

        expect(have).toEqual([
            {
                key: "C1#1",
                threadId: "C1",
                text: "Only T2.",
                line: 6,
                block: md("> [!reply] draft", "> Only T2."),
                mark: "",
                anchor: "Text.[^cf-M1]",
            },
        ]);
    });

    it("numbers the drafts of one thread in order", () => {
        const body = md(
            "Text.",
            "",
            THREAD,
            "",
            draftBlock("one"),
            "",
            draftBlock("two"),
        );

        const have = readDrafts(body);

        expect(have.map((d) => [d.key, d.threadId, d.text])).toEqual([
            ["C1#1", "C1", "one"],
            ["C1#2", "C1", "two"],
        ]);
    });

    it("keeps a multi-paragraph draft's blank line", () => {
        const body = md(THREAD, "", draftBlock("a\n\nb"));

        expect(readDrafts(body)[0]?.text).toBe("a\n\nb");
    });

    it("takes the thread from a marked draft's tag", () => {
        const body = md(
            "Text.",
            "",
            draftBlock("kept", "thread id:C9 is resolved on Confluence"),
        );

        const have = readDrafts(body)[0];

        expect(have?.threadId).toBe("C9");
        expect(have?.key).toBe("C9#1");
        expect(have?.mark).toBe("thread id:C9 is resolved on Confluence");
    });

    it("reads a draft with no thread before it", () => {
        const body = md("Text.", "", draftBlock("lost"));

        expect(readDrafts(body)[0]?.threadId).toBe("");
    });

    it("reads nothing from a note without drafts", () => {
        expect(readDrafts(md("Text.", "", THREAD))).toEqual([]);
    });
});

describe("checkDrafts", () => {
    it("accepts drafts under threads and marked drafts", () => {
        const body = md(
            "Text.",
            "",
            THREAD,
            "",
            draftBlock("ok"),
            "",
            draftBlock("kept", "thread id:C9 is resolved on Confluence"),
        );

        expect(() => checkDrafts(body)).not.toThrow();
    });

    const refusals: Array<{ name: string; body: string; want: string }> = [
        {
            name: "a draft with no thread",
            body: md("Text.", "", draftBlock("x")),
            want: "reply draft at line 3 is not under a comment",
        },
        {
            name: "an empty draft",
            body: md(THREAD, "", "> [!reply] draft", ">"),
            want: "reply draft at line 4 is empty",
        },
        {
            name: "a draft inside the comment callout",
            body: md(THREAD, "> [!reply] draft", "> x"),
            want:
                "reply draft at line 3 is inside a comment callout; " +
                "put a blank line before it",
        },
        {
            name: "a comment callout without an id",
            body: md("Text.", "", "> [!comment]", "> hi"),
            want: "comment callout at line 3 has no id",
        },
        {
            name: "a reply callout typed inside a thread",
            body: md(THREAD, "> > [!comment]", "> > my answer"),
            want: "comment callout at line 3 has no id",
        },
    ];
    for (const tc of refusals) {
        it(`refuses ${tc.name}`, () => {
            expect(() => checkDrafts(tc.body)).toThrow(tc.want);
        });
    }

    it("counts lines from the given first line", () => {
        const body = md("Text.", "", draftBlock("x"));

        expect(() => checkDrafts(body, 5)).toThrow("at line 7");
    });
});

describe("placeDrafts", () => {
    const gone = (): string => "";

    it("leaves a body alone when there are no drafts", () => {
        const body = md("Text.", "", THREAD);

        expect(placeDrafts(body, [], gone)).toBe(body);
    });

    it("puts a draft right after its thread", () => {
        const local = md("Text.", "", THREAD, "", draftBlock("mine"));
        const fresh = md("Text v2.", "", THREAD, "", OTHER, "", "After.");

        const have = placeDrafts(fresh, readDrafts(local), gone);

        expect(have).toBe(
            md(
                "Text v2.",
                "",
                THREAD,
                "",
                draftBlock("mine"),
                "",
                OTHER,
                "",
                "After.",
            ),
        );
    });

    it("keeps the order of a thread's drafts", () => {
        const local = md(THREAD, "", draftBlock("one"), "", draftBlock("two"));

        const have = placeDrafts(
            md("Text.", "", THREAD),
            readDrafts(local),
            gone,
        );

        expect(have).toBe(
            md(
                "Text.",
                "",
                THREAD,
                "",
                draftBlock("one"),
                "",
                draftBlock("two"),
            ),
        );
    });

    it("keeps a draft whose thread is gone at its place, marked", () => {
        const local = md("Text.", "", THREAD, "", draftBlock("mine"), "", "B.");
        const fresh = md("Text.", "", OTHER, "", "B.");

        const have = placeDrafts(fresh, readDrafts(local), (id) =>
            id === "C1" ? "is resolved on Confluence" : "",
        );

        expect(have).toBe(
            md(
                "Text.",
                "",
                OTHER,
                "",
                draftBlock("mine", "thread id:C1 is resolved on Confluence"),
                "",
                "B.",
            ),
        );
    });

    it("keeps an unknown thread's draft unmarked", () => {
        const local = md("Text.", "", THREAD, "", draftBlock("mine"));

        const have = placeDrafts(md("Text."), readDrafts(local), gone);

        expect(have).toBe(md("Text.", "", draftBlock("mine")));
    });

    it("clears the mark once the thread is back", () => {
        const local = md(
            "Text.",
            "",
            draftBlock("mine", "thread id:C1 is resolved on Confluence"),
        );

        const have = placeDrafts(
            md("Text.", "", THREAD),
            readDrafts(local),
            gone,
        );

        expect(have).toBe(md("Text.", "", THREAD, "", draftBlock("mine")));
    });

    it("appends a draft whose place is gone", () => {
        const local = md("Old.", "", THREAD, "", draftBlock("mine"));

        const have = placeDrafts(md("New."), readDrafts(local), gone);

        expect(have).toBe(md("New.", "", draftBlock("mine")));
    });
});

describe("note drafts", () => {
    const FM = md("---", 'docket_page_id: "1"', "---", "");
    const note = (...lines: string[]): string => `${FM}\n${md(...lines)}\n`;

    it("finds no draft for a thread without one", () => {
        expect(draftOf(note("Text.", "", THREAD), "C1")).toBeNull();
    });

    it("finds a thread's last draft", () => {
        const text = note(
            THREAD,
            "",
            draftBlock("one"),
            "",
            draftBlock("two\n\nlines"),
        );

        expect(draftOf(text, "C1")).toBe("two\n\nlines");
    });

    it("inserts a first draft right after the thread", () => {
        const text = note("Text.", "", THREAD, "", "After.");

        const have = upsertDraft(text, "C1", "mine");

        expect(have).toBe(
            note("Text.", "", THREAD, "", draftBlock("mine"), "", "After."),
        );
    });

    it("inserts a draft after a thread at the end of the note", () => {
        const text = `${FM}\n${THREAD}`;

        const have = upsertDraft(text, "C1", "mine");

        expect(have).toBe(`${FM}\n${THREAD}\n\n${draftBlock("mine")}`);
    });

    it("rewrites the thread's last draft", () => {
        const text = note(
            THREAD,
            "",
            draftBlock("one"),
            "",
            draftBlock("two"),
            "",
            "After.",
        );

        const have = upsertDraft(text, "C1", "new\ntext");

        expect(have).toBe(
            note(
                THREAD,
                "",
                draftBlock("one"),
                "",
                draftBlock("new\ntext"),
                "",
                "After.",
            ),
        );
    });

    it("refuses a thread the note does not show", () => {
        expect(() => upsertDraft(note("Text."), "C1", "x")).toThrow(
            "comment id:C1 is not in the note; pull it",
        );
    });

    it("removes the thread's last draft", () => {
        const text = note(THREAD, "", draftBlock("mine"), "", "After.");

        const have = removeDraft(text, "C1");

        expect(have).toBe(note(THREAD, "", "After."));
    });

    it("removes nothing from a thread without a draft", () => {
        const text = note(THREAD, "", "After.");

        expect(removeDraft(text, "C1")).toBe(text);
    });
});

describe("threadGone", () => {
    /** root is a live thread root `id` in `resolution`. */
    const root = (id: string, resolution: string): PageComment => ({
        id,
        kind: "inline",
        resolution,
        markerRef: "",
        anchorText: "",
        authorId: "",
        authorName: "",
        createdAt: "",
        version: 1,
        adf: "",
        replies: [],
    });
    const live = {
        inline: [root("C1", "resolved"), root("C2", "open")],
        footer: [root("F1", "")],
    };

    it.each([
        ["a resolved thread", "C1", "is resolved on Confluence"],
        [
            "an open thread the page no longer shows",
            "C2",
            "is no longer shown on the page",
        ],
        [
            "a footer thread the page no longer shows",
            "F1",
            "is no longer shown on the page",
        ],
        ["a deleted thread", "C9", "is no longer on Confluence"],
    ])("explains %s", (_name, id, want) => {
        expect(threadGone(live, id)).toBe(want);
    });

    it("explains nothing without the live comments", () => {
        expect(threadGone(undefined, "C1")).toBe("");
    });
});

describe("replyLabel", () => {
    it.each([
        [
            "a reply to a named author",
            { key: "C1#1", to: "Jane Doe", text: "Only T2.\nMore.", mark: "" },
            'Reply to Jane Doe: "Only T2."',
        ],
        [
            "a reply with no author",
            { key: "C1#1", to: "", text: "Only T2.", mark: "" },
            'Reply: "Only T2."',
        ],
        [
            "a long first line",
            { key: "C1#1", to: "Bob", text: "x".repeat(70), mark: "" },
            `Reply to Bob: "${"x".repeat(60)}…"`,
        ],
        [
            "a reply that cannot go",
            {
                key: "C1#1",
                to: "",
                text: "Late.",
                mark: "thread id:C1 is resolved on Confluence",
            },
            'Cannot send reply "Late.": thread id:C1 is resolved on Confluence',
        ],
    ])("words %s", (_name, reply, want) => {
        expect(replyLabel(reply)).toBe(want);
    });
});
