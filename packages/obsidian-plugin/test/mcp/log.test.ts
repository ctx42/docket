// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    clock,
    lineKind,
    MCP_LOG_CAP,
    McpLog,
    type McpLogKind,
} from "../../src/mcp/log.ts";

describe("McpLog", () => {
    it("stamps and classifies each added line", () => {
        // --- Given ---
        let now = 1000;
        const log = new McpLog(() => now);

        // --- When ---
        log.add("indexed 5 documents in 3ms");
        now = 2000;
        log.add("request failed: boom");
        now = 3000;
        log.add("server stopped: bind failed", "err");

        // --- Then ---
        expect(log.lines).toEqual([
            { at: 1000, text: "indexed 5 documents in 3ms", kind: "info" },
            { at: 2000, text: "request failed: boom", kind: "err" },
            { at: 3000, text: "server stopped: bind failed", kind: "err" },
        ]);
    });

    it("keeps only the newest lines past the cap", () => {
        // --- Given ---
        const log = new McpLog(() => 0, 2);

        // --- When ---
        log.add("one");
        log.add("two");
        log.add("three");

        // --- Then ---
        expect(log.lines.map((l) => l.text)).toEqual(["two", "three"]);
    });

    it("caps at MCP_LOG_CAP by default", () => {
        // --- Given ---
        const log = new McpLog(() => 0);

        // --- When ---
        for (let i = 0; i <= MCP_LOG_CAP; i++) log.add(`line ${i}`);

        // --- Then ---
        expect(log.lines).toHaveLength(MCP_LOG_CAP);
        expect(log.lines[0]?.text).toBe("line 1");
    });

    it("tells subscribers of each line until they undo", () => {
        // --- Given ---
        const log = new McpLog(() => 0);
        let calls = 0;
        const undo = log.subscribe(() => calls++);

        // --- When ---
        log.add("one");
        undo();
        log.add("two");

        // --- Then ---
        expect(calls).toBe(1);
    });
});

describe("lineKind", () => {
    it.each<[string, McpLogKind]>([
        ["listening on [::]:7777", "info"],
        ["reindexed 12 documents in 4ms", "info"],
        ["request failed: no such tool", "err"],
        ["reindex failed, serving previous index: EACCES", "err"],
        ["stale gap check failed: EIO", "err"],
        ["stale gaps (2): gap-0001, gap-0004", "warn"],
    ])("%s", (text, want) => {
        // --- When ---
        const have = lineKind(text);

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("clock", () => {
    it("formats local time as zero-padded HH:MM:SS", () => {
        // --- Given ---
        const at = new Date(2026, 9, 7, 9, 5, 3).getTime();

        // --- When ---
        const have = clock(at);

        // --- Then ---
        expect(have).toBe("09:05:03");
    });
});
