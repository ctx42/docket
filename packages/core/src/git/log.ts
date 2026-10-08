// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Commit history rows: `git log -z` output in the {@link LOG_FORMAT} shape,
// parsed into one row per commit, and the `DD/MM/YY HH:MM: <subject>` line the
// History tab shows for each.

/** LOG_FORMAT is the `--format` that {@link parseLog} reads: hash, time, subject. */
export const LOG_FORMAT = "%H%x1f%ct%x1f%s";

/** LogEntry is one commit. */
export interface LogEntry {
    hash: string;
    /** The committer time, epoch milliseconds. */
    at: number;
    subject: string;
}

/** parseLog parses `git log -z --format=<LOG_FORMAT>` output. */
export function parseLog(out: string): LogEntry[] {
    const rows: LogEntry[] = [];
    for (const rec of out.split("\0")) {
        const [hash = "", time = "", subject = ""] = rec
            .replace(/^\n+/, "")
            .split("\x1f");
        if (hash === "") continue;
        rows.push({ hash, at: Number(time) * 1000, subject });
    }
    return rows;
}

/** logLine formats a commit as `DD/MM/YY HH:MM: <subject>` in local time. */
export function logLine(e: LogEntry): string {
    const d = new Date(e.at);
    const two = (n: number): string => String(n).padStart(2, "0");
    const date = `${two(d.getDate())}/${two(d.getMonth() + 1)}/${two(d.getFullYear() % 100)}`;
    const subject = e.subject.trim() === "" ? "(no message)" : e.subject;
    return `${date} ${two(d.getHours())}:${two(d.getMinutes())}: ${subject}`;
}
