// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { Node } from "../../src/models/adf.ts";
import { genDoc, Rng, validateDoc } from "./adfgen.ts";

/** collect returns every node and mark type found in a document. */
function collect(node: Node, types: Set<string>): Set<string> {
    types.add(node.type);
    for (const m of node.marks ?? []) {
        types.add(`mark:${m.type}`);
    }
    for (const kid of node.content ?? []) {
        collect(kid, types);
    }
    return types;
}

describe("Rng", () => {
    it("repeats its sequence for a seed", () => {
        const a = new Rng(7);
        const b = new Rng(7);

        const have = [a.next(), a.int(1, 9), a.chance(0.5)];

        expect(have).toEqual([b.next(), b.int(1, 9), b.chance(0.5)]);
    });

    it("stays within the requested bounds", () => {
        const rng = new Rng(1);

        for (let i = 0; i < 1000; i++) {
            const have = rng.int(3, 5);

            expect(have).toBeGreaterThanOrEqual(3);
            expect(have).toBeLessThanOrEqual(5);
        }
    });
});

describe("genDoc", () => {
    it("is deterministic per seed", () => {
        const have = genDoc(42);

        expect(have).toEqual(genDoc(42));
        expect(have).not.toEqual(genDoc(43));
    });

    it("generates documents that validate", () => {
        for (let seed = 0; seed < 500; seed++) {
            const have = validateDoc(genDoc(seed));

            expect(have, `seed ${seed}`).toEqual([]);
        }
    });

    it("covers every node and mark the flavor renders", () => {
        const types = new Set<string>();
        for (let seed = 0; seed < 500; seed++) {
            collect(genDoc(seed), types);
        }

        const want = [
            "paragraph",
            "heading",
            "text",
            "hardBreak",
            "bulletList",
            "orderedList",
            "listItem",
            "panel",
            "blockquote",
            "expand",
            "table",
            "tableRow",
            "tableHeader",
            "tableCell",
            "codeBlock",
            "mediaSingle",
            "mediaGroup",
            "media",
            "extension",
            "rule",
            "mention",
            "status",
            "date",
            "emoji",
            "inlineCard",
            "inlineExtension",
            "placeholder",
            "taskList",
            "bodiedExtension",
            "mark:link",
            "mark:em",
            "mark:strong",
            "mark:strike",
            "mark:subsup",
            "mark:underline",
            "mark:textColor",
            "mark:backgroundColor",
            "mark:code",
            "mark:indentation",
            "mark:alignment",
        ];
        expect(want.filter((t) => !types.has(t))).toEqual([]);
    });
});

describe("validateDoc", () => {
    const cases: Array<{ name: string; doc: Node; want: string }> = [
        {
            name: "a non-doc root",
            doc: { type: "paragraph" },
            want: "$: root is paragraph, want doc",
        },
        {
            name: "a block in a paragraph",
            doc: {
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "rule" }] }],
            },
            want: "$.doc[0].paragraph[0]: rule not allowed in paragraph",
        },
        {
            name: "an empty list",
            doc: { type: "doc", content: [{ type: "bulletList" }] },
            want: "$.doc[0]: bulletList must not be empty",
        },
        {
            name: "a list item led by a list",
            doc: {
                type: "doc",
                content: [
                    {
                        type: "bulletList",
                        content: [
                            {
                                type: "listItem",
                                content: [
                                    {
                                        type: "bulletList",
                                        content: [
                                            {
                                                type: "listItem",
                                                content: [
                                                    { type: "paragraph" },
                                                ],
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            want: "$.doc[0].bulletList[0]: listItem must start with a paragraph",
        },
        {
            name: "a heading level out of range",
            doc: {
                type: "doc",
                content: [{ type: "heading", attrs: { level: 7 } }],
            },
            want: "$.doc[0]: heading level 7 out of range",
        },
        {
            name: "an empty text node",
            doc: {
                type: "doc",
                content: [
                    {
                        type: "paragraph",
                        content: [{ type: "text", text: "" }],
                    },
                ],
            },
            want: "$.doc[0].paragraph[0]: text node must not be empty",
        },
        {
            name: "code combined with strong",
            doc: {
                type: "doc",
                content: [
                    {
                        type: "paragraph",
                        content: [
                            {
                                type: "text",
                                text: "x",
                                marks: [{ type: "code" }, { type: "strong" }],
                            },
                        ],
                    },
                ],
            },
            want: "$.doc[0].paragraph[0]: code combines only with link",
        },
        {
            name: "an unknown mark",
            doc: {
                type: "doc",
                content: [
                    {
                        type: "paragraph",
                        content: [
                            { type: "text", text: "x", marks: [{ type: "x" }] },
                        ],
                    },
                ],
            },
            want: "$.doc[0].paragraph[0]: unknown mark x",
        },
        {
            name: "a duplicate mark",
            doc: {
                type: "doc",
                content: [
                    {
                        type: "paragraph",
                        content: [
                            {
                                type: "text",
                                text: "x",
                                marks: [{ type: "em" }, { type: "em" }],
                            },
                        ],
                    },
                ],
            },
            want: "$.doc[0].paragraph[0]: duplicate mark",
        },
        {
            name: "an inline mark on a block",
            doc: {
                type: "doc",
                content: [{ type: "paragraph", marks: [{ type: "strong" }] }],
            },
            want: "$.doc[0]: paragraph cannot carry mark strong",
        },
        {
            name: "content on a leaf",
            doc: {
                type: "doc",
                content: [{ type: "rule", content: [{ type: "text" }] }],
            },
            want: "$.doc[0]: rule must not have content",
        },
        {
            name: "a mediaSingle holding two media",
            doc: {
                type: "doc",
                content: [
                    {
                        type: "mediaSingle",
                        content: [{ type: "media" }, { type: "media" }],
                    },
                ],
            },
            want: "$.doc[0]: mediaSingle must hold exactly one media",
        },
    ];

    for (const tc of cases) {
        it(`reports ${tc.name}`, () => {
            const have = validateDoc(tc.doc);

            expect(have.some((e) => e.startsWith(tc.want))).toBe(true);
        });
    }
});
