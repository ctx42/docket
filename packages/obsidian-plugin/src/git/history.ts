// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// This device's commit-message history: the messages it committed, most recent
// first, offered again in the Git tab. Pure, so it carries no Obsidian import;
// settings/store.ts persists it.

/** HISTORY_CAP is how many messages a device keeps unless told otherwise. */
export const HISTORY_CAP = 20;

/** HISTORY_CAP_MAX is the largest history cap the setting accepts. */
export const HISTORY_CAP_MAX = 100;

/**
 * recordMessage puts the trimmed `message` first in `list`, drops any older
 * entry equal to it after trimming, and cuts the result to `cap` entries. A
 * blank message leaves the list as it is, cut to `cap`.
 */
export function recordMessage(
    list: readonly string[],
    message: string,
    cap: number,
): string[] {
    const m = message.trim();
    if (m === "") return capHistory(list, cap);
    const rest = list.filter((e) => e.trim() !== m);
    return capHistory([m, ...rest], cap);
}

/** capHistory keeps the `cap` most recent entries of `list`. */
export function capHistory(list: readonly string[], cap: number): string[] {
    return list.slice(0, Math.max(0, cap));
}

/**
 * parseHistoryCap reads a history cap typed into the settings: a whole number
 * from 0 to {@link HISTORY_CAP_MAX}, or null for anything else.
 */
export function parseHistoryCap(text: string): number | null {
    const t = text.trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return n <= HISTORY_CAP_MAX ? n : null;
}

/** firstLine returns a message's first line, as the history picker shows it. */
export function firstLine(message: string): string {
    return message.split(/\r?\n/, 1)[0] ?? "";
}
