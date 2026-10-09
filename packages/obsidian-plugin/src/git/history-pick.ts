// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Picking a History row in Note mode: whether its rows can be picked, and the
// pick a click makes. Pure, so it carries no Obsidian import; history-tab.ts
// draws the rows and ui/bar-base.ts holds the pick.

import type { LogEntry } from "@docket/core";
import type { CommitPick } from "../ui/bar-base.ts";

/** BARS_OFF says why rows cannot be picked while the change bars are off. */
export const BARS_OFF = "Turn on the change bars to compare with a commit";

/** NOT_MARKDOWN says why a file's rows cannot be picked. */
export const NOT_MARKDOWN =
    "Only a Markdown note can be compared with a commit";

/**
 * pickBlock is why the rows of the note at `note` cannot be picked, or null
 * when they can: the change bars must be on and the note Markdown.
 */
export function pickBlock(bars: boolean, note: string): string | null {
    if (!bars) return BARS_OFF;
    return note.toLowerCase().endsWith(".md") ? null : NOT_MARKDOWN;
}

/**
 * nextPick is the pick a click on row `e` makes for the note at `note`, whose
 * history was listed for `queried`: the row's commit, or null when it is
 * already picked. A row without a path (a merge) takes the queried one.
 */
export function nextPick(
    current: CommitPick | null,
    note: string,
    queried: string,
    e: LogEntry,
): CommitPick | null {
    if (isPicked(current, note, e)) return null;
    return { note, hash: e.hash, path: e.path ?? queried, at: e.at };
}

/** isPicked reports whether row `e` is the picked commit of the note at `note`. */
export function isPicked(
    current: CommitPick | null,
    note: string,
    e: LogEntry,
): boolean {
    return current?.note === note && current.hash === e.hash;
}
