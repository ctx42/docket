// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Section splitting ported from Go `pkg/corpus/chunker.go`: a long Markdown
// body is cut at level-1 and level-2 headings outside fenced code; deeper
// headings only extend the heading path. Splitting only on heading lines
// keeps table rows together.

import { trimLeft, trimRight, trimSpace } from "../gocompat/strings.ts";
import { estTokens, nonEmpty } from "./helpers.ts";

/** DEFAULT_WHOLE_FILE_TOKENS is the largest body kept as one section. */
export const DEFAULT_WHOLE_FILE_TOKENS = 800;

/** Section is an intermediate chunk produced by {@link splitSections}. */
export interface Section {
    headingPath: string[];
    text: string;
    /** startLine is the 1-based body line the section starts on. */
    startLine: number;
}

/** HEADING matches an ATX heading; RE2 `\s` is ASCII whitespace only. */
const HEADING = /^(#{1,6})[\t\n\f\r ]/;

/**
 * splitSections divides a Markdown body into sections at level-1 and level-2
 * headings. A body estimated at or below wholeFileTokens stays one section.
 * Headings inside fenced code blocks never start a section.
 */
export function splitSections(
    body: string,
    wholeFileTokens: number,
): Section[] {
    if (trimSpace(body) === "") return [];
    if (estTokens(body) <= wholeFileTokens) {
        return [{ headingPath: [], text: trimRight(body, "\n"), startLine: 1 }];
    }

    const secs: Section[] = [];
    let path: string[] = [];
    let cur: Section | undefined;
    let inFence = false;
    const flush = () => {
        if (cur !== undefined && trimSpace(cur.text) !== "") {
            cur.text = trimRight(cur.text, "\n");
            secs.push(cur);
        }
        cur = undefined;
    };
    body.split("\n").forEach((line, i) => {
        if (isFence(line)) inFence = !inFence;
        const level = inFence ? 0 : headingLevel(line);
        if (level === 1 || level === 2) {
            flush();
            path = setHeading(path, level, headingText(line));
            cur = { headingPath: nonEmpty(path), text: "", startLine: i + 1 };
        } else if (level >= 3) {
            path = setHeading(path, level, headingText(line));
        }
        if (cur === undefined)
            cur = { headingPath: [], text: "", startLine: i + 1 };
        cur.text += `${line}\n`;
    });
    flush();
    return secs;
}

/**
 * headingLines returns the 0-based lines of body holding an ATX heading of
 * any level, skipping fenced code blocks as {@link splitSections} does.
 */
export function headingLines(body: string): number[] {
    const lines: number[] = [];
    let inFence = false;
    body.split("\n").forEach((line, i) => {
        if (isFence(line)) inFence = !inFence;
        if (!inFence && headingLevel(line) > 0) lines.push(i);
    });
    return lines;
}

/** isFence reports whether line opens or closes a fenced code block. */
export function isFence(line: string): boolean {
    const trimmed = trimSpace(line);
    return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

/** headingLevel returns line's ATX heading level, or 0 for no heading. */
export function headingLevel(line: string): number {
    return HEADING.exec(line)?.[1]?.length ?? 0;
}

/** headingText returns an ATX heading line's text without its "#" markers. */
export function headingText(line: string): string {
    return trimSpace(trimLeft(line, "#"));
}

/**
 * setHeading returns path with the entry at the 1-based heading level set to
 * text and deeper levels dropped, padding skipped levels with "".
 */
export function setHeading(
    path: readonly string[],
    level: number,
    text: string,
): string[] {
    const out =
        level <= path.length
            ? path.slice(0, level - 1)
            : [...path, ...Array<string>(level - 1 - path.length).fill("")];
    out.push(text);
    return out;
}
