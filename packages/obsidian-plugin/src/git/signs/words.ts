// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT
//
// The word-level diff inside a changed hunk: which parts of its base and note
// lines actually differ, so the hover popup can mark the edited words instead
// of leaving the reader to compare two whole paragraphs.

import { presentableDiff } from "@codemirror/merge";
import type { Hunk } from "./hunks.ts";

/** Segment is a run of one line's text, `changed` when the diff touched it. */
export interface Segment {
    text: string;
    changed: boolean;
}

/** WordDiff is a hunk's lines on each side, split into segments. */
export interface WordDiff {
    removed: Segment[][];
    added: Segment[][];
}

/** Range is a changed span of text, as [from, to) offsets. */
interface Range {
    from: number;
    to: number;
}

/**
 * wordDiff splits a hunk's base and note lines into changed and unchanged
 * segments. Only a change hunk has both sides to compare: an added or deleted
 * hunk is one unchanged segment per line, as the whole line is the change.
 */
export function wordDiff(hunk: Hunk): WordDiff {
    const { removed, added } = hunk;
    if (hunk.type !== "change") {
        return { removed: plain(removed.lines), added: plain(added.lines) };
    }
    const changes = presentableDiff(
        removed.lines.join("\n"),
        added.lines.join("\n"),
    );
    return {
        removed: split(
            removed.lines,
            changes.map((c) => ({ from: c.fromA, to: c.toA })),
        ),
        added: split(
            added.lines,
            changes.map((c) => ({ from: c.fromB, to: c.toB })),
        ),
    };
}

/** plain makes each line a single unchanged segment. */
function plain(lines: readonly string[]): Segment[][] {
    return lines.map((text) => [{ text, changed: false }]);
}

/**
 * split cuts `lines` — joined by newlines, the text `ranges` index — into
 * segments, marking the parts inside a range as changed. A changed newline
 * has no text to mark, so it is dropped.
 */
function split(
    lines: readonly string[],
    ranges: readonly Range[],
): Segment[][] {
    const out: Segment[][] = [];
    let start = 0;
    for (const line of lines) {
        const end = start + line.length;
        const segs: Segment[] = [];
        let pos = start;
        for (const r of ranges) {
            const from = Math.max(r.from, start);
            const to = Math.min(r.to, end);
            if (from >= to) continue;
            if (from > pos) {
                push(segs, line.slice(pos - start, from - start), false);
            }
            push(segs, line.slice(from - start, to - start), true);
            pos = to;
        }
        if (pos < end) push(segs, line.slice(pos - start), false);
        out.push(segs);
        start = end + 1;
    }
    return out;
}

/** push appends a segment, merging it into the last one of the same kind. */
function push(segs: Segment[], text: string, changed: boolean): void {
    const last = segs.at(-1);
    if (last !== undefined && last.changed === changed) last.text += text;
    else segs.push({ text, changed });
}
