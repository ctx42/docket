// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The MCP server over stdio for a single local client, as the Go server's
// Serve: it serves until the client closes the transport or the signal
// aborts, and an aborted signal is a clean shutdown, not an error.

import type { Readable, Writable } from "node:stream";

import { newMcpServer, type ToolDeps } from "@docket/docserver";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** StdioOptions select the streams and the stop signal. */
export interface StdioOptions {
    /** stdin defaults to process.stdin. */
    stdin?: Readable;
    /** stdout defaults to process.stdout. */
    stdout?: Writable;
    /** signal stops serving cleanly once aborted. */
    signal?: AbortSignal;
}

/**
 * serveStdio serves one client over stdio and resolves when the transport
 * closes or the signal aborts.
 */
export async function serveStdio(
    deps: ToolDeps,
    opts: StdioOptions = {},
): Promise<void> {
    const stdin = opts.stdin ?? process.stdin;
    const transport = new StdioServerTransport(stdin, opts.stdout);
    const server = newMcpServer(deps);
    const closed = new Promise<void>((resolve) => {
        server.onclose = () => resolve();
    });
    stdin.once("end", () => void server.close());
    const signal = opts.signal;
    const onAbort = () => void server.close();
    if (signal?.aborted) return;
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        await server.connect(transport);
        await closed;
    } finally {
        signal?.removeEventListener("abort", onAbort);
    }
}
