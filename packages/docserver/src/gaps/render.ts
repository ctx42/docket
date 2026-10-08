// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Gap file rendering: the inverse of format.ts. Unchanged front-matter keys
// and body sections are written back byte for byte; changed keys are
// re-encoded with the yaml.v3 encoder port so the bytes match the Go server.

import { formatRFC3339, type GoTime } from "../gocompat/time.ts";
import { encodeNode } from "../yamlv3/encode.ts";
import { TAG, type YamlNode } from "../yamlv3/node.ts";
import {
    type Body,
    FENCE,
    type GapFile,
    type GapFrontMatter,
    HEAD_DEMAND,
    HEAD_DETAIL,
    HEAD_TARGET,
    KEY,
    KEY_ORDER,
    renderBody,
    spans,
    trimBlank,
} from "./format.ts";
import type { FillRef, Gap } from "./gaps.ts";

/**
 * newGapFile returns the file for a new gap, every front-matter key and
 * body section set from gap.
 */
export function newGapFile(name: string, gap: Gap): GapFile {
    const gfl: GapFile = {
        name,
        meta: { lines: [], root: mappingNode([]), edits: [] },
        body: {
            lead: "",
            h1: `# ${gap.topic}\n`,
            intro: "\n",
            headDemand: `${HEAD_DEMAND}\n`,
            demand: sectionText(gap.demand, false),
            headDetail: `${HEAD_DETAIL}\n`,
            detail: sectionText(gap.detail, false),
            headTarget: `${HEAD_TARGET}\n`,
            target: sectionText(gap.targetClaim, true),
            tail: "",
        },
        gap,
    };
    const fm = gfl.meta;
    setKey(fm, KEY.id, strNode(gap.id));
    setKey(fm, KEY.status, strNode(gap.status));
    setKey(fm, KEY.kind, strNode(gap.kind));
    setKey(fm, KEY.answer, strNode(gap.answer));
    setKey(fm, KEY.ask, listNode(gap.ask));
    setKey(fm, KEY.asked, dateNode(gap.asked));
    setKey(fm, KEY.srdRef, strNode(gap.srdRef));
    setKey(fm, KEY.docID, strNode(gap.docID));
    setKey(fm, KEY.headingPath, listNode(gap.headingPath));
    setKey(fm, KEY.searchTerms, listNode(gap.searchTerms));
    setKey(fm, KEY.hits, intNode(gap.hits));
    setKey(fm, KEY.created, timeNode(gap.created));
    setKey(fm, KEY.filledBy, fillNode(gap.filledBy));
    return gfl;
}

/** renderGapFile returns the file's content. */
export function renderGapFile(gfl: GapFile): string {
    let meta: string;
    try {
        meta = renderMeta(gfl.meta);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`encode ${gfl.name}: ${msg}`, { cause: err });
    }
    return `${FENCE}\n${meta}${FENCE}\n${renderBody(gfl.body)}`;
}

/** setKey changes the value of key to val, adding the key when absent. */
export function setKey(fm: GapFrontMatter, key: string, val: YamlNode): void {
    const edt = fm.edits.find((e) => e.key === key);
    if (edt !== undefined) edt.val = val;
    else fm.edits.push({ key, val });
}

/**
 * renderMeta returns the front matter with the edits applied, each line
 * ending in a newline. Unchanged keys keep their lines byte for byte; a
 * changed key is re-encoded in place, and an added key goes after its
 * nearest present predecessor in KEY_ORDER, else last. Front matter whose
 * keys share lines, such as a flow mapping, is re-encoded whole.
 */
export function renderMeta(fm: GapFrontMatter): string {
    const keys = fm.root.content;
    const spns = spans(fm);
    if (spns === undefined) return renderWhole(fm);
    const edited = new Map(fm.edits.map((e) => [e.key, e.val]));
    const present = new Set<string>();
    for (let i = 0; i + 1 < keys.length; i += 2)
        present.add((keys[i] as YamlNode).value);
    const added = new Map<string, { key: string; val: YamlNode }[]>();
    for (const edt of fm.edits) {
        if (present.has(edt.key)) continue;
        const after = predecessor(edt.key, present);
        added.set(after, [...(added.get(after) ?? []), edt]);
    }

    const out: string[] = [];
    const emit = (key: string, val: YamlNode): void => {
        out.push(...encodeKey(key, val));
    };
    let cursor = 0;
    spns.forEach((spn, i) => {
        const key = (keys[2 * i] as YamlNode).value;
        out.push(...fm.lines.slice(cursor, spn.start));
        const val = edited.get(key);
        if (val !== undefined) emit(key, val);
        else out.push(...fm.lines.slice(spn.start, spn.end));
        cursor = spn.end;
        for (const edt of added.get(key) ?? []) emit(edt.key, edt.val);
    });
    out.push(...fm.lines.slice(cursor));
    for (const edt of added.get("") ?? []) emit(edt.key, edt.val);
    return joinLines(out);
}

/** renderWhole re-encodes the whole mapping with the edits applied. */
export function renderWhole(fm: GapFrontMatter): string {
    const keys = fm.root.content;
    const present = new Set<string>();
    for (let i = 0; i + 1 < keys.length; i += 2)
        present.add((keys[i] as YamlNode).value);
    const root: YamlNode = { ...mappingNode([...keys]), style: fm.root.style };
    for (const edt of fm.edits) {
        if (!present.has(edt.key)) {
            root.content.push(keyNode(edt.key), edt.val);
            continue;
        }
        for (let i = 0; i + 1 < root.content.length; i += 2) {
            if ((root.content[i] as YamlNode).value === edt.key)
                root.content[i + 1] = edt.val;
        }
    }
    return encodeNode(root);
}

/**
 * predecessor returns the nearest key before key in KEY_ORDER that present
 * holds, or "" when there is none.
 */
export function predecessor(key: string, present: ReadonlySet<string>): string {
    let last = "";
    for (const cur of KEY_ORDER) {
        if (cur === key) return last;
        if (present.has(cur)) last = cur;
    }
    return "";
}

/** encodeKey returns the YAML lines of the one-key mapping key: val. */
export function encodeKey(key: string, val: YamlNode): string[] {
    const raw = encodeNode(mappingNode([keyNode(key), val]));
    return (raw.endsWith("\n") ? raw.slice(0, -1) : raw).split("\n");
}

/** joinLines joins lines, ending each with a newline. */
export function joinLines(lines: readonly string[]): string {
    return lines.map((line) => `${line}\n`).join("");
}

/** keyNode returns a mapping key node. */
export function keyNode(key: string): YamlNode {
    return scalarNode("", key);
}

/**
 * strNode returns a string scalar node, quoted when YAML would read it as
 * another type.
 */
export function strNode(val: string): YamlNode {
    return scalarNode(TAG.str, val);
}

/** intNode returns an integer scalar node. */
export function intNode(val: number): YamlNode {
    return scalarNode(TAG.int, String(val));
}

/** timeNode returns an unquoted RFC 3339 timestamp node. */
export function timeNode(val: GoTime): YamlNode {
    return scalarNode("", formatRFC3339(val));
}

/**
 * dateNode returns a scalar node of the YYYY-MM-DD date val, unquoted so
 * YAML readers such as Obsidian take it for a date; an empty val is an
 * empty string.
 */
export function dateNode(val: string): YamlNode {
    return val === "" ? strNode("") : scalarNode("", val);
}

/** listNode returns a sequence node of the strings vals. */
export function listNode(vals: readonly string[]): YamlNode {
    return { ...mappingNode(vals.map(strNode)), kind: "sequence" };
}

/**
 * fillNode returns a sequence node of the filled_by entries refs, each a
 * mapping of ref and, when set, hash.
 */
export function fillNode(refs: readonly FillRef[]): YamlNode {
    const items = refs.map((ref) => {
        const content = [keyNode("ref"), strNode(ref.ref)];
        if (ref.hash !== "") content.push(keyNode("hash"), strNode(ref.hash));
        return mappingNode(content);
    });
    return { ...mappingNode(items), kind: "sequence" };
}

/** setTopic replaces the H1 with one holding topic. */
export function setTopic(bdy: Body, topic: string): void {
    bdy.h1 = `# ${topic}\n`;
}

/** setTarget replaces the Target claim section with text. */
export function setTarget(bdy: Body, text: string): void {
    if (!bdy.headTarget.endsWith("\n")) bdy.headTarget += "\n";
    bdy.target = sectionText(text, bdy.tail === "");
}

/**
 * sectionText returns the raw segment holding a section's text: a blank
 * line, the text, and, unless the section ends the file, a blank line
 * before the next heading. An empty section is a blank line, or nothing at
 * the end.
 */
export function sectionText(input: string, last: boolean): string {
    const text = trimBlank(input);
    if (text === "") return last ? "" : "\n";
    return last ? `\n${text}\n` : `\n${text}\n\n`;
}

function scalarNode(tag: string, value: string): YamlNode {
    return {
        kind: "scalar",
        style: "plain",
        tag,
        value,
        line: 0,
        content: [],
        offset: 0,
    };
}

function mappingNode(content: YamlNode[]): YamlNode {
    return {
        kind: "mapping",
        style: "block",
        tag: "",
        value: "",
        line: 0,
        content,
        offset: 0,
    };
}
