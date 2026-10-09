// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Commit history rows: `git log -z` output in the {@link LOG_FORMAT} shape,
// parsed into one row per commit, and the `DD/MM/YY HH:MM: <subject>` line the
// History tab shows for each. A one-file query adds `--name-only`, so each row
// also carries the file's path at that commit — older across a rename.

/** LOG_FORMAT is the `--format` that {@link parseLog} reads: hash, time, subject. */
export const LOG_FORMAT = "%H%x1f%ct%x1f%s";

/** LogEntry is one commit. */
export interface LogEntry {
    hash: string;
    /** The committer time, epoch milliseconds. */
    at: number;
    subject: string;
    /** The queried file's path at this commit; set by a one-file query only. */
    path?: string;
}

/**
 * parseLog parses `git log -z --format=<LOG_FORMAT>` output, with or without
 * `--name-only`: there, a commit's record is followed by `\n<path>` and NUL.
 */
export function parseLog(out: string): LogEntry[] {
    const rows: LogEntry[] = [];
    for (const rec of out.split("\0")) {
        const text = rec.replace(/^\n+/, "");
        if (!text.includes("\x1f")) {
            const last = rows.at(-1);
            if (text !== "" && last !== undefined && last.path === undefined) {
                last.path = text;
            }
            continue;
        }
        const [hash = "", time = "", subject = ""] = text.split("\x1f");
        if (hash === "") continue;
        rows.push({ hash, at: Number(time) * 1000, subject });
    }
    return rows;
}

/** logLine formats a commit as `DD/MM/YY HH:MM: <subject>` in local time. */
export function logLine(e: LogEntry): string {
    const subject = e.subject.trim() === "" ? "(no message)" : e.subject;
    return `${logTime(e.at)}: ${subject}`;
}

/** logTime formats epoch milliseconds `at` as `DD/MM/YY HH:MM` in local time. */
export function logTime(at: number): string {
    const d = new Date(at);
    const two = (n: number): string => String(n).padStart(2, "0");
    const date = `${two(d.getDate())}/${two(d.getMonth() + 1)}/${two(d.getFullYear() % 100)}`;
    return `${date} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
