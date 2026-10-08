// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's record of the doc server's log: the server's own lines plus
// the host's start and stop marks, each stamped with the time it arrived,
// kept across restarts and capped to the newest lines. The panel's MCP
// section shows it. Obsidian-free so it unit-tests directly.

/** McpLogKind is how a log line reads: plain, worth a look, or a failure. */
export type McpLogKind = "info" | "warn" | "err";

/** McpLogLine is one recorded log line. */
export interface McpLogLine {
    /** at is when the line arrived, in epoch milliseconds. */
    at: number;
    text: string;
    kind: McpLogKind;
}

/** MCP_LOG_CAP is how many of the newest lines the log keeps. */
export const MCP_LOG_CAP = 500;

/** McpLog records the server's log lines; see the module comment. */
export class McpLog {
    private readonly rows: McpLogLine[] = [];
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly now: () => number = Date.now,
        private readonly cap = MCP_LOG_CAP,
    ) {}

    /** lines are the recorded lines, oldest first. */
    get lines(): readonly McpLogLine[] {
        return this.rows;
    }

    /** add records text, dropping the oldest line past the cap. */
    add(text: string, kind: McpLogKind = lineKind(text)): void {
        this.rows.push({ at: this.now(), text, kind });
        if (this.rows.length > this.cap) {
            this.rows.splice(0, this.rows.length - this.cap);
        }
        for (const fn of this.listeners) fn();
    }

    /** subscribe calls fn after every added line until the returned undo. */
    subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
}

/**
 * lineKind classifies a server log line: a failure ("request failed: …",
 * "reindex failed, …") is an error, stale gaps are worth a look, the rest
 * is plain.
 */
export function lineKind(text: string): McpLogKind {
    if (/\bfailed\b/.test(text)) return "err";
    if (text.startsWith("stale gaps ")) return "warn";
    return "info";
}

/** clock formats at as the local HH:MM:SS a log line is stamped with. */
export function clock(at: number): string {
    const d = new Date(at);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((n) => String(n).padStart(2, "0"))
        .join(":");
}
