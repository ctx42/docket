// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/adf/markdown_test.go: the inline-render cases
// (Test_renderTextRun_tabular). Go exercises renderText only through the block
// renderers (paragraphs, M2.3); the two renderText cases here cover its own
// paths — mark nesting under a link wrapper, and the literal code-span branch.

import { describe, expect, it } from "vitest";
import {
    cellText,
    hoistDocEdgeSpaces,
    inlineString,
    renderBlock,
    renderText,
    renderTextRun,
} from "../../../src/adf/render/markdown.ts";
import type { Node } from "../../../src/models/adf.ts";

describe("renderTextRun", () => {
    const strike = { type: "strike" };
    const strong = { type: "strong" };

    const tt: Array<{ testN: string; run: Node[]; want: string }> = [
        {
            testN: "shared mark hoisted across the boundary",
            run: [
                { type: "text", text: "SC-9:", marks: [strike, strong] },
                { type: "text", text: " Track it.", marks: [strike] },
            ],
            want: "~~**SC-9:** Track it.~~",
        },
        {
            testN: "adjacent equal marks merge without an empty run",
            run: [
                { type: "text", text: "a", marks: [strong] },
                { type: "text", text: "b", marks: [strong] },
            ],
            want: "**ab**",
        },
        {
            testN: "a mark on one node only wraps that node",
            run: [
                { type: "text", text: "a", marks: [strong] },
                { type: "text", text: "b" },
            ],
            want: "**a**b",
        },
        {
            testN: "plain nodes concatenate",
            run: [
                { type: "text", text: "a" },
                { type: "text", text: "b" },
            ],
            want: "ab",
        },
        {
            testN: "underline wraps in an HTML tag pair",
            run: [{ type: "text", text: "u", marks: [{ type: "underline" }] }],
            want: "<u>u</u>",
        },
        {
            testN: "textColor carries its color in a span",
            run: [
                {
                    type: "text",
                    text: "red",
                    marks: [{ type: "textColor", attrs: { color: "#ff0000" } }],
                },
            ],
            want: `<span style="color:#ff0000">red</span>`,
        },
        {
            testN: "same-color span merges across the boundary",
            run: [
                {
                    type: "text",
                    text: "a",
                    marks: [{ type: "textColor", attrs: { color: "#0a0" } }],
                },
                {
                    type: "text",
                    text: "b",
                    marks: [{ type: "textColor", attrs: { color: "#0a0" } }],
                },
            ],
            want: `<span style="color:#0a0">ab</span>`,
        },
    ];

    for (const tc of tt) {
        it(tc.testN, () => {
            expect(renderTextRun(tc.run)).toBe(tc.want);
        });
    }
});

describe("renderText", () => {
    it("nests marks inside a link wrapper", () => {
        const nod: Node = {
            type: "text",
            text: "hi",
            marks: [
                { type: "strong" },
                { type: "link", attrs: { href: "http://x" } },
            ],
        };

        expect(renderText(nod, {})).toBe("[**hi**](http://x)");
    });

    it("renders a code-marked node as a literal backtick span", () => {
        const nod: Node = {
            type: "text",
            text: "a*b",
            marks: [{ type: "code" }],
        };

        // The code span is literal: its "*" is not escaped.
        expect(renderText(nod, {})).toBe("`a*b`");
    });

    it("widens the fence for a backtick in the content", () => {
        const nod: Node = {
            type: "text",
            text: "a`b",
            marks: [{ type: "code" }],
        };
        expect(renderText(nod, {})).toBe("``a`b``");
    });

    it("pads a space when the content edge is a backtick", () => {
        const nod: Node = {
            type: "text",
            text: "`x`",
            marks: [{ type: "code" }],
        };
        expect(renderText(nod, {})).toBe("`` `x` ``");
    });

    it("escapes a bracket in a link label", () => {
        const nod: Node = {
            type: "text",
            text: "see [1]",
            marks: [{ type: "link", attrs: { href: "x.md" } }],
        };
        expect(renderText(nod, {})).toBe(String.raw`[see \[1\]](x.md)`);
    });

    it("wraps a link destination with a space in angle brackets", () => {
        const nod: Node = {
            type: "text",
            text: "d",
            marks: [{ type: "link", attrs: { href: "my file.md" } }],
        };
        expect(renderText(nod, {})).toBe("[d](<my file.md>)");
    });
});

describe("link runs", () => {
    const link = { type: "link", attrs: { href: "http://x/g#LTD" } };
    const note = {
        type: "annotation",
        attrs: { annotationType: "inlineComment", id: "c1" },
    };

    it.each<[string, Node[], string]>([
        [
            "a link split by an annotation renders once",
            [
                {
                    type: "text",
                    text: "Latest Transmission",
                    marks: [note, link],
                },
                { type: "text", text: " Date", marks: [link] },
            ],
            "[Latest Transmission Date](http://x/g#LTD)",
        ],
        [
            "formatting shared across the split stays open",
            [
                {
                    type: "text",
                    text: "a ",
                    marks: [note, link, { type: "em" }],
                },
                { type: "text", text: "b", marks: [link, { type: "em" }] },
            ],
            "[*a b*](http://x/g#LTD)",
        ],
        [
            "adjacent links to different targets stay apart",
            [
                { type: "text", text: "a", marks: [link] },
                {
                    type: "text",
                    text: "b",
                    marks: [{ type: "link", attrs: { href: "http://y" } }],
                },
            ],
            "[a](http://x/g#LTD)[b](http://y)",
        ],
        [
            "a link label keeps its brackets escaped",
            [
                { type: "text", text: "[a]", marks: [note, link] },
                { type: "text", text: " b", marks: [link] },
            ],
            "[\\[a\\] b](http://x/g#LTD)",
        ],
    ])("%s", (_name, content, want) => {
        // --- When ---
        const have = inlineString({ type: "paragraph", content }, {});

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("hoistEdgeSpaces", () => {
    const strong = { type: "strong" };
    const em = { type: "em" };
    const strike = { type: "strike" };
    const underline = { type: "underline" };
    const link = { type: "link", attrs: { href: "http://x" } };

    const tt: Array<{ testN: string; content: Node[]; want: string }> = [
        {
            testN: "a trailing space moves after the closing delimiter",
            content: [
                { type: "text", text: "UI-1: ", marks: [strong] },
                { type: "text", text: "The system" },
            ],
            want: "**UI-1:** The system",
        },
        {
            testN: "a leading space moves before the opening delimiter",
            content: [
                { type: "text", text: "see" },
                { type: "text", text: " UI-1:", marks: [strong] },
            ],
            want: "see **UI-1:**",
        },
        {
            testN: "em edge whitespace is hoisted",
            content: [
                { type: "text", text: "x ", marks: [em] },
                { type: "text", text: "y" },
            ],
            want: "*x* y",
        },
        {
            testN: "strike edge whitespace is hoisted",
            content: [
                { type: "text", text: "x ", marks: [strike] },
                { type: "text", text: "y" },
            ],
            want: "~~x~~ y",
        },
        {
            testN: "a span over several nodes keeps its interior whitespace",
            content: [
                { type: "text", text: "a", marks: [strong] },
                { type: "text", text: " b ", marks: [strong] },
                { type: "text", text: "c" },
            ],
            want: "**a b** c",
        },
        {
            testN: "a whitespace-only span renders as plain whitespace",
            content: [
                { type: "text", text: "a" },
                { type: "text", text: " ", marks: [strong] },
                { type: "text", text: "b" },
            ],
            want: "a b",
        },
        {
            testN: "an HTML-tag mark keeps the whitespace",
            content: [
                { type: "text", text: "a ", marks: [underline, strong] },
                { type: "text", text: "b" },
            ],
            want: "<u>**a** </u>b",
        },
        {
            testN: "a linked node keeps its link on the whitespace",
            content: [
                { type: "text", text: "a ", marks: [link, strong] },
                { type: "text", text: "b" },
            ],
            want: "[**a** ](http://x)b",
        },
    ];

    for (const tc of tt) {
        it(tc.testN, () => {
            const have = inlineString(
                { type: "paragraph", content: tc.content },
                {},
            );

            expect(have).toBe(tc.want);
        });
    }
});

describe("hoistDocEdgeSpaces", () => {
    it("splits edge whitespace off flanked marks throughout the tree", () => {
        const comment = {
            type: "annotation",
            attrs: { id: "c1", annotationType: "inlineComment" },
        };
        const doc: Node = {
            type: "doc",
            content: [
                {
                    type: "table",
                    content: [
                        {
                            type: "tableRow",
                            content: [
                                {
                                    type: "tableCell",
                                    content: [
                                        {
                                            type: "paragraph",
                                            content: [
                                                {
                                                    type: "text",
                                                    text: "UI-1: ",
                                                    marks: [
                                                        { type: "strong" },
                                                        comment,
                                                    ],
                                                },
                                                {
                                                    type: "text",
                                                    text: "The system",
                                                },
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        };

        const have = hoistDocEdgeSpaces(doc);

        expect(have).toBe(true);
        const para = doc.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0];
        expect(para?.content).toEqual([
            {
                type: "text",
                text: "UI-1:",
                marks: [{ type: "strong" }, comment],
            },
            { type: "text", text: " ", marks: [comment] },
            { type: "text", text: "The system" },
        ]);
    });

    it("leaves clean ADF and code-marked text untouched", () => {
        const doc: Node = {
            type: "doc",
            content: [
                {
                    type: "paragraph",
                    content: [
                        {
                            type: "text",
                            text: " x ",
                            marks: [{ type: "code" }],
                        },
                        {
                            type: "text",
                            text: "a",
                            marks: [{ type: "strong" }],
                        },
                        { type: "text", text: " b" },
                    ],
                },
            ],
        };
        const want = structuredClone(doc);

        const have = hoistDocEdgeSpaces(doc);

        expect(have).toBe(false);
        expect(doc).toEqual(want);
    });

    it("merges a hoisted space into the space next to it", () => {
        const doc: Node = {
            type: "doc",
            content: [
                {
                    type: "paragraph",
                    content: [
                        {
                            type: "text",
                            text: "UI-1: ",
                            marks: [{ type: "strong" }],
                        },
                        { type: "text", text: " bar" },
                    ],
                },
            ],
        };

        const have = hoistDocEdgeSpaces(doc);

        expect(have).toBe(true);
        expect(doc.content?.[0]?.content).toEqual([
            { type: "text", text: "UI-1:", marks: [{ type: "strong" }] },
            { type: "text", text: " bar" },
        ]);
    });
});

describe("stray spaces", () => {
    const strong = { type: "strong" };
    const em = { type: "em" };

    const tt: Array<{ testN: string; nod: Node; want: string }> = [
        {
            testN: "a paragraph drops its trailing space",
            nod: {
                type: "paragraph",
                content: [{ type: "text", text: "foo " }],
            },
            want: "foo",
        },
        {
            testN: "a hard-break segment drops its trailing space",
            nod: {
                type: "paragraph",
                content: [
                    { type: "text", text: "foo " },
                    { type: "hardBreak" },
                    { type: "text", text: "bar" },
                ],
            },
            want: "foo\\\nbar",
        },
        {
            testN: "a hoisted space merges with the next one",
            nod: {
                type: "paragraph",
                content: [
                    { type: "text", text: "UI-1: ", marks: [strong] },
                    { type: "text", text: " bar" },
                ],
            },
            want: "**UI-1:** bar",
        },
        {
            testN: "a hoisted leading space merges with the one before",
            nod: {
                type: "paragraph",
                content: [
                    { type: "text", text: "foo " },
                    { type: "text", text: " bar", marks: [em] },
                ],
            },
            want: "foo *bar*",
        },
        {
            testN: "a whitespace-only span next to a space vanishes",
            nod: {
                type: "paragraph",
                content: [
                    { type: "text", text: "a " },
                    { type: "text", text: " ", marks: [strong] },
                    { type: "text", text: "b" },
                ],
            },
            want: "a b",
        },
        {
            testN: "a heading drops its trailing spaces",
            nod: {
                type: "heading",
                attrs: { level: 2 },
                content: [{ type: "text", text: "Glossary  " }],
            },
            want: "## Glossary",
        },
        {
            testN: "a heading drops its leading spaces",
            nod: {
                type: "heading",
                attrs: { level: 2 },
                content: [{ type: "text", text: "  Glossary" }],
            },
            want: "## Glossary",
        },
        {
            testN: "a space hoisted out of a closing bold is dropped",
            nod: {
                type: "paragraph",
                content: [
                    { type: "text", text: "see " },
                    { type: "text", text: "this ", marks: [strong] },
                ],
            },
            want: "see **this**",
        },
        {
            testN: "a segment after a hard break drops its leading space",
            nod: {
                type: "paragraph",
                content: [
                    { type: "text", text: "foo" },
                    { type: "hardBreak" },
                    { type: "text", text: " bar" },
                ],
            },
            want: "foo\\\nbar",
        },
        {
            testN: "a code span keeps its edge spaces",
            nod: {
                type: "paragraph",
                content: [
                    { type: "text", text: "run " },
                    { type: "text", text: " x ", marks: [{ type: "code" }] },
                ],
            },
            want: "run `  x  `",
        },
        {
            testN: "a non-breaking space at the end is content",
            nod: {
                type: "paragraph",
                content: [{ type: "text", text: "foo " }],
            },
            want: "foo ",
        },
    ];

    for (const tc of tt) {
        it(tc.testN, () => {
            const have = renderBlock(tc.nod, {});

            expect(have).toBe(tc.want);
        });
    }

    it("a table cell drops the trailing space of each line", () => {
        const cell: Node = {
            type: "tableCell",
            content: [
                {
                    type: "paragraph",
                    content: [
                        { type: "text", text: "foo " },
                        { type: "hardBreak" },
                        { type: "text", text: "bar " },
                    ],
                },
                {
                    type: "paragraph",
                    content: [{ type: "text", text: "baz " }],
                },
            ],
        };

        const have = cellText(cell, {});

        expect(have).toBe("foo<br>bar<br>baz");
    });
});
