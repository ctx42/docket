// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT
//
// Ported from obsidian-git `src/editor/signs/hunks.ts`
// (https://github.com/Vinzent03/obsidian-git), MIT License,
// Copyright (c) 2020 Vinzent03, Denis Olehov — itself translated from
// gitsigns.nvim `lua/gitsigns/hunks.lua`
// (https://github.com/lewis6991/gitsigns.nvim), MIT License,
// Copyright (c) 2020 Lewis Russell.
//
// The hunk model behind the editor change bars: a hunk is a run of lines the
// note's text changed against its base (HEAD) version, and calcSigns turns it
// into one gutter sign per affected line. Only what the bars and their hover
// popup need is ported — no patch building, staging, or hunk navigation.

/** HunkType is what a hunk did to its lines. */
export type HunkType = "add" | "change" | "delete";

/** HunkNode is one side of a hunk: where it starts, how many lines, which. */
export interface HunkNode {
    start: number;
    count: number;
    lines: string[];
    no_nl_at_eof?: true;
}

/** Hunk is one changed run: `removed` from the base, `added` in the note. */
export interface Hunk {
    type: HunkType;
    added: HunkNode;
    removed: HunkNode;
    /** The last note line the hunk covers. */
    vend: number;
}

/** SignType is a gutter sign's look. */
export type SignType = HunkType | "topdelete" | "changedelete";

/** Sign is the gutter sign of one note line (1-based). */
export interface Sign {
    type: SignType;
    /** Lines added/removed; set on a hunk's first line only. */
    count?: number;
    lnum: number;
}

/** createHunk builds a hunk from git-style old/new start and count. */
export function createHunk(
    oldStart: number,
    oldCount: number,
    newStart: number,
    newCount: number,
): Hunk {
    return {
        removed: { start: oldStart, count: oldCount, lines: [] },
        added: { start: newStart, count: newCount, lines: [] },
        vend: newStart + Math.max(newCount - 1, 0),
        type: newCount === 0 ? "delete" : oldCount === 0 ? "add" : "change",
    };
}

/** changeEnd is the last note line a hunk changes (as opposed to adds). */
function changeEnd(hunk: Hunk): number {
    if (hunk.added.count === 0) return hunk.added.start;
    if (hunk.removed.count === 0) {
        return hunk.added.start + hunk.added.count - 1;
    }
    return (
        hunk.added.start + Math.min(hunk.added.count, hunk.removed.count) - 1
    );
}

/** calcSigns returns the gutter signs of `hunk`, given its neighbours. */
export function calcSigns(
    prevHunk: Hunk | undefined,
    hunk: Hunk,
    nextHunk: Hunk | undefined,
    minLnum = 1,
    maxLnum = Number.POSITIVE_INFINITY,
): Sign[] {
    minLnum = Math.max(1, minLnum);
    const start = hunk.added.start;
    const added = hunk.added.count;
    const removed = hunk.removed.count;
    const cend = changeEnd(hunk);
    const topdelete =
        hunk.type === "delete" &&
        (start === 0 ||
            (prevHunk !== undefined && changeEnd(prevHunk) === start)) &&
        (nextHunk === undefined || nextHunk.added.start !== start + 1);
    if (topdelete && minLnum === 1) minLnum = 0;

    const signs: Sign[] = [];
    for (
        let lnum = Math.max(start, minLnum);
        lnum <= Math.min(cend, maxLnum);
        lnum++
    ) {
        const changedelete =
            hunk.type === "change" &&
            ((removed > added && lnum === cend) ||
                (prevHunk !== undefined && prevHunk.added.start === 0));
        const sign: Sign = {
            type: topdelete
                ? "topdelete"
                : changedelete
                  ? "changedelete"
                  : hunk.type,
            lnum: lnum + (topdelete ? 1 : 0),
        };
        if (lnum === start) sign.count = hunk.type === "add" ? added : removed;
        signs.push(sign);
    }
    if (
        hunk.type === "change" &&
        added > removed &&
        hunk.vend >= minLnum &&
        cend <= maxLnum
    ) {
        for (
            let lnum = Math.max(cend, minLnum);
            lnum <= Math.min(hunk.vend, maxLnum);
            lnum++
        ) {
            const sign: Sign = { type: "add", lnum };
            if (lnum === hunk.vend) sign.count = added - removed;
            signs.push(sign);
        }
    }
    return signs;
}

/** findHunk returns the hunk covering note line `lnum`, or undefined. */
export function findHunk(lnum: number, hunks: Hunk[]): Hunk | undefined {
    for (const hunk of hunks) {
        if (lnum === 1 && hunk.added.start === 0 && hunk.vend === 0) {
            return hunk;
        }
        if (hunk.added.start <= lnum && hunk.vend >= lnum) return hunk;
    }
    return undefined;
}

/** allSigns returns every hunk's signs, at most one per line, by line. */
export function allSigns(hunks: Hunk[]): Sign[] {
    const seen = new Set<number>();
    const out: Sign[] = [];
    hunks.forEach((hunk, i) => {
        for (const s of calcSigns(hunks[i - 1], hunk, hunks[i + 1])) {
            if (seen.has(s.lnum)) continue;
            seen.add(s.lnum);
            out.push(s);
        }
    });
    return out.sort((a, b) => a.lnum - b.lnum);
}
