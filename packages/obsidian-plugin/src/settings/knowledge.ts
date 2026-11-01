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

/** FRONT_RE matches a note's leading front matter block. */
const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** unquote strips one pair of matching YAML quotes from a scalar. */
function unquote(v: string): string {
    const t = v.trim();
    const q = t[0];
    return (q === '"' || q === "'") && t.endsWith(q) && t.length > 1
        ? t.slice(1, -1)
        : t;
}

/**
 * addSource returns the text of a `project-config.md` note with `name`
 * added to its front matter's `sources`, editing only those lines: appended
 * to a block list in its indent, to a flow list, a single value turned into
 * a flow list, or a new block list at the end of the front matter. It is
 * undefined when `name` is already listed, and throws for a note without
 * front matter.
 */
export function addSource(text: string, name: string): string | undefined {
    const m = FRONT_RE.exec(text);
    if (m === null) throw new Error("the config note has no front matter");
    const front = m[1] as string;
    const nl = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = front.split(/\r?\n/);
    const at = lines.findIndex((l) => /^sources:/.test(l));
    let next: string[];
    if (at < 0) {
        next = [...lines, "sources:", `  - ${name}`];
    } else {
        const rest = (lines[at] as string).slice("sources:".length).trim();
        if (rest === "") {
            let end = at + 1;
            let indent = "  ";
            const items: string[] = [];
            for (; end < lines.length; end++) {
                const item = /^(\s+)-\s*(.*)$/.exec(lines[end] as string);
                if (item === null) break;
                indent = item[1] as string;
                items.push(unquote(item[2] as string));
            }
            if (items.includes(name)) return undefined;
            next = [...lines];
            next.splice(end, 0, `${indent}- ${name}`);
        } else if (rest.startsWith("[") && rest.endsWith("]")) {
            const inner = rest.slice(1, -1).trim();
            const items = inner === "" ? [] : inner.split(",").map(unquote);
            if (items.includes(name)) return undefined;
            next = [...lines];
            next[at] =
                `sources: [${[...(inner === "" ? [] : [inner]), name].join(", ")}]`;
        } else {
            if (unquote(rest) === name) return undefined;
            next = [...lines];
            next[at] = `sources: [${rest}, ${name}]`;
        }
    }
    const start = m[0].indexOf(front);
    return (
        text.slice(0, start) + next.join(nl) + text.slice(start + front.length)
    );
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
