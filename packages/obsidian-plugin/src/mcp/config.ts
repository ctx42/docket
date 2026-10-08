// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The doc server's configuration as the plugin sees it: the vault-relative
// path of its `project-config.md` (a shared setting; empty means the one at
// the vault root) resolved to a disk path, and the URL clients reach the
// server at, read from that config the way `docket mcp` reads it. No
// Obsidian imports, so it is unit-tested.

import { posix } from "node:path";

import { type Config, type DocFs, loadConfig } from "@docket/docserver";
import { slashPath, splitHostPort } from "@docket/docserver-node";

/** DEFAULT_CONFIG_PATH is the config an empty setting names: the vault root's. */
export const DEFAULT_CONFIG_PATH = "project-config.md";

/** configPath is the vault-relative config path a setting names. */
export function configPath(setting: string): string {
    return setting.trim() || DEFAULT_CONFIG_PATH;
}

/** McpConfigState is a resolved server config, or why there is none. */
export type McpConfigState =
    | { ok: true; path: string; config: Config; url: string }
    | { ok: false; error: string };

/**
 * configDiskPath resolves the config path setting rel (see
 * {@link configPath}) against the vault's disk path base, in the
 * forward-slash form the server works in ({@link slashPath}). It throws when
 * rel is absolute or leaves the vault.
 */
export function configDiskPath(base: string, rel: string): string {
    const trimmed = configPath(rel);
    if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
        throw new Error(`config path ${trimmed} must be relative to the vault`);
    }
    const clean = posix.normalize(trimmed.replaceAll("\\", "/"));
    if (clean === ".." || clean.startsWith("../")) {
        throw new Error(`config path ${trimmed} leaves the vault`);
    }
    return posix.join(slashPath(base), clean);
}

/**
 * mcpPort returns the port the server listens on: a project note's
 * `mcp-port`, else the port of a YAML config's `listen` address as the
 * server's listener parses it ({@link splitHostPort}), 1..65535. It
 * throws for a config that serves stdio only or names no usable port.
 */
export function mcpPort(cfg: Config): number {
    if (cfg.project !== null) return cfg.project.port;
    let port = 0;
    try {
        port = splitHostPort(cfg.listen).port;
    } catch {
        // Not a listen address the server could bind: no port.
    }
    if (port < 1) throw new Error("the config sets no HTTP port");
    return port;
}

/** mcpUrl is the MCP endpoint clients on this device reach the server at. */
export function mcpUrl(port: number): string {
    return `http://localhost:${port}/mcp`;
}

/**
 * readMcpConfig loads the config at the vault-relative path rel (vault at
 * disk path base) as `docket mcp -c` would and derives its URL; any problem
 * comes back as the error text to show.
 */
export async function readMcpConfig(
    fs: DocFs,
    base: string,
    rel: string,
): Promise<McpConfigState> {
    try {
        const path = configDiskPath(base, rel);
        const config = await loadConfig(fs, path);
        return { ok: true, path, config, url: mcpUrl(mcpPort(config)) };
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }
}
