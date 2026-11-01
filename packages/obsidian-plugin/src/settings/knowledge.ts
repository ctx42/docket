// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// What the settings tab needs to add a knowledge base, beyond the core model:
// adding its folder to the doc server's `sources`, the folder names already
// in use, the folders a local one can use, and plain-language advice for a failed clone or pull. Pure — no
// Obsidian runtime — so it unit-tests; the dialog and card are DOM glue.

import {
    type CloneInfo,
    type docketSettings,
    GitNotFoundError,
    RemoteError,
    syncFolder,
} from "@docket/core";
import { ASSETS_DIR } from "../runtime-dirs.ts";

/**
 * addSource adds `name` to the `sources` list of a `project-config.md` front
 * matter object, in place: appended to a list, a single string turned into a
 * list, or a new list. It returns whether it changed anything.
 */
export function addSource(fm: Record<string, unknown>, name: string): boolean {
    const raw = fm["sources"];
    const list = Array.isArray(raw)
        ? [...raw]
        : typeof raw === "string"
          ? [raw]
          : [];
    if (list.includes(name)) return false;
    fm["sources"] = [...list, name];
    return true;
}

/**
 * takenNames is every top-level name a new knowledge base folder cannot use:
 * the vault's top-level files and folders `topLevel`, the sync folder, and the
 * knowledge bases already set up.
 */
export function takenNames(
    s: docketSettings,
    topLevel: readonly string[],
): Set<string> {
    const taken = new Set(topLevel);
    const folder = syncFolder(s.syncRoot);
    if (folder !== "") taken.add(folder);
    for (const kb of s.knowledgeBases) taken.add(kb.name);
    return taken;
}

/**
 * localFolderChoices lists the top-level vault folders `topFolders` that can
 * become a local knowledge base, sorted: not hidden, not the shared media
 * folder, not the sync folder, and not a knowledge base already.
 */
export function localFolderChoices(
    topFolders: readonly string[],
    s: docketSettings,
): string[] {
    const used = new Set(s.knowledgeBases.map((kb) => kb.name));
    const folder = syncFolder(s.syncRoot);
    return topFolders
        .filter(
            (n) =>
                !n.startsWith(".") &&
                n !== ASSETS_DIR &&
                n !== folder &&
                !used.has(n),
        )
        .sort((a, b) => a.localeCompare(b));
}

/**
 * LocalFolderPlan is how a folder picked as a local knowledge base is added:
 * as a local folder, as a git knowledge base (it is its own clone with a
 * remote), or not at all (it is its own repository without a remote).
 */
export type LocalFolderPlan =
    | { kind: "folder" }
    | { kind: "git"; url: string; branch: string }
    | { kind: "refuse"; reason: string };

/**
 * localFolderPlan decides how to add the folder `name`; `clone` is what its
 * own repository says, or undefined when it has none. A folder inside the
 * vault repository that is itself a repository would be committed as a bare
 * pointer to its own commit, so a clone with a remote becomes a git knowledge
 * base, kept out of the vault repository, and one without a remote is refused.
 */
export function localFolderPlan(
    name: string,
    clone: CloneInfo | undefined,
): LocalFolderPlan {
    if (clone === undefined) return { kind: "folder" };
    if (clone.url !== "") {
        return { kind: "git", url: clone.url, branch: clone.branch };
    }
    return {
        kind: "refuse",
        reason:
            `${name} is its own git repository without a remote. The vault ` +
            "repository would store only a pointer to it. Add a remote to " +
            "it, or remove its .git folder, then add it again.",
    };
}

/** ADVICE is what to tell the user for each remote problem docket can name. */
const ADVICE: Record<string, string> = {
    auth:
        "Your SSH key was not accepted. Add your public key to your account " +
        "on the git host, or check that the SSH agent is running.",
    "host-key":
        "The server's host key is unknown or has changed. Connect once with " +
        "ssh in a terminal to accept it, then try again.",
    "not-found": "No repository at this URL, or your account cannot see it.",
    network:
        "The git host cannot be reached. Check the network and the host name.",
};

/**
 * remoteAdvice turns a failed clone, pull, or branch listing into a sentence
 * for the user: advice for a {@link RemoteError} docket can name, a pointer to
 * the Git path when git is missing, else the error's own message.
 */
export function remoteAdvice(err: unknown): string {
    if (err instanceof RemoteError) return ADVICE[err.problem] ?? err.message;
    if (err instanceof GitNotFoundError) {
        return "git was not found. Set the Git path in the Git section below.";
    }
    return err instanceof Error ? err.message : String(err);
}
