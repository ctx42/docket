// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The working-tree change list, read from `git status --porcelain=v2 -z`. Every
// change is described HEAD → working tree, because a docket commit takes whole
// working-tree files (see `GitRepo.commit`): what sits in the index only decides
// the `staged` badge. git pairs renames only when they are staged, so a note
// moved in Obsidian arrives as a deleted path plus an untracked one;
// {@link pairMoves} rejoins those into one rename.

import { posixBase } from "../util/path.ts";

/** ChangeKind is a change's type: modified, added, deleted, or renamed. */
export type ChangeKind = "M" | "A" | "D" | "R";

/** KIND_TEXT names each change kind for display. */
export const KIND_TEXT: Record<ChangeKind, string> = {
    M: "modified",
    A: "added",
    D: "deleted",
    R: "renamed",
};

/** GitChange is one changed path, HEAD → working tree. */
export interface GitChange {
    /** The vault-relative path (the new path of a rename). */
    path: string;
    /** A rename's old path, or `""`. */
    from: string;
    kind: ChangeKind;
    /** Whether the index already differs from HEAD for this path. */
    staged: boolean;
    /**
     * Whether the index already drops the path while its file stays on disk
     * (`git rm --cached`): committing it records the removal.
     */
    untracking: boolean;
}

/** StatusEntry is a parsed porcelain line plus the blob ids pairing needs. */
export interface StatusEntry extends GitChange {
    /** The HEAD and index blob ids (`""` when absent). */
    headId: string;
    indexId: string;
    /** Whether HEAD's file is gone from disk while the index still holds it. */
    missing: boolean;
}

/** ZERO_ID is git's all-zero object id, used for "no such blob". */
const ZERO_ID = /^0+$/;

/**
 * parseStatus parses `git status --porcelain=v2 -z` output. An untracked path the
 * index already drops (`D` staged) is folded into that removal, so each path
 * appears once.
 */
export function parseStatus(out: string): StatusEntry[] {
    const fields = out.split("\0");
    const entries: StatusEntry[] = [];
    for (let i = 0; i < fields.length; i++) {
        const line = fields[i] ?? "";
        if (line === "" || line.startsWith("#")) continue;
        const tag = line[0];
        if (tag === "?") {
            entries.push(entry(line.slice(2), "A", false));
            continue;
        }
        if (tag === "1") {
            const p = split(line, 8);
            entries.push(ordinary(p[1] ?? "..", p[6] ?? "", p[7] ?? "", p[8]));
            continue;
        }
        if (tag === "2") {
            const p = split(line, 9);
            const e = entry(p[9] ?? "", "R", true);
            e.from = fields[++i] ?? "";
            e.headId = id(p[6]);
            e.indexId = id(p[7]);
            if ((p[1] ?? "")[1] === "D") e.kind = "D";
            entries.push(e);
            continue;
        }
        if (tag === "u") {
            entries.push(entry(split(line, 10)[10] ?? "", "M", true));
        }
    }
    const removed = new Set(
        entries.filter((e) => e.untracking).map((e) => e.path),
    );
    return entries.filter((e) => !(e.kind === "A" && removed.has(e.path)));
}

/** ordinary builds the entry of a `1` line from its XY and blob ids. */
function ordinary(
    xy: string,
    headId: string,
    indexId: string,
    path = "",
): StatusEntry {
    const x = xy[0] ?? ".";
    const y = xy[1] ?? ".";
    const inHead = x !== "A" && y !== "A";
    const onDisk = y !== "D" && x !== "D";
    const kind: ChangeKind = !inHead ? "A" : !onDisk ? "D" : "M";
    const e = entry(path, kind, x !== ".");
    e.headId = id(headId);
    e.indexId = id(indexId);
    e.untracking = x === "D";
    e.missing = inHead && x !== "D" && y === "D";
    return e;
}

/** entry builds a bare {@link StatusEntry}. */
function entry(path: string, kind: ChangeKind, staged: boolean): StatusEntry {
    return {
        path,
        from: "",
        kind,
        staged,
        untracking: false,
        headId: "",
        indexId: "",
        missing: false,
    };
}

/** id normalizes a blob id, mapping git's all-zero id to `""`. */
function id(s: string | undefined): string {
    return s === undefined || ZERO_ID.test(s) ? "" : s;
}

/**
 * split splits a porcelain line into `n` space-separated fields plus the rest,
 * which is the path and may itself hold spaces.
 */
function split(line: string, n: number): string[] {
    const out: string[] = [];
    let at = 0;
    for (let k = 0; k < n; k++) {
        const sp = line.indexOf(" ", at);
        if (sp < 0) break;
        out.push(line.slice(at, sp));
        at = sp + 1;
    }
    out.push(line.slice(at));
    return out;
}

/**
 * moveCandidates returns the untracked paths worth hashing for
 * {@link pairMoves}: all of them when some tracked file went missing, none
 * otherwise.
 */
export function moveCandidates(entries: StatusEntry[]): string[] {
    if (!entries.some((e) => e.missing)) return [];
    return entries
        .filter((e) => e.kind === "A" && !e.staged)
        .map((e) => e.path);
}

/**
 * pairMoves joins a missing tracked file and an untracked one into a rename:
 * first by identical content (`ids` maps an untracked path to its blob id),
 * then by a file name both sides hold exactly once. Everything else passes
 * through unchanged.
 */
export function pairMoves(
    entries: StatusEntry[],
    ids: ReadonlyMap<string, string>,
): GitChange[] {
    const gone = entries.filter((e) => e.missing);
    const fresh = entries.filter((e) => e.kind === "A" && !e.staged);
    const pairs = new Map<StatusEntry, StatusEntry>(); // fresh → gone
    const used = new Set<StatusEntry>();
    for (const f of fresh) {
        const blob = ids.get(f.path) ?? "";
        if (blob === "") continue;
        const g = gone.find(
            (c) => !used.has(c) && (c.headId === blob || c.indexId === blob),
        );
        if (g === undefined) continue;
        pairs.set(f, g);
        used.add(g);
    }
    const byName = <T extends StatusEntry>(list: T[]): Map<string, T[]> => {
        const m = new Map<string, T[]>();
        for (const e of list) {
            const k = posixBase(e.path);
            m.set(k, [...(m.get(k) ?? []), e]);
        }
        return m;
    };
    const goneByName = byName(gone.filter((g) => !used.has(g)));
    const freshByName = byName(fresh.filter((f) => !pairs.has(f)));
    for (const [name, fs] of freshByName) {
        const gs = goneByName.get(name) ?? [];
        const f = fs[0];
        const g = gs[0];
        if (fs.length !== 1 || gs.length !== 1 || !f || !g) continue;
        pairs.set(f, g);
        used.add(g);
    }
    const out: GitChange[] = [];
    for (const e of entries) {
        if (used.has(e)) continue;
        const g = pairs.get(e);
        out.push(
            g === undefined
                ? change(e)
                : {
                      path: e.path,
                      from: g.path,
                      kind: "R",
                      staged: g.staged,
                      untracking: false,
                  },
        );
    }
    return out;
}

/** change strips a {@link StatusEntry} down to its {@link GitChange}. */
function change(e: StatusEntry): GitChange {
    return {
        path: e.path,
        from: e.from,
        kind: e.kind,
        staged: e.staged,
        untracking: e.untracking,
    };
}
