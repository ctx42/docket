// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The last run as a folder tree: each streamed log row is read into one entry
// per note (what happened, its version, a short detail) and filed under its
// folder, the way the file explorer shows the vault. No obsidian dependency, so
// it unit-tests directly; sync-run.ts draws it.

import type { LogRow } from "./run-state.ts";

/** EntryKind is what a run did to one note. */
export type EntryKind =
    | "added"
    | "updated"
    | "moved"
    | "deleted"
    | "conflict"
    | "warn"
    | "err"
    | "unchanged"
    | "skipped";

/** RunEntry is one note's line in the run tree. */
export interface RunEntry {
    kind: EntryKind;
    /** The syncRoot-relative page name; a moved note's new name. */
    name: string;
    /** The name shown in the tree (see {@link entryLabel}). */
    label: string;
    /** A short note on what happened, or "". */
    detail: string;
    /** The page version the run wrote or pushed, or null. */
    version: number | null;
}

/** RunFolder is one folder of the run tree; chains of single folders are merged. */
export interface RunFolder {
    /** The folder's syncRoot-relative path; "" for the root. */
    path: string;
    /** The name shown in the tree: one folder, or a merged chain `a/b`. */
    name: string;
    /** The notes with a problem, drawn before the sub-folders. */
    lead: RunEntry[];
    folders: RunFolder[];
    /** The other notes, drawn after the sub-folders. */
    entries: RunEntry[];
    /** The number of entries in the folder and all folders under it. */
    total: number;
    /** Whether everything under the folder is a routine result. */
    quiet: boolean;
    /** Whether a conflict, warning, or failure sits in the folder or under it. */
    problem: boolean;
}

/** RunTree is a run's notes as a folder tree, plus rows about no single note. */
export interface RunTree {
    root: RunFolder;
    loose: LogRow[];
}

/** SMALL_RUN is the most notes a run may hold to open every folder at first. */
export const SMALL_RUN = 15;

/** ROUTINE are the kinds that need no look, so their folders start closed. */
const ROUTINE: ReadonlySet<EntryKind> = new Set([
    "updated",
    "unchanged",
    "skipped",
]);

/** PROBLEM are the kinds that need the user, so their folders sort first. */
const PROBLEM: ReadonlySet<EntryKind> = new Set(["conflict", "warn", "err"]);

/** entryLabel names a note by its file name without `.md`; a directory page by its directory. */
export function entryLabel(name: string): string {
    const parts = name.split("/");
    const file = parts.at(-1) ?? name;
    if (file === "_index.md" && parts.length > 1) return parts.at(-2) ?? file;
    return file.endsWith(".md") ? file.slice(0, -3) : file;
}

/** placeDir is the folder a note is filed under; a directory page sits beside its directory. */
function placeDir(name: string): string[] {
    const parts = name.split("/");
    parts.pop();
    if (name.endsWith("/_index.md")) parts.pop();
    return parts;
}

/** moveDetail says where a moved note came from: its old title, or its old folder. */
export function moveDetail(from: string, to: string): string {
    if (entryLabel(from) !== entryLabel(to)) return `was ${entryLabel(from)}`;
    const dir = placeDir(from);
    if (dir.length === 0) return "from the top folder";
    return `from ${dir.length > 2 ? "…/" : ""}${dir.slice(-2).join("/")}`;
}

/** entry builds a {@link RunEntry}. */
function entry(
    kind: EntryKind,
    name: string,
    detail: string,
    version: number | null,
): RunEntry {
    return { kind, name, label: entryLabel(name), detail, version };
}

/**
 * runEntry reads one log row into its note's entry, or null for a row about no
 * single note (a discovery line, an index warning, a continuation line). It
 * reads the pull lines (`added|updated|unchanged|conflict <name> (vN[, note])`,
 * `deleted`, `moving`, `removing stale`, per-note warnings), the push lines
 * (`pushing|creating <name> ... <result>` with indented continuation lines),
 * and outcome failures (`<name>: <reason>`, only for an `err` row).
 */
export function runEntry(row: LogRow): RunEntry | null {
    const [head = "", ...rest] = row.text.split("\n");
    if (/^\s/.test(head)) return null;
    let m = head.match(
        /^(added|updated|unchanged|conflict)\s+(.+?) \(v(\d+)(?:, (.+))?\)$/,
    );
    if (m !== null) {
        const kind = m[1] as EntryKind;
        return entry(kind, m[2] ?? "", m[4] ?? "", Number(m[3]));
    }
    m = head.match(/^deleted\s+(.+?) \((.+)\)$/);
    if (m !== null) return entry("deleted", m[1] ?? "", m[2] ?? "", null);
    m = head.match(/^moving (.+) -> (.+) \(page \d+ moved in Confluence\)$/);
    if (m !== null) {
        const from = m[1] ?? "";
        const to = m[2] ?? "";
        return entry("moved", to, moveDetail(from, to), null);
    }
    m = head.match(/^removing stale (.+) \(page \d+ is now (.+)\)$/);
    if (m !== null) {
        const detail = `stale copy, the page is now ${m[2]}`;
        return entry("deleted", m[1] ?? "", detail, null);
    }
    m = head.match(
        /^warning: (.+?\.md) and (.+?\.md) both hold unpushed edits for (.+)$/,
    );
    if (m !== null) {
        const detail = `${m[2]} also holds unpushed edits for ${m[3]}`;
        return entry("warn", m[1] ?? "", detail, null);
    }
    m = head.match(/^warning: (.+?\.md): (.+)$/);
    if (m !== null) return entry("warn", m[1] ?? "", m[2] ?? "", null);
    m = head.match(
        /^(pushing|creating) (.+?) \.\.\. (?:ok \(v(\d+)\)|(unchanged)|(skipped))$/,
    );
    if (m !== null) {
        const notes = rest.map((l) => l.trim()).filter((l) => l !== "");
        let kind: EntryKind =
            m[4] !== undefined
                ? "unchanged"
                : m[5] !== undefined
                  ? "skipped"
                  : m[1] === "creating"
                    ? "added"
                    : "updated";
        if (notes.some((l) => l.startsWith("warning:"))) kind = "warn";
        const version = m[3] === undefined ? null : Number(m[3]);
        return entry(kind, m[2] ?? "", notes.join("; "), version);
    }
    if (row.kind === "err") {
        m = head.match(/^(.+?): (.+)$/);
        if (m !== null) return entry("err", m[1] ?? "", m[2] ?? "", null);
    }
    return null;
}

/** Node is a folder while the tree is built, before chains are merged. */
interface Node {
    folders: Map<string, Node>;
    entries: RunEntry[];
}

/** byName orders names the way the file explorer does, numbers by value. */
function byName(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * finish turns a built node into a {@link RunFolder}, merging single-folder
 * chains. Problem notes lead, then sub-folders holding a problem, then the
 * other sub-folders, then the other notes, each by name.
 */
function finish(node: Node, path: string, name: string): RunFolder {
    let n = node;
    let p = path;
    let label = name;
    while (p !== "" && n.entries.length === 0 && n.folders.size === 1) {
        const first = [...n.folders][0];
        if (first === undefined) break;
        const [child, next] = first;
        n = next;
        p = `${p}/${child}`;
        label = `${label}/${child}`;
    }
    const folders = [...n.folders]
        .map(([k, v]) => finish(v, p === "" ? k : `${p}/${k}`, k))
        .sort(
            (a, b) =>
                Number(b.problem) - Number(a.problem) || byName(a.name, b.name),
        );
    const sorted = [...n.entries].sort((a, b) => byName(a.label, b.label));
    const lead = sorted.filter((e) => PROBLEM.has(e.kind));
    const entries = sorted.filter((e) => !PROBLEM.has(e.kind));
    return {
        path: p,
        name: label,
        lead,
        folders,
        entries,
        total:
            lead.length +
            entries.length +
            folders.reduce((s, f) => s + f.total, 0),
        quiet:
            lead.length === 0 &&
            entries.every((e) => ROUTINE.has(e.kind)) &&
            folders.every((f) => f.quiet),
        problem: lead.length > 0 || folders.some((f) => f.problem),
    };
}

/** runTree files a run's rows under their folders; rows about no single note stay apart. */
export function runTree(rows: readonly LogRow[]): RunTree {
    const root: Node = { folders: new Map(), entries: [] };
    const loose: LogRow[] = [];
    for (const row of rows) {
        const e = runEntry(row);
        if (e === null) {
            loose.push(row);
            continue;
        }
        let n = root;
        for (const dir of placeDir(e.name)) {
            let next = n.folders.get(dir);
            if (next === undefined) {
                next = { folders: new Map(), entries: [] };
                n.folders.set(dir, next);
            }
            n = next;
        }
        n.entries.push(e);
    }
    return { root: finish(root, "", ""), loose };
}

/**
 * RunFolds remembers which run-tree folders the user opened or closed. A folder
 * left alone is open unless it is quiet; in a small run every folder is open.
 */
export class RunFolds {
    private readonly open = new Map<string, boolean>();

    /** isOpen reports whether `f` shows its contents. */
    isOpen(f: RunFolder, small: boolean): boolean {
        return this.open.get(f.path) ?? (small || !f.quiet);
    }

    /** toggle opens a closed folder or closes an open one. */
    toggle(f: RunFolder, small: boolean): void {
        this.open.set(f.path, !this.isOpen(f, small));
    }

    /** setAll opens or closes `f` and every folder under it. */
    setAll(f: RunFolder, open: boolean): void {
        this.open.set(f.path, open);
        for (const sub of f.folders) this.setAll(sub, open);
    }
}
