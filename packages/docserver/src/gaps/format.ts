// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Gap files, the parse half, ported from Go `pkg/gaps/format.go`. A gap file
// is YAML front matter plus a Markdown body with an H1 topic and the Demand,
// Detail and Target claim sections. Parsing keeps the front matter as its
// text lines next to the parsed mapping, and the body as raw segments, so a
// later render writes unchanged keys and sections back byte for byte and
// hand edits survive. Every failure is an "invalid gap file" error naming
// the file.

import { posixBase } from "@docket/core";
import { goQuote } from "../gocompat/strconv.ts";
import { trimRight, trimSpace } from "../gocompat/strings.ts";
import { type GoTime, parseTime } from "../gocompat/time.ts";
import { decodeInto, decodeValue, type Schema } from "../yamlv3/decode.ts";
import { parseYaml, shortTag, TAG, type YamlNode } from "../yamlv3/node.ts";
import {
    checkDate,
    EC_BAD_FILE,
    emptyGap,
    FILE_RE,
    type FillRef,
    type Gap,
    GapError,
    HEAD_RE,
    ID_RE,
    validAnswer,
    validKind,
    validStatus,
} from "./gaps.ts";
import { nonNil, uniqueFold } from "./helpers.ts";

/** Front-matter keys of a gap file. */
export const KEY = {
    id: "id",
    status: "status",
    kind: "kind",
    answer: "answer",
    ask: "ask",
    asked: "asked",
    srdRef: "srd_ref",
    docID: "doc_id",
    headingPath: "heading_path",
    searchTerms: "search_terms",
    hits: "hits",
    created: "created",
    filledBy: "filled_by",
} as const;

/** KEY_ORDER lists the keys in the order a new file writes them. */
export const KEY_ORDER: readonly string[] = [
    KEY.id,
    KEY.status,
    KEY.kind,
    KEY.answer,
    KEY.ask,
    KEY.asked,
    KEY.srdRef,
    KEY.docID,
    KEY.headingPath,
    KEY.searchTerms,
    KEY.hits,
    KEY.created,
    KEY.filledBy,
];

/** Body section headings, in the order a gap file carries them. */
export const HEAD_DEMAND = "## Demand";
export const HEAD_DETAIL = "## Detail";
export const HEAD_TARGET = "## Target claim";

/** FENCE opens and closes the front matter. */
export const FENCE = "---";

/** H1_RE matches an ATX heading of level 1. */
const H1_RE = /^#(?:[ \t]|$)/;

/** Edit is a new value for one front-matter key. */
export interface Edit {
    key: string;
    val: YamlNode;
}

/** GapFrontMatter is a gap file's front matter as written, plus edits. */
export interface GapFrontMatter {
    /** lines are the YAML lines between the fences, without newlines. */
    lines: string[];
    /** root is the mapping parsed from lines. */
    root: YamlNode;
    /** edits are the new values of changed keys, in change order. */
    edits: Edit[];
}

/**
 * Body is a gap file's Markdown body as raw segments; concatenated in field
 * order they reproduce it exactly.
 */
export interface Body {
    /** lead is the text before the H1, normally empty. */
    lead: string;
    h1: string;
    /** intro is the text between the H1 and the Demand heading. */
    intro: string;
    headDemand: string;
    demand: string;
    headDetail: string;
    detail: string;
    headTarget: string;
    target: string;
    /** tail is the text from the first H1/H2 after Target claim, verbatim. */
    tail: string;
}

/** GapFile is one gap file split into its editable parts. */
export interface GapFile {
    /** name is the slash-separated path within the gap folder. */
    name: string;
    meta: GapFrontMatter;
    body: Body;
    /** gap holds the values parsed from meta and body. */
    gap: Gap;
}

/**
 * FileError is the "invalid gap file" error of one file (Go `fileError`):
 * it carries {@link EC_BAD_FILE} and the reason as its cause.
 */
export class FileError extends GapError {
    constructor(
        readonly file: string,
        readonly reason: string,
        cause?: unknown,
    ) {
        super(EC_BAD_FILE, `invalid gap file ${file}: ${reason}`);
        this.name = "FileError";
        if (cause !== undefined) this.cause = cause;
    }

    /** entry returns the file and reason as a BadFile. */
    entry(): { file: string; reason: string } {
        return { file: this.file, reason: this.reason };
    }
}

/** badFile returns the FileError of file name, invalid for reason. */
export function badFile(name: string, reason: unknown): FileError {
    const msg = reason instanceof Error ? reason.message : String(reason);
    return new FileError(name, msg, reason);
}

/**
 * parseGapFile parses the gap file name holding raw, checking it against
 * the gap format; every failure is a {@link FileError}.
 */
export function parseGapFile(name: string, raw: string): GapFile {
    let gfl: GapFile;
    try {
        gfl = parseParts(name, raw);
        decode(gfl);
    } catch (err) {
        throw badFile(name, err);
    }
    return gfl;
}

/** parseParts splits src into front matter and body segments. */
export function parseParts(name: string, src: string): GapFile {
    const { meta, rest } = splitMeta(src);
    return { name, meta, body: parseBody(rest), gap: emptyGap() };
}

/**
 * claimedID returns the id the front matter of src states, or "" when the
 * front matter cannot be read or states none.
 */
export function claimedID(src: string): string {
    let meta: GapFrontMatter;
    try {
        meta = splitMeta(src).meta;
    } catch {
        return "";
    }
    const keys = meta.root.content;
    for (let i = 0; i + 1 < keys.length; i += 2) {
        if ((keys[i] as YamlNode).value !== KEY.id) continue;
        try {
            return scalar(keys[i + 1] as YamlNode);
        } catch {
            return "";
        }
    }
    return "";
}

/** splitMeta parses the front matter opening src and returns the rest. */
export function splitMeta(src: string): { meta: GapFrontMatter; rest: string } {
    const nl = src.indexOf("\n");
    if (nl < 0 || trimRight(src.slice(0, nl), "\r") !== FENCE) {
        throw new Error("no front matter");
    }
    let rest = src.slice(nl + 1);
    const lines: string[] = [];
    let closed = false;
    while (rest !== "") {
        const i = rest.indexOf("\n");
        const line = i < 0 ? rest : rest.slice(0, i);
        rest = i < 0 ? "" : rest.slice(i + 1);
        if (trimRight(line, "\r") === FENCE) {
            closed = true;
            break;
        }
        lines.push(line);
    }
    if (!closed) throw new Error("front matter not closed");
    let root: YamlNode | undefined;
    try {
        root = parseYaml(lines.join("\n"));
    } catch (err) {
        throw new Error(`front matter: yaml: ${(err as Error).message}`, {
            cause: err,
        });
    }
    if (root === undefined || root.kind !== "mapping") {
        throw new Error("front matter is not a mapping");
    }
    return { meta: { lines, root, edits: [] }, rest };
}

/**
 * decode fills gfl.gap from the front matter and body, checking every rule
 * of the gap format.
 */
export function decode(gfl: GapFile): void {
    const gap = emptyGap();
    gap.file = gfl.name;
    const seen = new Set<string>();
    const root = gfl.meta.root;
    for (let i = 0; i + 1 < root.content.length; i += 2) {
        const key = (root.content[i] as YamlNode).value;
        if (seen.has(key)) throw new Error(`duplicate key ${goQuote(key)}`);
        seen.add(key);
        try {
            decodeKey(gap, key, root.content[i + 1] as YamlNode);
        } catch (err) {
            throw new Error(`key ${goQuote(key)}: ${(err as Error).message}`, {
                cause: err,
            });
        }
    }
    for (const key of [KEY.id, KEY.status, KEY.kind, KEY.hits, KEY.created]) {
        if (!seen.has(key))
            throw new Error(`missing required key ${goQuote(key)}`);
    }
    const match = FILE_RE.exec(posixBase(gfl.name));
    if (match === null || number(match[1] as string) !== idNumber(gap.id)) {
        throw new Error(`file name does not match id ${goQuote(gap.id)}`);
    }
    if (gap.status === "filled" && gap.filledBy.length === 0) {
        throw new Error("filled gap without filled_by");
    }
    gap.ask = uniqueFold(gap.ask);
    gap.headingPath = nonNil(gap.headingPath);
    gap.searchTerms = nonNil(gap.searchTerms);
    gap.topic = topic(gfl.body);
    gap.demand = trimBlank(gfl.body.demand);
    gap.detail = trimBlank(gfl.body.detail);
    gap.targetClaim = trimBlank(gfl.body.target);
    gfl.gap = gap;
}

const FILL_SCHEMA = {
    kind: "struct",
    type: "gaps.FillRef",
    fields: { ref: { kind: "string" }, hash: { kind: "string" } },
} as const satisfies Schema;

/**
 * decodeKey sets the field of gap that key names from val; keys the format
 * does not define are ignored, so they survive untouched.
 */
function decodeKey(gap: Gap, key: string, val: YamlNode): void {
    switch (key) {
        case KEY.id:
            gap.id = scalar(val);
            if (!ID_RE.test(gap.id))
                throw new Error(`want gap-NNNN, have ${goQuote(gap.id)}`);
            return;
        case KEY.status:
            gap.status = scalar(val);
            if (!validStatus(gap.status))
                throw new Error(`unknown status ${goQuote(gap.status)}`);
            return;
        case KEY.kind:
            gap.kind = scalar(val);
            if (!validKind(gap.kind))
                throw new Error(`unknown kind ${goQuote(gap.kind)}`);
            return;
        case KEY.answer:
            gap.answer = scalar(val);
            if (!validAnswer(gap.answer))
                throw new Error(`unknown answer ${goQuote(gap.answer)}`);
            return;
        case KEY.ask:
            gap.ask = list(val);
            return;
        case KEY.asked: {
            gap.asked = scalar(val);
            const err = checkDate(gap.asked);
            if (err !== undefined) throw new Error(err);
            return;
        }
        case KEY.srdRef:
            gap.srdRef = scalar(val);
            return;
        case KEY.docID:
            gap.docID = scalar(val);
            return;
        case KEY.headingPath:
            gap.headingPath = list(val);
            return;
        case KEY.searchTerms:
            gap.searchTerms = list(val);
            return;
        case KEY.hits: {
            const hits = decodeValue(val, { kind: "int" });
            if (hits !== undefined) gap.hits = hits as number;
            if (gap.hits < 1)
                throw new Error(`want at least 1, have ${gap.hits}`);
            return;
        }
        case KEY.created:
            gap.created = parseTime("RFC3339", scalar(val)) as GoTime;
            return;
        case KEY.filledBy:
            gap.filledBy = fillRefs(val);
            return;
    }
}

/** idNumber returns a gap ID's number, -1 when it is not an ID. */
export function idNumber(id: string): number {
    const m = ID_RE.exec(id);
    return m === null ? -1 : number(m[1] as string);
}

/** number parses decimal digits, -1 when they overflow Go's int. */
export function number(s: string): number {
    const n = BigInt(s);
    return n > 9223372036854775807n ? -1 : Number(n);
}

/** scalar returns a scalar node's value; YAML null is "". */
export function scalar(val: YamlNode): string {
    if (val.kind !== "scalar") throw new Error("want a scalar");
    return shortTag(val) === TAG.null ? "" : val.value;
}

/** list returns a sequence's scalars, never null; YAML null is []. */
export function list(val: YamlNode): string[] {
    if (val.kind === "scalar" && shortTag(val) === TAG.null) return [];
    if (val.kind !== "sequence") throw new Error("want a list");
    return val.content.map(scalar);
}

/**
 * fillRefs returns the filled_by entries of a sequence, never null; YAML
 * null is []. Each entry needs a non-blank ref.
 */
export function fillRefs(val: YamlNode): FillRef[] {
    if (val.kind === "scalar" && shortTag(val) === TAG.null) return [];
    if (val.kind !== "sequence") throw new Error("want a list");
    return val.content.map((itm) => {
        const ent = { ref: "", hash: "" };
        try {
            decodeInto(itm, FILL_SCHEMA, ent);
        } catch {
            throw new Error("want a mapping with ref and hash");
        }
        if (trimSpace(ent.ref) === "") throw new Error("entry without ref");
        return ent;
    });
}

/**
 * spans returns the line range [start, end) of each top-level key, in
 * mapping order: the key's line up to the next key, less trailing blank and
 * comment lines (they belong to the next key). It returns undefined when the
 * keys do not each start on a line of their own (flow style, shared lines).
 */
export function spans(
    fm: GapFrontMatter,
): { start: number; end: number }[] | undefined {
    const keys = fm.root.content;
    if (fm.root.style === "flow") return undefined;
    const out: { start: number; end: number }[] = [];
    for (let i = 0; i + 1 < keys.length; i += 2) {
        const start = (keys[i] as YamlNode).line - 1;
        if (start < 0 || start >= fm.lines.length) return undefined;
        const prev = out[out.length - 1];
        if (prev !== undefined && start <= prev.start) return undefined;
        out.push({ start, end: 0 });
    }
    out.forEach((spn, i) => {
        let end =
            i + 1 < out.length
                ? (out[i + 1] as { start: number }).start
                : fm.lines.length;
        while (end - 1 > spn.start && filler(fm.lines[end - 1] as string))
            end--;
        spn.end = end;
    });
    return out;
}

/** filler reports a blank line or a YAML comment. */
export function filler(line: string): boolean {
    const t = trimSpace(line);
    return t === "" || t.startsWith("#");
}

/**
 * parseBody splits src into body segments. It requires an H1 followed by
 * the Demand, Detail and Target claim headings in this order; lines inside
 * fenced code blocks are never headings.
 */
export function parseBody(src: string): Body {
    const bdy: Body = {
        lead: "",
        h1: "",
        intro: "",
        headDemand: "",
        demand: "",
        headDetail: "",
        detail: "",
        headTarget: "",
        target: "",
        tail: "",
    };
    const heads = ["h1", "headDemand", "headDetail", "headTarget"] as const;
    const texts = ["lead", "intro", "demand", "detail"] as const;
    const wants = ["", HEAD_DEMAND, HEAD_DETAIL, HEAD_TARGET];
    let inFence = false;
    let start = 0;
    let stage = 0;
    for (let off = 0; off < src.length; ) {
        const nl = src.indexOf("\n", off);
        const next = nl < 0 ? src.length : nl + 1;
        const line = trimRight(src.slice(off, next), " \t\r\n");
        if (fenceLine(line)) inFence = !inFence;
        if (!inFence) {
            if (stage === heads.length) {
                if (HEAD_RE.test(line)) {
                    bdy.target = src.slice(start, off);
                    bdy.tail = src.slice(off);
                    return bdy;
                }
            } else if (
                (stage === 0 && H1_RE.test(line)) ||
                (stage > 0 && line === wants[stage])
            ) {
                bdy[texts[stage] as (typeof texts)[number]] = src.slice(
                    start,
                    off,
                );
                bdy[heads[stage] as (typeof heads)[number]] = src.slice(
                    off,
                    next,
                );
                start = next;
                stage++;
            }
        }
        off = next;
    }
    if (stage < heads.length) {
        if (stage === 0) throw new Error("missing topic heading");
        throw new Error(`missing ${goQuote(wants[stage] as string)} heading`);
    }
    bdy.target = src.slice(start);
    return bdy;
}

/** fenceLine reports a line opening or closing a fenced code block. */
export function fenceLine(line: string): boolean {
    const t = trimSpace(line);
    return t.startsWith("```") || t.startsWith("~~~");
}

/** topic returns the text of the body's H1. */
export function topic(bdy: Body): string {
    return trimSpace(bdy.h1.replace(/^#+/, ""));
}

/** renderBody returns the body text. */
export function renderBody(bdy: Body): string {
    return (
        bdy.lead +
        bdy.h1 +
        bdy.intro +
        bdy.headDemand +
        bdy.demand +
        bdy.headDetail +
        bdy.detail +
        bdy.headTarget +
        bdy.target +
        bdy.tail
    );
}

/**
 * trimBlank returns text without leading blank lines and trailing
 * whitespace, keeping the first line's indentation.
 */
export function trimBlank(input: string): string {
    let text = trimRight(input, " \t\r\n");
    for (;;) {
        const nl = text.indexOf("\n");
        if (nl < 0 || trimSpace(text.slice(0, nl)) !== "") return text;
        text = text.slice(nl + 1);
    }
}
