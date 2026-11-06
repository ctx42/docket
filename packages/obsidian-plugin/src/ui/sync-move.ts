// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Moves the pages of a vault that syncs into its root into a new sync folder.
// A location's destination is relative to the sync root, so it stays the same
// after the move, and so do the cache entries named after it. Links between
// notes are relative and move as one, which is why the notes are renamed
// without Obsidian's link updates: a rewritten link would read as a local edit.
// Only type imports of `obsidian` here, so the module unit-tests.

import { posixClean, posixDir, posixJoin } from "@docket/core";
import type { DataAdapter, Vault } from "obsidian";
import { ASSETS_DIR, CACHE_DIR } from "../runtime-dirs.ts";
import type { docketSettings } from "../settings/model.ts";

/** MoveFiles is the file access a move needs. */
export interface MoveFiles {
    /** exists reports whether the file or folder is on disk. */
    exists(path: string): Promise<boolean>;
    /** mkdirs creates the folder and any missing parent. */
    mkdirs(path: string): Promise<void>;
    /** rename moves a file or folder; the target's parent exists. */
    rename(from: string, to: string): Promise<void>;
    /** removeIfEmpty deletes an empty folder and reports whether it did. */
    removeIfEmpty(path: string): Promise<boolean>;
}

/** MoveVault is the part of Obsidian's vault {@link vaultFiles} uses. */
export type MoveVault = Pick<
    Vault,
    "getAbstractFileByPath" | "createFolder" | "rename"
> & {
    adapter: Pick<DataAdapter, "exists" | "list" | "rename" | "rmdir">;
};

/** vaultFiles is {@link MoveFiles} over an Obsidian vault. */
export function vaultFiles(vault: MoveVault): MoveFiles {
    return {
        exists: (path) => vault.adapter.exists(path),
        mkdirs: async (path) => {
            let dir = "";
            for (const part of path.split("/")) {
                dir = dir === "" ? part : `${dir}/${part}`;
                if (vault.getAbstractFileByPath(dir) === null) {
                    await vault.createFolder(dir);
                }
            }
        },
        rename: async (from, to) => {
            // Obsidian does not track a hidden folder such as the cache.
            const file = vault.getAbstractFileByPath(from);
            if (file === null) await vault.adapter.rename(from, to);
            else await vault.rename(file, to);
        },
        removeIfEmpty: async (path) => {
            const { files, folders } = await vault.adapter.list(path);
            if (files.length > 0 || folders.length > 0) return false;
            await vault.adapter.rmdir(path, false);
            return true;
        },
    };
}

/**
 * syncSources returns the vault paths a move takes along, sorted: every
 * location that is not inside another one, the shared images, and the cache.
 */
export function syncSources(s: docketSettings): string[] {
    const paths = new Set(
        [
            ...Object.keys(s.pages),
            ...Object.keys(s.folders),
            ...Object.keys(s.spaces),
            ASSETS_DIR,
            CACHE_DIR,
        ].map(posixClean),
    );
    return [...paths]
        .filter((p) => ![...paths].some((o) => p.startsWith(`${o}/`)))
        .sort();
}

/**
 * movePages moves the sources on disk into `folder` and returns how many it
 * moved. It checks every source before the first move, and throws with nothing
 * moved when a location is the vault root, sits in `folder`, or would overwrite
 * a file. When a move fails it moves the finished ones back and throws, naming
 * any that stayed in `folder`. Folders the move emptied are removed.
 */
export async function movePages(
    s: docketSettings,
    folder: string,
    files: MoveFiles,
): Promise<number> {
    const sources: string[] = [];
    for (const src of syncSources(s)) {
        if (src === ".") throw new Error("a location is the vault root");
        if (await files.exists(src)) sources.push(src);
    }
    for (const src of sources) {
        if (src === folder || src.startsWith(`${folder}/`)) {
            throw new Error(`"${folder}" holds synced pages; choose another`);
        }
        const to = posixJoin(folder, src);
        if (await files.exists(to)) throw new Error(`"${to}" already exists`);
    }

    const done: string[] = [];
    try {
        for (const src of sources) {
            const to = posixJoin(folder, src);
            await files.mkdirs(posixDir(to));
            await files.rename(src, to);
            done.push(src);
        }
    } catch (err) {
        const left = await undoMoves(done, folder, files);
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
            left.length === 0
                ? reason
                : `${reason}; left in "${folder}": ${left.join(", ")}`,
        );
    }

    for (const src of sources) {
        let dir = posixDir(src);
        while (dir !== "." && (await files.removeIfEmpty(dir))) {
            dir = posixDir(dir);
        }
    }
    return sources.length;
}

/** undoMoves moves `done` back out of `folder` and returns those that stayed. */
async function undoMoves(
    done: string[],
    folder: string,
    files: MoveFiles,
): Promise<string[]> {
    const left: string[] = [];
    for (const src of [...done].reverse()) {
        try {
            await files.rename(posixJoin(folder, src), src);
        } catch {
            left.push(src);
        }
    }
    return left;
}
