// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import type { McpState } from "../../src/mcp/host.ts";
import {
    barText,
    barTip,
    type ConfigChange,
    commandApplies,
    listeningUrl,
    listenPort,
    type McpCommand,
    panelLine,
    restartsOnConfig,
    shown,
} from "../../src/mcp/status.ts";

const STOPPED: McpState = { kind: "stopped" };
const STARTING: McpState = { kind: "starting" };
const LISTENING: McpState = { kind: "listening", address: "[::]:7777" };
const FAILED: McpState = {
    kind: "error",
    message: "listen: listen tcp :7777: bind: address already in use",
};

describe("listenPort", () => {
    it.each<[string, number | undefined]>([
        ["[::]:7777", 7777],
        ["127.0.0.1:8080", 8080],
        ["[::1]:9000", 9000],
        ["localhost", undefined],
        ["[::]:", undefined],
    ])("%s", (address, want) => {
        // --- When ---
        const have = listenPort(address);

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("shown", () => {
    it.each<[string, McpState, boolean, boolean]>([
        ["switched off and stopped", STOPPED, false, false],
        ["switched on and stopped", STOPPED, true, true],
        ["switched off but listening", LISTENING, false, true],
        ["switched off after an error", FAILED, false, true],
    ])("%s", (_name, state, enabled, want) => {
        // --- When ---
        const have = shown(state, enabled);

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("worded state", () => {
    it.each<[McpState, string, string, string]>([
        [
            STOPPED,
            "MCP stopped",
            "docket MCP server: stopped",
            "MCP server stopped",
        ],
        [
            STARTING,
            "MCP starting…",
            "docket MCP server: starting…",
            "MCP server starting…",
        ],
        [
            LISTENING,
            "MCP :7777",
            "docket MCP server: listening on [::]:7777; click to copy the URL",
            "MCP server listening on [::]:7777",
        ],
        [
            { kind: "listening", address: "pipe" },
            "MCP on",
            "docket MCP server: listening on pipe; click to copy the URL",
            "MCP server listening on pipe",
        ],
        [
            FAILED,
            "MCP error",
            "docket MCP server stopped: listen: listen tcp :7777: bind: address already in use",
            "MCP server stopped: listen: listen tcp :7777: bind: address already in use",
        ],
    ])("%j", (state, wBar, wTip, wLine) => {
        // --- When ---
        const hBar = barText(state);
        const hTip = barTip(state);
        const hLine = panelLine(state);

        // --- Then ---
        expect([hBar, hTip, hLine]).toEqual([wBar, wTip, wLine]);
    });
});

describe("commandApplies", () => {
    it.each<[McpCommand, McpState, boolean]>([
        ["start", STOPPED, true],
        ["start", FAILED, true],
        ["start", STARTING, false],
        ["start", LISTENING, false],
        ["stop", STOPPED, false],
        ["stop", FAILED, false],
        ["stop", STARTING, true],
        ["stop", LISTENING, true],
        ["restart", STOPPED, false],
        ["restart", FAILED, true],
        ["restart", STARTING, true],
        ["restart", LISTENING, true],
    ])("%s when %j", (cmd, state, want) => {
        // --- When ---
        const have = commandApplies(cmd, state);

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("listeningUrl", () => {
    it.each<[McpState, string | undefined]>([
        [LISTENING, "http://localhost:7777/mcp"],
        [{ kind: "listening", address: "pipe" }, undefined],
        [STARTING, undefined],
        [STOPPED, undefined],
        [FAILED, undefined],
    ])("%j", (state, want) => {
        // --- When ---
        const have = listeningUrl(state);

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("restartsOnConfig", () => {
    /** change is a config change over a switched-on, never-run server. */
    const change = (over: Partial<ConfigChange>): ConfigChange => ({
        path: "srd/project-config.md",
        served: undefined,
        enabled: true,
        running: false,
        state: STOPPED,
        ...over,
    });

    it.each<[string, Partial<ConfigChange>, boolean]>([
        ["first path while switched on", {}, true],
        ["first path while switched off", { enabled: false }, false],
        [
            "same path",
            { served: "srd/project-config.md", running: true },
            false,
        ],
        ["running on another path", { served: "a.md", running: true }, true],
        [
            "running from a command while switched off",
            { served: "a.md", running: true, enabled: false },
            true,
        ],
        ["failed while switched on", { served: "a.md", state: FAILED }, true],
        [
            "failed while switched off",
            { served: "a.md", state: FAILED, enabled: false },
            false,
        ],
        ["stopped from a command", { served: "a.md" }, false],
    ])("%s", (_name, over, want) => {
        // --- When ---
        const have = restartsOnConfig(change(over));

        // --- Then ---
        expect(have).toBe(want);
    });
});
