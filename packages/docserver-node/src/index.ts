// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

/**
 * `@docket/docserver-node` hosts the runtime-neutral `@docket/docserver` on
 * Node: the `node:fs` implementation of its filesystem port, filesystem
 * watching, the Streamable HTTP and stdio MCP transports, the REST mount, and
 * the server's startup and shutdown sequence. Both the CLI (`docket mcp`) and
 * the desktop-only Obsidian plugin run the server through this package;
 * anything that needs no Node API belongs in docserver instead.
 */
export const PACKAGE_NAME = "@docket/docserver-node";

export * from "./fs.ts";
export * from "./http.ts";
export * from "./run.ts";
export * from "./stdio.ts";
export * from "./watch.ts";
