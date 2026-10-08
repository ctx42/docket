// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT
//
// Ported from obsidian-git `src/editor/signs/diff.ts`
// (https://github.com/Vinzent03/obsidian-git), MIT License,
// Copyright (c) 2020 Vinzent03, Denis Olehov.
//
// The line diff between a note's base (HEAD) text and its editor text, as
// hunks. @codemirror/merge does the diffing; given the previous chunks and the
// edits since, it updates them incrementally instead of re-diffing the note.

import { Chunk } from "@codemirror/merge";
import { type ChangeDesc, Text } from "@codemirror/state";
import { createHunk, type Hunk } from "./hunks.ts";

/** RawHunk is a hunk's git-style line ranges, before its lines are filled in. */
interface RawHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
}

/**
 * lineFromPos returns the file line of document position `pos`: the empty
 * line after a final newline belongs to the line before it.
 */
export function lineFromPos(doc: Text, pos: number): number {
    const line = doc.lineAt(pos);
    const noNlAtEof = !(line.text.length === 0 && line.number === doc.lines);
    return noNlAtEof ? line.number : line.number - 1;
}

/** rawHunksToHunks fills raw ranges with the lines they cover. */
function rawHunksToHunks(
    textA: string,
    textB: string,
    raws: RawHunk[],
): Hunk[] {
    const linesA = textA.split("\n");
    const linesB = textB.split("\n");
    return raws.map((r) => {
        const hunk = createHunk(r.oldStart, r.oldLines, r.newStart, r.newLines);
        if (r.oldLines > 0) {
            for (let i = r.oldStart; i < r.oldStart + r.oldLines; i++) {
                hunk.removed.lines.push(linesA[i - 1] ?? "");
            }
            if (
                r.oldStart + r.oldLines > linesA.length &&
                linesA.at(-1) !== ""
            ) {
                hunk.removed.no_nl_at_eof = true;
            }
        }
        if (r.newLines > 0) {
            for (let i = r.newStart; i < r.newStart + r.newLines; i++) {
                hunk.added.lines.push(linesB[i - 1] ?? "");
            }
            if (
                r.newStart + r.newLines > linesB.length &&
                linesB.at(-1) !== ""
            ) {
                hunk.added.no_nl_at_eof = true;
            }
        }
        return hunk;
    });
}

/** rawHunkFromChunk converts a merge chunk to git-style line ranges. */
function rawHunkFromChunk(chunk: Chunk, aDoc: Text, bDoc: Text): RawHunk {
    const oldStart = aDoc.lineAt(chunk.fromA).number;
    const oldLines =
        chunk.fromA === chunk.toA
            ? 0
            : lineFromPos(aDoc, chunk.endA) - oldStart + 1;
    const newStart = bDoc.lineAt(chunk.fromB).number;
    const newLines =
        chunk.fromB === chunk.toB
            ? 0
            : lineFromPos(bDoc, chunk.endB) - newStart + 1;
    return {
        oldStart: oldLines === 0 ? oldStart - 1 : oldStart,
        oldLines,
        newStart: newLines === 0 ? newStart - 1 : newStart,
        newLines,
    };
}

/** DIFF_CONFIG bounds the diff's effort on a large note. */
const DIFF_CONFIG = { scanLimit: 1000, timeout: 200 };

/**
 * computeHunks diffs `textB` (the note) against `textA` (its base). An empty
 * base (a file HEAD lacks) makes every line one added hunk. `chunks` and
 * `changes` — the previous result and the edits since — make the diff
 * incremental.
 */
export function computeHunks(
    textA: string,
    textB: string,
    chunks?: readonly Chunk[],
    changes?: ChangeDesc,
): { hunks: Hunk[]; chunks: readonly Chunk[] | undefined } {
    if (textA === "") {
        if (textB === "") return { hunks: [], chunks: undefined };
        const lines = textB.split("\n");
        const count = lines.at(-1) === "" ? lines.length - 1 : lines.length;
        return {
            hunks: rawHunksToHunks(textA, textB, [
                { oldStart: 0, oldLines: 0, newStart: 1, newLines: count },
            ]),
            chunks: undefined,
        };
    }
    const aDoc = Text.of(textA.split("\n"));
    const bDoc = Text.of(textB.split("\n"));
    const next =
        chunks !== undefined && changes !== undefined
            ? Chunk.updateB(chunks, aDoc, bDoc, changes, DIFF_CONFIG)
            : Chunk.build(aDoc, bDoc, DIFF_CONFIG);
    const raws = next.map((c) => rawHunkFromChunk(c, aDoc, bDoc));
    return { hunks: rawHunksToHunks(textA, textB, raws), chunks: next };
}
