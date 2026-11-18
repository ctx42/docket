// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Comment decoration of the render (Stage 1, read-only): an inline comment adds
// a `[^cf-<markerRef>]` anchor after its annotated run and a `[!comment]` callout
// after the block that carries the marker; a footer comment collects into the
// trailing `## Comments` section. The comment-free path is unchanged — with no
// comments in the render opts the output is byte-identical (covered by the
// existing sourcemap/markdown suites).

import { describe, expect, it } from "vitest";
import { stripCommentDecorations } from "../../../src/adf/render/comments.ts";
import type {
    CommentThread,
    RenderComments,
} from "../../../src/adf/render/markdown.ts";
import { obsidianFlavor } from "../../../src/flavor/obsidian/index.ts";
import { newADF } from "../../../src/models/adf.ts";

/** para builds a one-paragraph comment body (the ADF the callout renders). */
const para = (text: string): CommentThread["body"] => [
    { type: "paragraph", content: [{ type: "text", text }] },
];

/** render runs the Obsidian flavor and returns the body after the frontmatter. */
function body(data: string, comments: RenderComments): string {
    const md = obsidianFlavor.render(newADF(data), {
        assets: {},
        links: null,
        comments,
    })[0];
    return md
        .slice(md.indexOf("\n---\n") + "\n---\n".length)
        .replace(/^\n+/, "")
        .replace(/\n+$/, "");
}

describe("comment decoration", () => {
    // A paragraph whose middle run carries an inlineComment annotation "M1".
    const doc = `{
       "adf": { "type": "doc", "content": [
          { "type": "paragraph", "content": [
             { "type": "text", "text": "The clause " },
             { "type": "text", "text": "needs a source",
               "marks": [ { "type": "annotation",
                 "attrs": { "id": "M1", "annotationType": "inlineComment" } } ] },
             { "type": "text", "text": "." } ] },
          { "type": "paragraph", "content": [
             { "type": "text", "text": "Next paragraph." } ] }
       ] }
    }`;

    it("anchors an inline comment and appends its callout after the block", () => {
        const thread: CommentThread = {
            id: "C1",
            markerRef: "M1",
            resolution: "open",
            authorId: "jsmith",
            authorName: "",
            createdAt: "2026-07-20T10:00:00Z",
            body: para("Where's this from?"),
            replies: [
                {
                    id: "C2",
                    markerRef: "",
                    resolution: "",
                    authorId: "rzajac",
                    authorName: "",
                    createdAt: "2026-07-21T09:00:00Z",
                    body: para("Added in the appendix."),
                    replies: [],
                },
            ],
        };
        const comments: RenderComments = {
            byMarker: new Map([["M1", thread]]),
            trailing: [],
        };

        // The ref is appended after the whole text run (never splitting it), so
        // with the run being the entire paragraph it lands after the period —
        // which also reads as a conventional footnote ref after punctuation.
        expect(body(doc, comments)).toBe(
            [
                "The clause needs a source.[^cf-M1]",
                "",
                "> [!comment] id:C1 · @jsmith · 2026-07-20T10:00:00Z · open",
                "> Where's this from?",
                "> > [!comment] id:C2 · @rzajac · 2026-07-21T09:00:00Z",
                "> > Added in the appendix.",
                "",
                "Next paragraph.",
            ].join("\n"),
        );
    });

    it("collects a footer comment into the trailing section", () => {
        const footer: CommentThread = {
            id: "F1",
            markerRef: "",
            resolution: "",
            authorId: "jsmith",
            authorName: "",
            createdAt: "2026-07-22T08:00:00Z",
            body: para("Page-level note."),
            replies: [],
        };
        const comments: RenderComments = {
            byMarker: new Map(),
            trailing: [footer],
        };

        expect(body(doc, comments)).toBe(
            [
                "The clause needs a source.",
                "",
                "Next paragraph.",
                "",
                "## Comments",
                "",
                "> [!comment] id:F1 · @jsmith · 2026-07-22T08:00:00Z",
                "> Page-level note.",
            ].join("\n"),
        );
    });

    it("separates sibling replies so each stays its own callout", () => {
        /** reply builds a reply by `who` with `replies`. */
        const reply = (
            id: string,
            who: string,
            replies: CommentThread[] = [],
        ): CommentThread => ({
            id,
            markerRef: "",
            resolution: "",
            authorId: who,
            authorName: "",
            createdAt: "",
            body: para(`from ${who}`),
            replies,
        });
        const footer: CommentThread = {
            ...reply("F1", "ann", [
                reply("F2", "bob", [reply("F4", "dan"), reply("F5", "eve")]),
                reply("F3", "cid"),
            ]),
        };
        const comments: RenderComments = {
            byMarker: new Map(),
            trailing: [footer],
        };

        const have = body(doc, comments);

        expect(have.slice(have.indexOf("> [!comment]"))).toBe(
            [
                "> [!comment] id:F1 · @ann",
                "> from ann",
                "> > [!comment] id:F2 · @bob",
                "> > from bob",
                "> > > [!comment] id:F4 · @dan",
                "> > > from dan",
                "> >",
                "> > > [!comment] id:F5 · @eve",
                "> > > from eve",
                ">",
                "> > [!comment] id:F3 · @cid",
                "> > from cid",
            ].join("\n"),
        );
        expect(stripCommentDecorations(have)).toBe(
            body(doc, { byMarker: new Map(), trailing: [] }),
        );
    });

    describe("author", () => {
        /** The callout tag line of a footer thread by `authorId`/`authorName`. */
        const tagLine = (authorId: string, authorName: string): string => {
            const footer: CommentThread = {
                id: "F1",
                markerRef: "",
                resolution: "",
                authorId,
                authorName,
                createdAt: "2026-07-22T08:00:00Z",
                body: para("Note."),
                replies: [],
            };
            const out = body(doc, { byMarker: new Map(), trailing: [footer] });
            return out.split("\n").find((l) => l.includes("[!comment]")) ?? "";
        };

        it("shows the author's name when known", () => {
            expect(tagLine("557058:abc", "Jane Doe")).toBe(
                "> [!comment] id:F1 · @Jane Doe · 2026-07-22T08:00:00Z",
            );
        });

        it("falls back to the account id when the name is unknown", () => {
            expect(tagLine("557058:abc", "")).toBe(
                "> [!comment] id:F1 · @557058:abc · 2026-07-22T08:00:00Z",
            );
        });

        it("keeps a name with line breaks on the tag line", () => {
            expect(tagLine("U1", " Jane\n  Doe \r\n")).toBe(
                "> [!comment] id:F1 · @Jane Doe · 2026-07-22T08:00:00Z",
            );
        });

        it("falls back to the account id for a blank name", () => {
            expect(tagLine("U1", " \n ")).toBe(
                "> [!comment] id:F1 · @U1 · 2026-07-22T08:00:00Z",
            );
        });

        it("omits the author when neither is known", () => {
            expect(tagLine("", "")).toBe(
                "> [!comment] id:F1 · 2026-07-22T08:00:00Z",
            );
        });
    });

    it("strips back to the exact comment-free body, and the strip is a no-op on the ADF", () => {
        // A doc whose fenced code block contains both a blank line and a line
        // that looks like a callout tag — neither must confuse the strip.
        const tricky = `{
           "adf": { "type": "doc", "content": [
              { "type": "paragraph", "content": [
                 { "type": "text", "text": "Before " },
                 { "type": "text", "text": "here",
                   "marks": [ { "type": "annotation",
                     "attrs": { "id": "M1", "annotationType": "inlineComment" } } ] } ] },
              { "type": "codeBlock", "attrs": { "language": "text" },
                "content": [ { "type": "text",
                  "text": "line1\\n\\n> [!comment] not a real callout\\nline2" } ] },
              { "type": "paragraph", "content": [
                 { "type": "text", "text": "After." } ] }
           ] }
        }`;
        const thread: CommentThread = {
            id: "C1",
            markerRef: "M1",
            resolution: "open",
            authorId: "jsmith",
            authorName: "",
            createdAt: "2026-07-20T10:00:00Z",
            body: para("A question."),
            replies: [],
        };
        const footer: CommentThread = {
            id: "F1",
            markerRef: "",
            resolution: "",
            authorId: "jsmith",
            authorName: "",
            createdAt: "2026-07-22T08:00:00Z",
            body: para("Page note."),
            replies: [],
        };
        const comments: RenderComments = {
            byMarker: new Map([["M1", thread]]),
            trailing: [footer],
        };
        const empty: RenderComments = { byMarker: new Map(), trailing: [] };

        const decorated = body(tricky, comments);
        const clean = body(tricky, empty);
        // Sanity: the decoration really did add the anchor, callout, and section.
        expect(decorated).toContain("[^cf-M1]");
        expect(decorated).toContain("[!comment]");
        expect(decorated).toContain("## Comments");

        // The strip recovers the comment-free body exactly — the fenced code
        // block (blank line and callout-looking line included) survives whole.
        expect(stripCommentDecorations(decorated)).toBe(clean);

        // And feeding the stripped body back through reconstruct is a no-op: the
        // ADF is identical to the cached baseline, so a push would PUT nothing.
        const base = newADF(tricky);
        const rebuilt = obsidianFlavor.reconstruct(
            base,
            stripCommentDecorations(decorated),
            { mentions: null, assets: null, images: null, links: null },
        );
        expect(JSON.stringify(rebuilt.doc)).toBe(JSON.stringify(base.doc));
    });

    it("strips reply drafts, in the body and under the trailing heading", () => {
        const page = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph",
             "content": [ { "type": "text", "text": "Body." } ] } ] } }`;
        const note = [
            "Body.",
            "",
            "> [!comment] id:C1 · @ann",
            "> Q?",
            "",
            "> [!reply] draft",
            "> A.",
            "",
            "## Comments",
            "",
            "> [!comment] id:F1 · @bob",
            "> Page note.",
            "",
            "> [!reply] draft · thread id:F1 is resolved on Confluence",
            "> Later.",
        ].join("\n");

        const have = stripCommentDecorations(note);

        expect(have).toBe(body(page, { byMarker: new Map(), trailing: [] }));
    });

    it("keeps a page's own Comments heading", () => {
        const page = `{ "adf": { "type": "doc", "content": [
           { "type": "heading", "attrs": { "level": 2 },
             "content": [ { "type": "text", "text": "Comments" } ] },
           { "type": "paragraph",
             "content": [ { "type": "text", "text": "Type and send." } ] } ] } }`;
        const footer: CommentThread = {
            id: "F1",
            markerRef: "",
            resolution: "",
            authorId: "jsmith",
            authorName: "",
            createdAt: "2026-07-22T08:00:00Z",
            body: para("Page note."),
            replies: [],
        };
        const comments: RenderComments = {
            byMarker: new Map(),
            trailing: [footer],
        };
        const decorated = body(page, comments);
        const want = body(page, { byMarker: new Map(), trailing: [] });

        const have = stripCommentDecorations(decorated);

        expect(have).toBe(want);
    });

    it("drops an inline comment whose marker is absent from the body (dangling)", () => {
        // Its highlighted text was deleted, so Confluence no longer shows it on the
        // page; the render matches CF and omits it rather than surfacing it in a
        // trailing section.
        const orphan: CommentThread = {
            id: "C9",
            markerRef: "GONE",
            resolution: "dangling",
            authorId: "jsmith",
            authorName: "",
            createdAt: "2026-07-23T08:00:00Z",
            body: para("Anchor text was edited away."),
            replies: [],
        };
        const comments: RenderComments = {
            byMarker: new Map([["GONE", orphan]]),
            trailing: [],
        };

        const out = body(doc, comments);
        expect(out).not.toContain("[^cf-");
        expect(out).not.toContain("## Comments");
        expect(out).not.toContain("[!comment]");
        expect(out).not.toContain("dangling");
    });
});

describe("comment decoration on standalone inline nodes", () => {
    const thread: CommentThread = {
        id: "C1",
        markerRef: "M1",
        resolution: "open",
        authorId: "jsmith",
        authorName: "",
        createdAt: "2026-07-20T10:00:00Z",
        body: para("Check the link."),
        replies: [],
    };
    const comments: RenderComments = {
        byMarker: new Map([["M1", thread]]),
        trailing: [],
    };
    const annotation = `{ "type": "annotation",
        "attrs": { "id": "M1", "annotationType": "inlineComment" } }`;
    const link = (text: string): string => `{ "type": "text", "text": "${text}",
        "marks": [ ${annotation}, { "type": "underline" },
          { "type": "link", "attrs": { "href": "http://ex.com/" } } ] }`;

    it("anchors a comment on link text", () => {
        const doc = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "content": [
              { "type": "text", "text": "Visit " }, ${link("ex.com")} ] } ] } }`;

        const have = body(doc, comments);

        expect(have.split("\n")[0]).toBe(
            "Visit [<u>ex.com</u>](http://ex.com/)[^cf-M1]",
        );
        // The anchor is decoration only: stripping it restores the plain render.
        expect(stripCommentDecorations(have)).toBe(
            body(doc, { byMarker: new Map(), trailing: [] }),
        );
    });

    it("anchors a comment spanning two links once", () => {
        const doc = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "content": [
              ${link("a")}, { "type": "text", "text": " " }, ${link("b")} ] } ] } }`;

        const have = body(doc, comments);

        expect(have.match(/\[\^cf-M1\]/g)).toHaveLength(1);
    });
});
