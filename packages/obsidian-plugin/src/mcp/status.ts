// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Short worded forms of the MCP server's state: the status-bar segment, its
// tooltip, the panel's MCP-tab line, and which commands apply. Obsidian-free
// so it unit-tests directly.

import { splitHostPort } from "@docket/docserver-node";

import { mcpUrl } from "./config.ts";
import type { McpState } from "./host.ts";

/** listenPort returns the port of a logged listen address, e.g. "[::]:7777". */
export function listenPort(address: string): number | undefined {
    try {
        const { port } = splitHostPort(address);
        return port > 0 ? port : undefined;
    } catch {
        return undefined;
    }
}

/**
 * shown reports whether the status bar and the panel mention the server: when
 * this device has it switched on, or it is anything but stopped.
 */
export function shown(state: McpState, enabled: boolean): boolean {
    return enabled || state.kind !== "stopped";
}

/** barText is the status-bar segment's text. */
export function barText(state: McpState): string {
    switch (state.kind) {
        case "stopped":
            return "MCP stopped";
        case "starting":
            return "MCP starting…";
        case "listening": {
            const port = listenPort(state.address);
            return port === undefined ? "MCP on" : `MCP :${port}`;
        }
        case "error":
            return "MCP error";
    }
}

/** barTip is the status-bar segment's tooltip. */
export function barTip(state: McpState): string {
    switch (state.kind) {
        case "stopped":
            return "docket MCP server: stopped";
        case "starting":
            return "docket MCP server: starting…";
        case "listening":
            return `docket MCP server: listening on ${state.address}; click to copy the URL`;
        case "error":
            return `docket MCP server stopped: ${state.message}`;
    }
}

/** panelLine is the MCP tab's line about the server. */
export function panelLine(state: McpState): string {
    switch (state.kind) {
        case "stopped":
            return "MCP server stopped";
        case "starting":
            return "MCP server starting…";
        case "listening":
            return `MCP server listening on ${state.address}`;
        case "error":
            return `MCP server stopped: ${state.message}`;
    }
}

/** McpCommand names a palette command acting on the server. */
export type McpCommand = "start" | "stop" | "restart";

/**
 * commandApplies reports whether a palette command makes sense in state:
 * start when the server is not running, stop while it is, restart once it
 * runs or failed.
 */
export function commandApplies(cmd: McpCommand, state: McpState): boolean {
    const running = state.kind === "starting" || state.kind === "listening";
    switch (cmd) {
        case "start":
            return !running;
        case "stop":
            return running;
        case "restart":
            return running || state.kind === "error";
    }
}

/**
 * listeningUrl is the MCP URL of a listening server, from the port it bound;
 * undefined in any other state.
 */
export function listeningUrl(state: McpState): string | undefined {
    if (state.kind !== "listening") return undefined;
    const port = listenPort(state.address);
    return port === undefined ? undefined : mcpUrl(port);
}

/** ConfigChange is what decides a restart after the config path changed. */
export interface ConfigChange {
    /** path is the config path now named (see configPath). */
    path: string;
    /** served is the path the latest run started on; undefined if none ran. */
    served: string | undefined;
    /** enabled is this device's switch. */
    enabled: boolean;
    /** running reports a server run in progress. */
    running: boolean;
    state: McpState;
}

/**
 * restartsOnConfig reports whether a changed config path (re)starts the
 * server: when it differs from the one served, for a running server however
 * it was started, and, while the switch is on, for a failed one or one that
 * has not run yet. A server stopped from a command stays stopped.
 */
export function restartsOnConfig(c: ConfigChange): boolean {
    if (c.path === c.served) return false;
    if (c.running) return true;
    return c.enabled && (c.state.kind === "error" || c.served === undefined);
}
