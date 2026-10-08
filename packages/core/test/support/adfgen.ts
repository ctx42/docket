// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A seeded generator of arbitrary, valid ADF documents for the lens property
// tests, plus the content-model validator it is checked against. The generator
// covers every node and mark the obsidian flavor renders, the frozen kinds
// (block macros, inline extensions, unknown nodes) and the nesting real pages
// carry — lists in tables, lists in panels, nested lists — with text drawn from
// a vocabulary heavy in Markdown-significant characters. The same seed always
// yields the same document, so a failing case is reproduced from its seed.

import type { Mark, Node } from "../../src/models/adf.ts";

/** Rng is a seeded pseudo-random source (mulberry32). */
export class Rng {
    private state: number;

    constructor(seed: number) {
        this.state = seed >>> 0;
    }

    /** next returns a float in [0, 1). */
    next(): number {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /** int returns an integer in [lo, hi]. */
    int(lo: number, hi: number): number {
        return lo + Math.floor(this.next() * (hi - lo + 1));
    }

    /** chance returns true with probability p. */
    chance(p: number): boolean {
        return this.next() < p;
    }

    /** pick returns a uniformly chosen element of a non-empty list. */
    pick<T>(items: readonly T[]): T {
        return items[this.int(0, items.length - 1)] as T;
    }
}

/**
 * WORDS is the text vocabulary: plain words, non-ASCII text, and the characters
 * and sequences the Markdown render must escape or that read as syntax at the
 * start of a line.
 */
const WORDS = [
    "alpha",
    "beta",
    "gamma",
    "naïve",
    "δέλτα",
    "😀",
    "42",
    "1.",
    "2)",
    "-",
    "+",
    "*",
    "**",
    "_",
    "__",
    "`",
    "~~",
    "#",
    "##",
    ">",
    "|",
    "\\",
    "[",
    "]",
    "(",
    ")",
    "![x]",
    "<u>",
    "<br>",
    "%%",
    "adf:",
    "&amp;",
    "---",
    "[!INFO]",
    "http://ex.com/a_b",
    "a*b",
    "x_y_z",
    "N>",
    "3>",
];

/** TEXT_COLORS are the textColor values the generator draws from. */
const TEXT_COLORS = ["#ff5630", "#36b37e", "#0052cc"];

/** PANEL_TYPES are the panel types the generator draws from. */
const PANEL_TYPES = ["info", "note", "success", "warning", "error", "custom"];

/** GenOptions bounds the size of a generated document. */
export interface GenOptions {
    /** Top-level block count range. */
    minBlocks: number;
    maxBlocks: number;
    /** Container nesting depth. */
    maxDepth: number;
}

const DEFAULTS: GenOptions = { minBlocks: 1, maxBlocks: 6, maxDepth: 2 };

/**
 * genDoc returns a valid ADF `doc` node generated from seed. The same seed and
 * options always produce the same document.
 */
export function genDoc(seed: number, opts: Partial<GenOptions> = {}): Node {
    const o = { ...DEFAULTS, ...opts };
    const g = new Gen(new Rng(seed), o);
    const n = g.rng.int(o.minBlocks, o.maxBlocks);
    const content: Node[] = [];
    for (let i = 0; i < n; i++) {
        content.push(g.topBlock());
    }
    // Confluence commonly appends an empty trailing paragraph.
    if (g.rng.chance(0.2)) {
        content.push({ type: "paragraph" });
    }
    return { type: "doc", content };
}

/** Gen holds the generator state: the random source, options and id counter. */
class Gen {
    private ids = 0;

    constructor(
        readonly rng: Rng,
        private readonly opts: GenOptions,
    ) {}

    /** localId mints a fresh localId attribute value. */
    private localId(): string {
        this.ids++;
        return `l${this.ids}`;
    }

    /** withId adds a localId to attrs most of the time, as Confluence does. */
    private withId(
        attrs: Record<string, unknown> = {},
    ): Record<string, unknown> {
        return this.rng.chance(0.8)
            ? { ...attrs, localId: this.localId() }
            : attrs;
    }

    /** topBlock generates one top-level block node. */
    topBlock(): Node {
        const r = this.rng.next();
        if (r < 0.3) return this.paragraph(true);
        if (r < 0.4) return this.heading();
        if (r < 0.5) return this.list(this.opts.maxDepth);
        if (r < 0.57) return this.panel(this.opts.maxDepth);
        if (r < 0.62) return this.blockquote();
        if (r < 0.67) return this.expand(this.opts.maxDepth);
        if (r < 0.75) return this.table(this.opts.maxDepth);
        if (r < 0.8) return this.codeBlock();
        if (r < 0.85) return this.media();
        if (r < 0.9) return this.extension();
        if (r < 0.95) return { type: "rule", ...this.attrsOrNot() };
        return this.unknownBlock();
    }

    /** attrsOrNot returns `{ attrs }` with a localId, or nothing. */
    private attrsOrNot(): { attrs?: Record<string, unknown> } {
        const attrs = this.withId();
        return Object.keys(attrs).length > 0 ? { attrs } : {};
    }

    /**
     * paragraph generates a paragraph; top-level ones may carry block marks. An
     * indented paragraph marks its text children too, as Confluence stores it.
     */
    paragraph(top = false): Node {
        const node: Node = { type: "paragraph", ...this.attrsOrNot() };
        const inline = this.inlineRun();
        if (inline.length > 0) {
            node.content = inline;
        }
        if (top && this.rng.chance(0.15)) {
            if (this.rng.chance(0.5)) {
                const indent: Mark = {
                    type: "indentation",
                    attrs: { level: this.rng.int(1, 3) },
                };
                node.marks = [indent];
                for (const kid of inline) {
                    if (kid.type === "text") {
                        kid.marks = [...(kid.marks ?? []), indent];
                    }
                }
            } else {
                const align = this.rng.pick(["center", "end"]);
                node.marks = [{ type: "alignment", attrs: { align } }];
            }
        }
        return node;
    }

    /** heading generates a heading of level 1–6. */
    heading(): Node {
        const level = this.rng.int(1, 6);
        const node: Node = { type: "heading", attrs: this.withId({ level }) };
        const inline = this.inlineRun();
        if (inline.length > 0) {
            node.content = inline;
        }
        return node;
    }

    /**
     * inlineRun generates the inline content of a paragraph or heading: text
     * runs and inline nodes, with adjacent equal-mark text merged the way the
     * Confluence editor stores it.
     */
    inlineRun(): Node[] {
        const n = this.rng.int(0, 5);
        const out: Node[] = [];
        for (let i = 0; i < n; i++) {
            const r = this.rng.next();
            if (r < 0.65) {
                out.push(this.text());
            } else if (r < 0.72) {
                if (out.length > 0) out.push({ type: "hardBreak" });
            } else {
                out.push(this.inlineNode());
            }
        }
        return mergeText(out);
    }

    /** text generates a non-empty text node with a random mark set. */
    text(): Node {
        const words: string[] = [];
        const n = this.rng.int(1, 4);
        for (let i = 0; i < n; i++) {
            words.push(this.rng.pick(WORDS));
        }
        let s = words.join(" ");
        if (this.rng.chance(0.15)) s = ` ${s}`;
        if (this.rng.chance(0.15)) s = `${s} `;
        const node: Node = { type: "text", text: s };
        const marks = this.marks();
        if (marks.length > 0) {
            node.marks = marks;
        }
        return node;
    }

    /**
     * marks generates a valid mark set in ADF's canonical order. `code` combines
     * only with `link`, as the ADF schema requires.
     */
    marks(): Mark[] {
        const link: Mark[] = this.rng.chance(0.15)
            ? [{ type: "link", attrs: { href: this.href() } }]
            : [];
        if (this.rng.chance(0.12)) {
            return [...link, { type: "code" }];
        }
        const out: Mark[] = [...link];
        if (this.rng.chance(0.2)) out.push({ type: "em" });
        if (this.rng.chance(0.2)) out.push({ type: "strong" });
        if (this.rng.chance(0.1)) out.push({ type: "strike" });
        if (this.rng.chance(0.05)) {
            const type = this.rng.pick(["sub", "sup"]);
            out.push({ type: "subsup", attrs: { type } });
        }
        if (this.rng.chance(0.1)) out.push({ type: "underline" });
        if (this.rng.chance(0.08)) {
            const color = this.rng.pick(TEXT_COLORS);
            out.push({ type: "textColor", attrs: { color } });
        }
        if (this.rng.chance(0.04)) {
            out.push({ type: "backgroundColor", attrs: { color: "#fefae0" } });
        }
        return out;
    }

    /** href generates a link target. */
    private href(): string {
        return this.rng.pick([
            "https://ex.com/",
            "https://ex.com/a b",
            "https://ex.com/p?q=1&r=(2)",
            "/wiki/spaces/X/pages/42",
            "mailto:a@ex.com",
        ]);
    }

    /** inlineNode generates a non-text inline node. */
    inlineNode(): Node {
        switch (this.rng.int(0, 6)) {
            case 0:
                return {
                    type: "mention",
                    attrs: {
                        id: `acc-${this.rng.int(1, 3)}`,
                        text: `@${this.rng.pick(["Ann", "Bo Li", "Ann"])}`,
                    },
                };
            case 1:
                return {
                    type: "status",
                    attrs: this.withId({
                        text: this.rng.pick(["DONE", "IN PROGRESS", "a|b"]),
                        color: this.rng.pick(["green", "neutral", "red"]),
                    }),
                };
            case 2:
                return {
                    type: "date",
                    attrs: { timestamp: String(this.rng.int(0, 2e12)) },
                };
            case 3:
                return {
                    type: "emoji",
                    attrs: {
                        shortName: this.rng.pick([":smile:", ":+1:"]),
                        id: "1f604",
                        text: "😄",
                    },
                };
            case 4:
                return {
                    type: "inlineCard",
                    attrs: { url: this.rng.pick(["https://ex.com/c", ""]) },
                };
            case 5:
                return {
                    type: "inlineExtension",
                    attrs: {
                        extensionKey: "anchor",
                        extensionType: "com.atlassian.confluence.macro.core",
                        parameters: { macroParams: { "": { value: "a" } } },
                        localId: this.localId(),
                    },
                };
            default:
                return { type: "placeholder", attrs: { text: "fill me" } };
        }
    }

    /** list generates a bullet or ordered list, nesting while depth allows. */
    list(depth: number): Node {
        const ordered = this.rng.chance(0.4);
        const items: Node[] = [];
        const n = this.rng.int(1, 4);
        for (let i = 0; i < n; i++) {
            items.push(this.listItem(depth));
        }
        const attrs = ordered
            ? this.withId({ order: this.rng.pick([1, 1, 3]) })
            : this.withId();
        return {
            type: ordered ? "orderedList" : "bulletList",
            ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
            content: items,
        };
    }

    /** listItem generates a list item: a paragraph, then more blocks. */
    private listItem(depth: number): Node {
        const content: Node[] = [this.paragraph()];
        if (this.rng.chance(0.15)) content.push(this.paragraph());
        if (depth > 0 && this.rng.chance(0.25))
            content.push(this.list(depth - 1));
        if (this.rng.chance(0.05)) content.push(this.codeBlock());
        return { type: "listItem", ...this.attrsOrNot(), content };
    }

    /** panel generates a panel of paragraphs, headings and lists. */
    panel(depth: number): Node {
        const panelType = this.rng.pick(PANEL_TYPES);
        const content: Node[] = [];
        const n = this.rng.int(1, 3);
        for (let i = 0; i < n; i++) {
            const r = this.rng.next();
            if (r < 0.7) content.push(this.paragraph());
            else if (r < 0.8) content.push(this.heading());
            else content.push(this.list(Math.max(depth - 1, 0)));
        }
        return { type: "panel", attrs: this.withId({ panelType }), content };
    }

    /** blockquote generates a blockquote of paragraphs and an optional list. */
    blockquote(): Node {
        const content: Node[] = [];
        const n = this.rng.int(1, 3);
        for (let i = 0; i < n; i++) {
            content.push(
                this.rng.chance(0.85) ? this.paragraph() : this.list(0),
            );
        }
        return { type: "blockquote", ...this.attrsOrNot(), content };
    }

    /** expand generates an expand with an optional title. */
    expand(depth: number): Node {
        const attrs: Record<string, unknown> = this.rng.chance(0.8)
            ? { title: this.rng.pick(["Details", "", "a *b*"]) }
            : {};
        const content: Node[] = [this.paragraph()];
        if (depth > 0 && this.rng.chance(0.3)) content.push(this.list(0));
        return { type: "expand", attrs: this.withId(attrs), content };
    }

    /**
     * table generates a rectangular table, optionally with a header row, a
     * header column, and one colspan or rowspan.
     */
    table(depth: number): Node {
        const rows = this.rng.int(1, 4);
        const cols = this.rng.int(1, 3);
        const headRow = this.rng.chance(0.5);
        const headCol = this.rng.chance(0.2);
        const span =
            rows > 1 && cols > 1 && this.rng.chance(0.2)
                ? this.rng.pick(["col", "row"])
                : "";
        const out: Node[] = [];
        for (let r = 0; r < rows; r++) {
            const cells: Node[] = [];
            for (let c = 0; c < cols; c++) {
                if (span === "col" && r === 0 && c === 1) continue;
                if (span === "row" && r === 1 && c === 0) continue;
                const header = (headRow && r === 0) || (headCol && c === 0);
                const attrs: Record<string, unknown> = {};
                if (span === "col" && r === 0 && c === 0) attrs["colspan"] = 2;
                if (span === "row" && r === 0 && c === 0) attrs["rowspan"] = 2;
                cells.push({
                    type: header ? "tableHeader" : "tableCell",
                    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
                    content: this.cellContent(depth),
                });
            }
            out.push({
                type: "tableRow",
                ...this.attrsOrNot(),
                content: cells,
            });
        }
        return { type: "table", attrs: this.withId(), content: out };
    }

    /** cellContent generates a cell's blocks: paragraphs, rarely a list. */
    private cellContent(depth: number): Node[] {
        const content: Node[] = [this.paragraph()];
        if (this.rng.chance(0.1)) content.push(this.paragraph());
        if (depth > 0 && this.rng.chance(0.08)) content.push(this.list(0));
        return content;
    }

    /** codeBlock generates a code block with an optional language. */
    codeBlock(): Node {
        const attrs: Record<string, unknown> = this.rng.chance(0.6)
            ? { language: this.rng.pick(["go", "ts", "adf", "text"]) }
            : {};
        const body = this.rng.pick([
            "x := 1",
            "line one\nline two",
            "```\nfenced\n```",
            "type: toc",
            "",
        ]);
        const node: Node = { type: "codeBlock", attrs: this.withId(attrs) };
        if (body !== "") {
            node.content = [{ type: "text", text: body }];
        }
        return node;
    }

    /** media generates a mediaSingle or mediaGroup of file or external media. */
    media(): Node {
        const one = (): Node => {
            if (this.rng.chance(0.3)) {
                return {
                    type: "media",
                    attrs: {
                        type: "external",
                        url: "https://ex.com/pic.png",
                        alt: "pic",
                    },
                };
            }
            return {
                type: "media",
                attrs: {
                    type: "file",
                    id: `file-${this.rng.int(1, 3)}`,
                    collection: "contentId-1",
                    localId: this.localId(),
                },
            };
        };
        if (this.rng.chance(0.7)) {
            return {
                type: "mediaSingle",
                attrs: { layout: "center" },
                content: [one()],
            };
        }
        return { type: "mediaGroup", content: [one(), one()] };
    }

    /** extension generates a block macro: a toc, or one with nested params. */
    extension(): Node {
        if (this.rng.chance(0.5)) {
            return {
                type: "extension",
                attrs: this.withId({
                    extensionKey: "toc",
                    extensionType: "com.atlassian.confluence.macro.core",
                    layout: "default",
                }),
            };
        }
        return {
            type: "extension",
            attrs: this.withId({
                extensionKey: "jira",
                extensionType: "com.atlassian.confluence.macro.core",
                parameters: { macroParams: { key: { value: "X-1" } } },
                layout: "default",
            }),
        };
    }

    /** unknownBlock generates a block type the flavor does not render. */
    unknownBlock(): Node {
        return this.rng.chance(0.5)
            ? {
                  type: "taskList",
                  attrs: { localId: this.localId() },
                  content: [
                      {
                          type: "taskItem",
                          attrs: { localId: this.localId(), state: "TODO" },
                          content: [{ type: "text", text: "task" }],
                      },
                  ],
              }
            : {
                  type: "bodiedExtension",
                  attrs: {
                      extensionKey: "details",
                      extensionType: "com.atlassian.confluence.macro.core",
                      localId: this.localId(),
                  },
                  content: [this.paragraph()],
              };
    }
}

/** mergeText merges adjacent text nodes carrying identical marks. */
function mergeText(nodes: Node[]): Node[] {
    const out: Node[] = [];
    for (const n of nodes) {
        const prev = out[out.length - 1];
        if (
            prev?.type === "text" &&
            n.type === "text" &&
            JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])
        ) {
            prev.text = `${prev.text ?? ""}${n.text ?? ""}`;
            continue;
        }
        out.push(n);
    }
    return out;
}

// --- Validator ---

/** INLINE is every inline node type the generator emits. */
const INLINE = new Set([
    "text",
    "hardBreak",
    "mention",
    "status",
    "date",
    "emoji",
    "inlineCard",
    "inlineExtension",
    "placeholder",
]);

/** CHILDREN maps a container type to the child types the ADF schema allows. */
const CHILDREN: Record<string, ReadonlySet<string>> = {
    doc: new Set([
        "paragraph",
        "heading",
        "bulletList",
        "orderedList",
        "panel",
        "blockquote",
        "expand",
        "table",
        "codeBlock",
        "mediaSingle",
        "mediaGroup",
        "extension",
        "rule",
        "taskList",
        "bodiedExtension",
    ]),
    paragraph: INLINE,
    heading: INLINE,
    bulletList: new Set(["listItem"]),
    orderedList: new Set(["listItem"]),
    listItem: new Set([
        "paragraph",
        "bulletList",
        "orderedList",
        "codeBlock",
        "mediaSingle",
    ]),
    panel: new Set(["paragraph", "heading", "bulletList", "orderedList"]),
    blockquote: new Set(["paragraph", "bulletList", "orderedList"]),
    expand: new Set(["paragraph", "bulletList", "orderedList"]),
    table: new Set(["tableRow"]),
    tableRow: new Set(["tableCell", "tableHeader"]),
    tableCell: new Set(["paragraph", "bulletList", "orderedList"]),
    tableHeader: new Set(["paragraph", "bulletList", "orderedList"]),
    codeBlock: new Set(["text"]),
    mediaSingle: new Set(["media"]),
    mediaGroup: new Set(["media"]),
    taskList: new Set(["taskItem"]),
    taskItem: INLINE,
    bodiedExtension: new Set(["paragraph"]),
};

/** NON_EMPTY lists the containers that need at least one child. */
const NON_EMPTY = new Set([
    "bulletList",
    "orderedList",
    "listItem",
    "panel",
    "blockquote",
    "expand",
    "table",
    "tableRow",
    "tableCell",
    "tableHeader",
    "mediaSingle",
    "mediaGroup",
    "taskList",
]);

/** MARKS is every mark type the validator accepts on a text node. */
const MARKS = new Set([
    "link",
    "em",
    "strong",
    "strike",
    "subsup",
    "underline",
    "textColor",
    "backgroundColor",
    "code",
    "annotation",
    "indentation",
]);

/**
 * CODE_PEERS are the marks `code` may combine with: link and annotation per
 * the ADF schema, and the text-level indentation Confluence adds to every text
 * node of an indented paragraph.
 */
const CODE_PEERS = new Set(["code", "link", "annotation", "indentation"]);

/** BLOCK_MARKS is every node-level mark the validator accepts. */
const BLOCK_MARKS = new Set(["alignment", "indentation", "breakout"]);

/**
 * validateDoc checks a node tree against the ADF content model the generator
 * targets and returns one message per violation, each naming the node's path;
 * an empty list means the document is valid.
 */
export function validateDoc(doc: Node): string[] {
    const errs: string[] = [];
    if (doc.type !== "doc") {
        errs.push(`$: root is ${doc.type}, want doc`);
    }
    walk(doc, "$", errs);
    return errs;
}

/** walk validates node at path and recurses into its children. */
function walk(node: Node, path: string, errs: string[]): void {
    const allowed = CHILDREN[node.type];
    const kids = node.content ?? [];
    if (allowed === undefined && kids.length > 0) {
        errs.push(`${path}: ${node.type} must not have content`);
    }
    if (NON_EMPTY.has(node.type) && kids.length === 0) {
        errs.push(`${path}: ${node.type} must not be empty`);
    }
    if (node.type === "listItem" && kids[0]?.type !== "paragraph") {
        errs.push(`${path}: listItem must start with a paragraph`);
    }
    if (node.type === "heading") {
        const level = node.attrs?.["level"];
        if (typeof level !== "number" || level < 1 || level > 6) {
            errs.push(`${path}: heading level ${String(level)} out of range`);
        }
    }
    if (node.type === "text") {
        validateText(node, path, errs);
    } else if (node.marks !== undefined) {
        for (const m of node.marks) {
            if (!BLOCK_MARKS.has(m.type)) {
                errs.push(`${path}: ${node.type} cannot carry mark ${m.type}`);
            }
        }
    }
    if (node.type === "mediaSingle" && kids.length !== 1) {
        errs.push(`${path}: mediaSingle must hold exactly one media`);
    }
    for (const [i, kid] of kids.entries()) {
        const at = `${path}.${node.type}[${i}]`;
        if (allowed !== undefined && !allowed.has(kid.type)) {
            errs.push(`${at}: ${kid.type} not allowed in ${node.type}`);
        }
        walk(kid, at, errs);
    }
}

/** validateText checks a text node: non-empty, known marks, code's exclusivity. */
function validateText(node: Node, path: string, errs: string[]): void {
    if (node.text === undefined || node.text === "") {
        errs.push(`${path}: text node must not be empty`);
    }
    const types = (node.marks ?? []).map((m) => m.type);
    for (const t of types) {
        if (!MARKS.has(t)) {
            errs.push(`${path}: unknown mark ${t}`);
        }
    }
    if (new Set(types).size !== types.length) {
        errs.push(`${path}: duplicate mark`);
    }
    if (types.includes("code") && types.some((t) => !CODE_PEERS.has(t))) {
        errs.push(`${path}: code combines only with link and annotation`);
    }
}
