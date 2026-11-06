// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { DEFAULT_SETTINGS } from "@docket/core";
import { describe, expect, it } from "vitest";
import {
    type MoveFiles,
    movePages,
    syncSources,
    vaultFiles,
} from "../../src/ui/sync-move.ts";

/** fakeFiles is an in-memory MoveFiles over a set of vault paths. */
function fakeFiles(
    paths: string[],
    failOn = "",
): MoveFiles & { all(): string[] } {
    const set = new Set(paths);
    const under = (dir: string): string[] =>
        [...set].filter((p) => p.startsWith(`${dir}/`));
    return {
        all: () => [...set].sort(),
        exists: async (p) => set.has(p) || under(p).length > 0,
        mkdirs: async () => {},
        rename: async (from, to) => {
            if (from === failOn) throw new Error(`cannot move ${from}`);
            for (const p of [from, ...under(from)]) {
                if (!set.delete(p)) continue;
                set.add(`${to}${p.slice(from.length)}`);
            }
        },
        removeIfEmpty: async (p) => {
            if (under(p).some((c) => !c.endsWith("/"))) return false;
            set.delete(p);
            return true;
        },
    };
}

describe("syncSources", () => {
    it("lists the locations and docket's own folders", () => {
        const s = {
            ...DEFAULT_SETTINGS,
            pages: { "a.md": "/wiki/1" },
            folders: { team: "/wiki/2" },
            spaces: { docs: "/wiki/3" },
        };

        expect(syncSources(s)).toEqual([
            ".adf_cache",
            "_docket-media",
            "a.md",
            "docs",
            "team",
        ]);
    });

    it("drops a location inside another one", () => {
        const s = {
            ...DEFAULT_SETTINGS,
            pages: { "docs/a.md": "/wiki/1", "./b.md": "/wiki/2" },
            spaces: { "docs/": "/wiki/3" },
        };

        expect(syncSources(s)).toEqual([
            ".adf_cache",
            "_docket-media",
            "b.md",
            "docs",
        ]);
    });
});

describe("movePages", () => {
    const settings = {
        ...DEFAULT_SETTINGS,
        pages: { "srd/x/a.md": "/wiki/1", "missing.md": "/wiki/2" },
        spaces: { docs: "/wiki/3" },
    };

    it("moves what exists, keeping each path under the folder", async () => {
        // --- Given ---
        const files = fakeFiles([
            "srd/x/a.md",
            "docs/one.md",
            "_docket-media/i.png",
            "notes.md",
        ]);

        // --- When ---
        const have = await movePages(settings, "confluence", files);

        // --- Then ---
        expect(have).toBe(3);
        expect(files.all()).toEqual([
            "confluence/_docket-media/i.png",
            "confluence/docs/one.md",
            "confluence/srd/x/a.md",
            "notes.md",
        ]);
    });

    it("removes the folders the move emptied, keeping used ones", async () => {
        // --- Given ---
        const files = fakeFiles(["srd/x/a.md", "srd/x", "srd", "srd/keep.md"]);
        const removed: string[] = [];
        const remove = files.removeIfEmpty;
        files.removeIfEmpty = async (p) => {
            const gone = await remove(p);
            if (gone) removed.push(p);
            return gone;
        };

        // --- When ---
        await movePages(settings, "confluence", files);

        // --- Then ---
        expect(removed).toEqual(["srd/x"]);
        expect(files.all()).toContain("srd/keep.md");
    });

    it("refuses a target that already exists, moving nothing", async () => {
        // --- Given ---
        const want = ["confluence/docs/one.md", "docs/one.md", "srd/x/a.md"];
        const files = fakeFiles(want);

        // --- When ---
        const have = movePages(settings, "confluence", files);

        // --- Then ---
        await expect(have).rejects.toThrow('"confluence/docs" already exists');
        expect(files.all()).toEqual(want);
    });

    it("refuses a folder that holds a location", async () => {
        // --- Given ---
        const files = fakeFiles(["docs/one.md"]);

        // --- When ---
        const have = movePages(settings, "docs", files);

        // --- Then ---
        await expect(have).rejects.toThrow('"docs" holds synced pages');
        expect(files.all()).toEqual(["docs/one.md"]);
    });

    it("refuses a location at the vault root", async () => {
        // --- Given ---
        const s = { ...DEFAULT_SETTINGS, spaces: { ".": "/wiki/1" } };

        // --- When ---
        const have = movePages(s, "confluence", fakeFiles(["a.md"]));

        // --- Then ---
        await expect(have).rejects.toThrow("vault root");
    });

    it("puts everything back when a move fails", async () => {
        // --- Given ---
        const want = ["_docket-media/i.png", "docs/one.md", "srd/x/a.md"];
        const files = fakeFiles(want, "srd/x/a.md");

        // --- When ---
        const have = movePages(settings, "confluence", files);

        // --- Then ---
        await expect(have).rejects.toThrow("cannot move srd/x/a.md");
        expect(files.all()).toEqual(want);
    });

    it("names what a failed undo left in the folder", async () => {
        // --- Given ---
        const files = fakeFiles(["docs/one.md", "srd/x/a.md"], "srd/x/a.md");
        const rename = files.rename;
        files.rename = async (from, to) => {
            if (from.startsWith("confluence/")) throw new Error("locked");
            await rename(from, to);
        };

        // --- When ---
        const have = movePages(settings, "confluence", files);

        // --- Then ---
        await expect(have).rejects.toThrow(
            'cannot move srd/x/a.md; left in "confluence": docs',
        );
    });
});

describe("vaultFiles", () => {
    /** fakeVault records the calls vaultFiles makes on a vault. */
    function fakeVault(
        known: string[],
        listing = { files: [""], folders: [""] },
    ) {
        const calls: string[] = [];
        const vault = {
            getAbstractFileByPath: (p: string) =>
                known.includes(p) ? ({ path: p } as never) : null,
            createFolder: async (p: string) => {
                calls.push(`createFolder ${p}`);
                return {} as never;
            },
            rename: async (f: { path: string }, to: string) => {
                calls.push(`vault.rename ${f.path} ${to}`);
            },
            adapter: {
                exists: async (p: string) => known.includes(p),
                list: async () => listing,
                rename: async (from: string, to: string) => {
                    calls.push(`adapter.rename ${from} ${to}`);
                },
                rmdir: async (p: string) => {
                    calls.push(`rmdir ${p}`);
                },
            },
        };
        return { vault, calls };
    }

    it("creates only the missing folders of a path", async () => {
        // --- Given ---
        const { vault, calls } = fakeVault(["confluence"]);

        // --- When ---
        await vaultFiles(vault).mkdirs("confluence/srd/x");

        // --- Then ---
        expect(calls).toEqual([
            "createFolder confluence/srd",
            "createFolder confluence/srd/x",
        ]);
    });

    it("renames a known file through the vault", async () => {
        // --- Given ---
        const { vault, calls } = fakeVault(["a.md"]);

        // --- When ---
        await vaultFiles(vault).rename("a.md", "c/a.md");

        // --- Then ---
        expect(calls).toEqual(["vault.rename a.md c/a.md"]);
    });

    it("renames a hidden folder through the adapter", async () => {
        // --- Given ---
        const { vault, calls } = fakeVault([]);

        // --- When ---
        await vaultFiles(vault).rename(".adf_cache", "c/.adf_cache");

        // --- Then ---
        expect(calls).toEqual(["adapter.rename .adf_cache c/.adf_cache"]);
    });

    it("reads existence from the disk", async () => {
        // --- Given ---
        const { vault } = fakeVault([".adf_cache"]);

        // --- When ---
        const have = await vaultFiles(vault).exists(".adf_cache");

        // --- Then ---
        expect(have).toBe(true);
    });

    it("removes only an empty folder", async () => {
        // --- Given ---
        const empty = fakeVault([], { files: [], folders: [] });
        const used = fakeVault([], { files: ["d/a.md"], folders: [] });

        // --- When ---
        const hEmpty = await vaultFiles(empty.vault).removeIfEmpty("d");
        const hUsed = await vaultFiles(used.vault).removeIfEmpty("d");

        // --- Then ---
        expect(hEmpty).toBe(true);
        expect(empty.calls).toEqual(["rmdir d"]);
        expect(hUsed).toBe(false);
        expect(used.calls).toEqual([]);
    });
});
