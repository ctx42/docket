// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { LogRow } from "../../src/ui/run-state.ts";
import {
    entryLabel,
    moveDetail,
    type RunEntry,
    type RunFolder,
    RunFolds,
    runEntry,
    runTree,
    SMALL_RUN,
} from "../../src/ui/run-tree.ts";

/** row builds a log row the way PanelReporter stores it. */
function row(text: string, kind: LogRow["kind"] = "info"): LogRow {
    return { text, kind };
}

/** folderAt walks `root` down the folder names in `names`. */
function folderAt(root: RunFolder, ...names: string[]): RunFolder {
    let f = root;
    for (const n of names) {
        const next = f.folders.find((x) => x.name === n);
        if (next === undefined) throw new Error(`no folder ${n} in ${f.path}`);
        f = next;
    }
    return f;
}

describe("runEntry", () => {
    it("reads a pull line with its version", () => {
        const have = runEntry(row("added     docs/guide.md (v3)", "added"));
        const want: RunEntry = {
            kind: "added",
            name: "docs/guide.md",
            label: "guide",
            detail: "",
            version: 3,
        };
        expect(have).toEqual(want);
    });

    it("keeps the nuance after the version as the detail", () => {
        const have = runEntry(
            row("updated   a/b.md (v28, re-rendered from cache)", "updated"),
        );
        expect(have?.kind).toBe("updated");
        expect(have?.version).toBe(28);
        expect(have?.detail).toBe("re-rendered from cache");
    });

    it("reads a conflict line", () => {
        const have = runEntry(
            row(
                "conflict  a/x.md (v5, resolve markers before pushing)",
                "conflict",
            ),
        );
        expect(have?.kind).toBe("conflict");
        expect(have?.detail).toBe("resolve markers before pushing");
    });

    it("reads a deleted line, which has no version", () => {
        const have = runEntry(
            row("deleted   a/gone.md (removed from Confluence)", "deleted"),
        );
        expect(have).toEqual({
            kind: "deleted",
            name: "a/gone.md",
            label: "gone",
            detail: "removed from Confluence",
            version: null,
        });
    });

    it("files a move under its new path", () => {
        const have = runEntry(
            row(
                "moving m/leak.md -> m/leak/leak.md (page 22 moved in Confluence)",
            ),
        );
        expect(have).toEqual({
            kind: "moved",
            name: "m/leak/leak.md",
            label: "leak",
            detail: "from m",
            version: null,
        });
    });

    it("reads a stale copy removal as a deletion", () => {
        const have = runEntry(
            row("removing stale a/old.md (page 7 is now b/new.md)"),
        );
        expect(have?.kind).toBe("deleted");
        expect(have?.name).toBe("a/old.md");
        expect(have?.detail).toBe("stale copy, the page is now b/new.md");
    });

    it("reads a warning about one note", () => {
        const have = runEntry(
            row(
                "warning: a/n.md: page removed from Confluence but note has unpushed edits; kept",
                "warn",
            ),
        );
        expect(have?.kind).toBe("warn");
        expect(have?.name).toBe("a/n.md");
        expect(have?.detail).toBe(
            "page removed from Confluence but note has unpushed edits; kept",
        );
    });

    it("reads a warning about two copies of a moved page", () => {
        const have = runEntry(
            row(
                "warning: a/x.md and b/x.md both hold unpushed edits for page 9; left in place, resolve by hand",
                "warn",
            ),
        );
        expect(have?.name).toBe("a/x.md");
        expect(have?.detail).toBe(
            "b/x.md also holds unpushed edits for page 9; left in place, resolve by hand",
        );
    });

    it("reads push and create lines", () => {
        expect(runEntry(row("pushing t/x.md ... ok (v4)"))).toEqual({
            kind: "updated",
            name: "t/x.md",
            label: "x",
            detail: "",
            version: 4,
        });
        expect(runEntry(row("pushing t/x.md ... unchanged"))?.kind).toBe(
            "unchanged",
        );
        expect(runEntry(row("creating t/y.md ... ok (v1)"))?.kind).toBe(
            "added",
        );
        expect(runEntry(row("creating t/y.md ... skipped"))?.kind).toBe(
            "skipped",
        );
    });

    it("turns a push's continuation lines into the detail", () => {
        const have = runEntry(
            row(
                'creating t/y.md ... ok (v1)\n      reused existing folder "Team"\n      warning: title trimmed',
            ),
        );
        expect(have?.kind).toBe("warn");
        expect(have?.version).toBe(1);
        expect(have?.detail).toBe(
            'reused existing folder "Team"; warning: title trimmed',
        );
    });

    it("reads an outcome failure row", () => {
        const have = runEntry(row("t/x.md: remote moved", "err"));
        expect(have?.kind).toBe("err");
        expect(have?.name).toBe("t/x.md");
        expect(have?.detail).toBe("remote moved");
    });

    it("returns null for a line about no single note", () => {
        expect(
            runEntry(row("discovering folder docs to resolve x")),
        ).toBeNull();
        expect(
            runEntry(
                row(
                    "warning: link index merged with the previous one: x",
                    "warn",
                ),
            ),
        ).toBeNull();
        expect(
            runEntry(row("      warning: left in place", "warn")),
        ).toBeNull();
    });
});

describe("entryLabel", () => {
    it("drops the .md extension", () => {
        expect(entryLabel("a/b/Weekly log.md")).toBe("Weekly log");
    });

    it("names a directory page after its directory", () => {
        expect(entryLabel("a/b/_index.md")).toBe("b");
    });

    it("keeps a name without the .md extension", () => {
        expect(entryLabel("API Ref")).toBe("API Ref");
    });
});

describe("moveDetail", () => {
    it("names the old title of a renamed page", () => {
        expect(moveDetail("r/contact_support.md", "r/contact_us.md")).toBe(
            "was contact_support",
        );
    });

    it("names the old folder, keeping its last two parts", () => {
        expect(moveDetail("a/b/c/d.md", "a/b/x/d.md")).toBe("from …/b/c");
    });

    it("names a top-level old folder", () => {
        expect(moveDetail("d.md", "a/d.md")).toBe("from the top folder");
    });
});

describe("runTree", () => {
    it("files entries under their folders, folders first, by name", () => {
        const have = runTree([
            row("updated   z.md (v1)", "updated"),
            row("updated   b/y.md (v1)", "updated"),
            row("updated   a/x.md (v1)", "updated"),
            row("updated   b/w.md (v1)", "updated"),
        ]);
        expect(have.root.folders.map((f) => f.name)).toEqual(["a", "b"]);
        expect(have.root.entries.map((e) => e.label)).toEqual(["z"]);
        expect(folderAt(have.root, "b").entries.map((e) => e.label)).toEqual([
            "w",
            "y",
        ]);
        expect(have.root.total).toBe(4);
        expect(folderAt(have.root, "b").total).toBe(2);
    });

    it("puts folders holding a problem first, at every level", () => {
        const have = runTree([
            row("updated   a/x.md (v1)", "updated"),
            row("updated   b/x.md (v1)", "updated"),
            row(
                "conflict  z/x.md (v2, resolve markers before pushing)",
                "conflict",
            ),
            row("updated   m/a/x.md (v1)", "updated"),
            row("m/b/x.md: remote moved", "err"),
            row("added     n/x.md (v1)", "added"),
        ]);
        expect(have.root.folders.map((f) => f.name)).toEqual([
            "m",
            "z",
            "a",
            "b",
            "n",
        ]);
        expect(folderAt(have.root, "m").folders.map((f) => f.name)).toEqual([
            "b",
            "a",
        ]);
    });

    it("puts a folder's problem notes before its sub-folders", () => {
        const have = runTree([
            row("updated   a/sub/x.md (v1)", "updated"),
            row("updated   a/b.md (v1)", "updated"),
            row("warning: a/z.md: page removed; kept", "warn"),
        ]);
        const a = folderAt(have.root, "a");
        expect(a.lead.map((e) => e.label)).toEqual(["z"]);
        expect(a.entries.map((e) => e.label)).toEqual(["b"]);
    });

    it("merges a chain of single folders into one row", () => {
        const have = runTree([
            row("updated   doc/user_docs/manual/a.md (v1)", "updated"),
            row("updated   doc/user_docs/manual/sub/b.md (v1)", "updated"),
        ]);
        const merged = folderAt(have.root, "doc/user_docs/manual");
        expect(merged.path).toBe("doc/user_docs/manual");
        expect(folderAt(merged, "sub").path).toBe("doc/user_docs/manual/sub");
    });

    it("files a directory page beside its directory", () => {
        const have = runTree([
            row("updated   a/b/_index.md (v1)", "updated"),
            row("updated   a/b/c.md (v1)", "updated"),
            row("updated   a/d.md (v1)", "updated"),
        ]);
        const a = folderAt(have.root, "a");
        expect(a.entries.map((e) => e.label)).toEqual(["b", "d"]);
        expect(folderAt(a, "b").entries.map((e) => e.label)).toEqual(["c"]);
    });

    it("marks a folder quiet when it holds only routine results", () => {
        const have = runTree([
            row("updated   a/x.md (v1)", "updated"),
            row("pushing a/y.md ... unchanged"),
            row("added     b/c/new.md (v1)", "added"),
            row("updated   b/d/x.md (v1)", "updated"),
        ]);
        expect(folderAt(have.root, "a").quiet).toBe(true);
        expect(folderAt(have.root, "b").quiet).toBe(false);
        expect(folderAt(have.root, "b", "c").quiet).toBe(false);
        expect(folderAt(have.root, "b", "d").quiet).toBe(true);
    });

    it("keeps lines about no single note apart, in order", () => {
        const loose = row("discovering folder docs to resolve x");
        const have = runTree([loose, row("added     a.md (v1)", "added")]);
        expect(have.loose).toEqual([loose]);
        expect(have.root.total).toBe(1);
    });
});

describe("RunFolds", () => {
    const tree = runTree([
        row("added     a/b/new.md (v1)", "added"),
        row("updated   a/c/x.md (v1)", "updated"),
        row("updated   a/c/d/y.md (v1)", "updated"),
    ]).root;
    const a = folderAt(tree, "a");
    const c = folderAt(a, "c");
    const d = folderAt(c, "d");

    it("opens a folder by default unless it is quiet", () => {
        const folds = new RunFolds();
        expect(folds.isOpen(a, false)).toBe(true);
        expect(folds.isOpen(c, false)).toBe(false);
    });

    it("opens every folder of a small run", () => {
        expect(new RunFolds().isOpen(c, true)).toBe(true);
    });

    it("toggle flips one folder and remembers it", () => {
        const folds = new RunFolds();
        folds.toggle(c, false);
        expect(folds.isOpen(c, false)).toBe(true);
        expect(folds.isOpen(d, false)).toBe(false);
        folds.toggle(c, false);
        expect(folds.isOpen(c, false)).toBe(false);
    });

    it("setAll opens or closes a folder and everything under it", () => {
        const folds = new RunFolds();
        folds.setAll(c, true);
        expect(folds.isOpen(c, false)).toBe(true);
        expect(folds.isOpen(d, false)).toBe(true);
        folds.setAll(a, false);
        expect(folds.isOpen(a, false)).toBe(false);
        expect(folds.isOpen(c, false)).toBe(false);
        expect(folds.isOpen(d, false)).toBe(false);
    });

    it("a small run is one that fits on screen", () => {
        expect(SMALL_RUN).toBeGreaterThan(0);
    });
});
