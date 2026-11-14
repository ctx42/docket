// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The lens-law property test for `validatePut` (M4.4). `validatePut` itself is
// ported in reconstruct.ts and runs on every `put`; these cases state its two
// guarantees directly rather than only implicitly through the insert/edit tables:
//
//   GetPut — pushing an unchanged body back yields a byte-identical document, for
//            a document mixing every node kind at once.
//   PutGet — a representable edit round-trips: the rebuilt block re-renders to the
//            user's edit (soft-wrap differences do not count).
//
// and its refusal contract: an edit the Markdown cannot express losslessly — a
// frozen block, or a structural change to a container — is rejected with a named
// reason, never silently pushed.

import { describe, expect, it } from "vitest";
import { put, putLinks } from "../../../src/adf/lens/reconstruct.ts";
import { marshallMarkdownMapped } from "../../../src/index.ts";
import { type ADF, newADF } from "../../../src/models/adf.ts";

/** renderBody renders adf and returns its body without frontmatter or trailing newline. */
function renderBody(adf: ADF): string {
    const [md, sm] = marshallMarkdownMapped(adf, {});
    return md.slice(sm.bodyStart).replace(/\n$/, "");
}

const json = (adf: ADF): string => JSON.stringify(adf);

// mixed is one document holding every top-level node kind the lens handles, so a
// single no-op push exercises GetPut across all of them at once.
const mixed = `{ "adf": { "type": "doc", "content": [
   { "type": "heading", "attrs": { "level": 2, "localId": "h" },
     "content": [ { "type": "text", "text": "Title" } ] },
   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
      { "type": "text", "text": "plain " },
      { "type": "text", "text": "bold", "marks": [ { "type": "strong" } ] } ] },
   { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
      { "type": "listItem", "content": [ { "type": "paragraph",
        "content": [ { "type": "text", "text": "item" } ] } ] } ] },
   { "type": "codeBlock", "attrs": { "localId": "cb", "language": "go" },
     "content": [ { "type": "text", "text": "x := 1" } ] },
   { "type": "panel", "attrs": { "panelType": "info", "localId": "pn" },
     "content": [ { "type": "paragraph",
       "content": [ { "type": "text", "text": "note" } ] } ] },
   { "type": "table", "attrs": { "localId": "t" }, "content": [
      { "type": "tableRow", "content": [
         { "type": "tableCell", "content": [ { "type": "paragraph",
           "content": [ { "type": "text", "text": "A" } ] } ] },
         { "type": "tableCell", "content": [ { "type": "paragraph",
           "content": [ { "type": "text", "text": "B" } ] } ] } ] } ] } ] } }`;

describe("validatePut GetPut law", () => {
    it("a mixed document pushes back byte-identically", () => {
        const base = newADF(mixed);
        const out = put(base, renderBody(base), null, null, null);
        expect(json(out)).toBe(json(base));
    });
});

describe("validatePut PutGet law", () => {
    // Each edit changes exactly one block of `mixed`; the rebuilt block must
    // re-render to the edited body.
    const edits: Array<{ name: string; from: string; to: string }> = [
        { name: "heading text", from: "## Title", to: "## Renamed" },
        {
            name: "paragraph text",
            from: "plain **bold**",
            to: "plainer **bold**",
        },
        { name: "list item text", from: "- item", to: "- edited item" },
        { name: "code block body", from: "x := 1", to: "x := 2" },
        {
            name: "panel body text",
            from: "> [!INFO]\n> note",
            to: "> [!INFO]\n> revised note",
        },
        // A width-preserving cell edit keeps the column layout, so the exact
        // render matches; a widening edit is still valid but only normalize-equal.
        { name: "table cell text", from: "| A ", to: "| X " },
    ];

    for (const e of edits) {
        it(`round-trips an edited ${e.name}`, () => {
            const base = newADF(mixed);
            const body = renderBody(base).replace(e.from, e.to);
            expect(body).not.toBe(renderBody(base)); // the edit took effect
            const out = put(base, body, null, null, null);
            // PutGet: the pushed document re-renders to exactly the edited body.
            expect(renderBody(out)).toBe(body);
        });
    }
});

describe("validatePut refusal contract", () => {
    // A lossy edit is refused with a named reason, never guessed.
    const rejects: Array<{
        name: string;
        from: string;
        to: string;
        want: string;
    }> = [
        {
            // `mixed`'s table has no header row, so it renders under a blank
            // synthetic header. Widening only the data row leaves that header at
            // its old width, so the rebuilt 3-column table no longer re-renders to
            // the edited body: PutGet refuses the inconsistent edit. (A consistent
            // column add — every row widened — is supported; see reconstruct.test.)
            name: "widening only one row of a table",
            from: "| A | B |",
            to: "| A | B | C |",
            want: "did not round-trip",
        },
    ];

    for (const r of rejects) {
        it(`refuses ${r.name} with a named reason`, () => {
            const base = newADF(mixed);
            const body = renderBody(base).replace(r.from, r.to);
            expect(() => put(base, body, null, null, null)).toThrow(r.want);
        });
    }
});

describe("validatePut refusal message", () => {
    // A paragraph, then a key/value table: a header row and one row whose first
    // cell is a tableHeader (rendered **ab**). Body lines: 1 intro, 3 header,
    // 4 separator, 5 the ab row.
    const keyValue = `{ "adf": { "type": "doc", "content": [
       { "type": "paragraph", "content": [ { "type": "text", "text": "intro" } ] },
       { "type": "table", "attrs": { "localId": "t" }, "content": [
          { "type": "tableRow", "content": [
             { "type": "tableHeader", "content": [ { "type": "paragraph",
               "content": [ { "type": "text", "text": "K" } ] } ] },
             { "type": "tableHeader", "content": [ { "type": "paragraph",
               "content": [ { "type": "text", "text": "V" } ] } ] } ] },
          { "type": "tableRow", "content": [
             { "type": "tableHeader", "content": [ { "type": "paragraph",
               "content": [ { "type": "text", "text": "ab" } ] } ] },
             { "type": "tableCell", "content": [ { "type": "paragraph",
               "content": [ { "type": "text", "text": "v1" } ] } ] } ] } ] } ] } }`;

    it("names the file line and quotes the line that does not round-trip", () => {
        const base = newADF(keyValue);
        const body = renderBody(base).replace("**ab**", "**a** **b**");

        let have = "";
        try {
            putLinks(base, body, null, null, null, null, false, 10);
        } catch (err) {
            have = (err as Error).message;
        }

        expect(have).toMatch(/^push: block 1 did not round-trip/);
        expect(have).toContain('"| **a** **b** | v1 |" would push as "');
        expect(have).toMatch(/\(line 14\)$/);
    });

    it("quotes a long line shortened", () => {
        const base = newADF(keyValue);
        const long = `**a** **${"b".repeat(100)}**`;
        const body = renderBody(base).replace("**ab**", long);

        let have = "";
        try {
            putLinks(base, body, null, null, null, null, false, 1);
        } catch (err) {
            have = (err as Error).message;
        }

        expect(have).toContain(`"| **a** **${"b".repeat(50)}…" would push as`);
        expect(have).toMatch(/\(line 5\)$/);
    });

    // A blockquote of two paragraphs. Under force, a block that cannot be
    // re-derived is kept verbatim, so dropping its second paragraph leaves the
    // push with more lines than the edit: the lines cannot pair up.
    const twoParaQuote = (first: string): string => `{ "adf": { "type": "doc",
       "content": [ { "type": "blockquote", "content": [
          { "type": "paragraph", "content": [ { "type": "text", "text": "${first}" } ] },
          { "type": "paragraph", "content": [ { "type": "text", "text": "two" } ] }
       ] } ] } }`;

    it("quotes whole blocks when the lines do not pair up", () => {
        const base = newADF(twoParaQuote("one"));
        const body = renderBody(base).replace("\n>\n> two", "");

        let have = "";
        try {
            putLinks(base, body, null, null, null, null, true, 3);
        } catch (err) {
            have = (err as Error).message;
        }

        expect(have).toContain(
            '"> one" would push as "> one > > two" (line 3)',
        );
    });

    it("quotes from just before the difference in a long block", () => {
        const base = newADF(twoParaQuote("a".repeat(100)));
        const body = renderBody(base).replace("\n>\n> two", "");

        let have = "";
        try {
            putLinks(base, body, null, null, null, null, true, 1);
        } catch (err) {
            have = (err as Error).message;
        }

        const tail = "a".repeat(20);
        expect(have).toContain(
            `"…${tail}" would push as "…${tail} > > two" (line 1)`,
        );
    });
});
