// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// What a note's change bars compare against — git HEAD, the Confluence page,
// or a commit picked in History — and the hover popup's title for each. Pure,
// so it carries no Obsidian import.

import { logTime } from "@docket/core";
import type { Hunk } from "./hunks.ts";

/** BaseSource is what the base text is. */
export type BaseSource =
    | { kind: "head" }
    | { kind: "confluence" }
    | { kind: "commit"; at: number };

/** HEAD is the default base source. */
export const HEAD: BaseSource = { kind: "head" };

/** sameSource reports whether `a` and `b` name the same base. */
export function sameSource(a: BaseSource, b: BaseSource): boolean {
    if (a.kind === "commit") return b.kind === "commit" && a.at === b.at;
    return a.kind === b.kind;
}

/** TITLES titles a popup by hunk type, for HEAD and Confluence bases. */
const TITLES: Record<"head" | "confluence", Record<Hunk["type"], string>> = {
    head: {
        add: "Added since the last commit",
        delete: "Deleted since the last commit",
        change: "Changed since the last commit",
    },
    confluence: {
        add: "Not on Confluence",
        delete: "Only on Confluence",
        change: "Differs from Confluence",
    },
};

/** VERBS lead a popup's title against a commit, by hunk type. */
const VERBS: Record<Hunk["type"], string> = {
    add: "Added",
    delete: "Deleted",
    change: "Changed",
};

/** popupTitle titles the popup of a hunk of `type` against `src`. */
export function popupTitle(src: BaseSource, type: Hunk["type"]): string {
    if (src.kind === "commit") return `${VERBS[type]} since ${logTime(src.at)}`;
    return TITLES[src.kind][type];
}
