// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The glossary ported from Go `pkg/glossary`: the terms defined by the corpus
// documents under one path. A term is a level-two heading outside a fenced
// block; its definition is the first paragraph after it, reduced to plain
// text. Go's regular expressions are RE2, where `\s` and `\S` are ASCII-only
// and `.` matches any rune but "\n"; the patterns below spell that out.

import { anchors } from "../corpus/corpus.ts";
import type { DocInfo, Document } from "../engine/engine.ts";
import { isDocNotFound } from "../engine/engine.ts";
import { fields, trimRight, trimSpace } from "../gocompat/strings.ts";
import { isNotExist } from "../ports.ts";
import { goToLower } from "../search/analyzer.ts";

/** Term is one defined glossary term. */
export interface Term {
    /** term is the heading text, e.g. "Stock Keeping Unit (SKU)". */
    term: string;
    /** name is the term without its trailing parenthesised abbreviation. */
    name: string;
    /** abbreviation is the text inside the trailing parentheses, or "". */
    abbreviation: string;
    /** id is the identity of the defining document. */
    id: string;
    /** path is the current path of the defining document. */
    path: string;
    /** anchor is the heading's corpus anchor, e.g. "maintenance-break-mb". */
    anchor: string;
    /** definition is the first paragraph after the heading, plain text. */
    definition: string;
}

/** Docs is the part of the engine a {@link Glossary} reads. */
export interface Docs {
    listDocs(): readonly DocInfo[];
    getDoc(ref: string): Promise<Document>;
}

/** Glossary serves the terms defined by the documents under one path. */
export class Glossary {
    private readonly prefix: string;

    /**
     * @param path is a document path (one document) or a directory path
     *   (every document beneath it); a trailing "/" is dropped.
     */
    constructor(
        private readonly docs: Docs,
        path: string,
    ) {
        this.prefix = path.endsWith("/") ? path.slice(0, -1) : path;
    }

    /** path returns the document path or prefix the glossary covers. */
    path(): string {
        return this.prefix;
    }

    /**
     * terms returns the defined terms ordered by document path, then by
     * position. A non-empty filter keeps the terms whose heading contains
     * it, ignoring case. A document deleted since the last rebuild is
     * skipped.
     */
    async terms(filter: string): Promise<Term[]> {
        const needle = goLower(trimSpace(filter));
        const out: Term[] = [];
        for (const info of this.docs.listDocs()) {
            if (!this.covers(info.path)) continue;
            let doc: Document;
            try {
                doc = await this.docs.getDoc(info.path);
            } catch (err) {
                if (isNotExist(err) || isDocNotFound(err)) continue;
                throw new Error(`glossary: ${(err as Error).message}`, {
                    cause: err,
                });
            }
            let parsed: Term[];
            try {
                parsed = parse(info, doc.text);
            } catch (err) {
                throw new Error(
                    `glossary: ${info.path}: ${(err as Error).message}`,
                    {
                        cause: err,
                    },
                );
            }
            for (const trm of parsed) {
                if (goLower(trm.term).includes(needle)) out.push(trm);
            }
        }
        return out;
    }

    /** covers reports whether the document at path belongs to the glossary. */
    covers(path: string): boolean {
        return path === this.prefix || path.startsWith(`${this.prefix}/`);
    }
}

/** goLower is Go's `strings.ToLower`: `unicode.ToLower` on every rune. */
function goLower(s: string): string {
    let out = "";
    for (const ch of s)
        out += String.fromCodePoint(goToLower(ch.codePointAt(0) as number));
    return out;
}

/** HEADING matches an ATX heading line of any level. */
const HEADING = /^#{1,6}(?: |$)/;
/** ABBR splits a heading into its name and trailing (abbreviation). */
const ABBR = /^([^\n]*[^\t\n\f\r ])[\t\n\f\r ]*\(([^()]+)\)$/;
/** FOOTNOTE matches a footnote reference such as "[^1]". */
const FOOTNOTE = /\[\^[^\]]*\]/g;
/** LINK matches a link whose target may hold one level of parentheses. */
const LINK = /\[([^\]]*)\]\((?:[^()\t\n\f\r ]|\([^()]*\))*\)/g;
/** EMPHASIS matches bold or italic text marked with asterisks. */
const EMPHASIS = /\*{1,3}([^*]+)\*{1,3}/g;

/**
 * parse returns the terms of document info's Markdown text: each "## "
 * heading outside a fence, its definition the first paragraph of the block
 * that follows (quotes, callouts and images skipped), up to the next
 * heading of any level.
 */
export function parse(info: DocInfo, text: string): Term[] {
    const { body, anchors: anchorAt } = anchors(text);
    const out: Term[] = [];
    let cur: Term | undefined;
    let para: string[] = [];
    let fence = "";
    let done = false;
    const flush = () => {
        if (cur !== undefined) {
            cur.definition = plainText(para.join(" "));
            out.push(cur);
        }
        cur = undefined;
        para = [];
        done = false;
    };

    body.split("\n").forEach((raw, i) => {
        let line = trimRight(raw, " \t\r");
        const trimmed = trimSpace(line);
        if (fence !== "") {
            if (trimmed.startsWith(fence)) fence = "";
            return;
        }
        const mark = fenceMark(trimmed);
        if (mark !== "") {
            fence = mark;
            return;
        }
        if (HEADING.test(line)) {
            flush();
            if (line.startsWith("## ")) {
                cur = newTerm(info, trimSpace(line.slice(3)));
                cur.anchor = anchorAt.get(i) ?? "";
            }
            return;
        }
        if (cur === undefined || done) return;
        line = trimSpace(line);
        if (line === "") {
            done = para.length > 0;
        } else if (!line.startsWith(">") && !line.startsWith("![")) {
            para.push(line);
        }
    });
    flush();
    return out;
}

/** newTerm returns the term for a "## " heading, anchor and definition empty. */
export function newTerm(info: DocInfo, heading: string): Term {
    const trm: Term = {
        term: heading,
        name: heading,
        abbreviation: "",
        id: info.id,
        path: info.path,
        anchor: "",
        definition: "",
    };
    const m = ABBR.exec(heading);
    if (m !== null) {
        trm.name = m[1] as string;
        trm.abbreviation = trimSpace(m[2] as string);
    }
    return trm;
}

/** fenceMark returns the fence a trimmed line opens ("```", "~~~") or "". */
export function fenceMark(trimmed: string): string {
    for (const mark of ["```", "~~~"]) {
        if (trimmed.startsWith(mark)) return mark;
    }
    return "";
}

/**
 * plainText reduces a Markdown paragraph to plain text: footnote references
 * dropped, links and emphasis unwrapped, code backticks and hard-break
 * backslashes removed, whitespace runs collapsed.
 */
export function plainText(md: string): string {
    let s = md.replace(FOOTNOTE, "");
    s = s.replace(LINK, "$1");
    s = s.replace(EMPHASIS, "$1");
    s = s.replaceAll("`", "");
    s = s.replaceAll(" \\ ", " ");
    if (s.endsWith(" \\")) s = s.slice(0, -2);
    return fields(s).join(" ");
}
