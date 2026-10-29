// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The doc server's starter config: when the server is switched on in a vault
// without its default `project-config.md`, the plugin writes one holding only
// what the server needs to start — its name, the sync folder as its one
// source, and watching on. The first start then gives it a port and a
// `.mcp.json` (port.ts). The keys only the srd skills read (`kb`,
// `initiatives`, and the rest) are theirs to add (`srd:init`). File access is
// injected, so the logic is unit-tested.

import { configPath, DEFAULT_CONFIG_PATH } from "./config.ts";
import type { PortDeps } from "./port.ts";

/** STARTER_SERVER is the server name a starter config gives. */
export const STARTER_SERVER = "docs";

/** starterConfig is the text of a starter config serving `syncFolder`. */
export function starterConfig(syncFolder: string): string {
    return [
        "---",
        `mcp-server: ${STARTER_SERVER}`,
        "sources:",
        `  - ${syncFolder}`,
        "watch: true",
        "---",
        "",
        "# Project configuration",
        "",
        "The docket plugin created this file to run its MCP doc server over the",
        "sync folder. Add a top-level folder to `sources` to serve it too.",
        "",
    ].join("\n");
}

/**
 * ensureConfig writes a starter config at the disk path `config` and reports
 * whether it did: only for the default config (`setting` names no other)
 * when it does not exist. It throws when it is missing and the vault has no
 * sync folder to serve.
 */
export async function ensureConfig(
    deps: Pick<PortDeps, "readOptional" | "writeText">,
    config: string,
    setting: string,
    syncFolder: string,
): Promise<boolean> {
    if (configPath(setting) !== DEFAULT_CONFIG_PATH) return false;
    if ((await deps.readOptional(config)) !== undefined) return false;
    if (syncFolder === "") {
        throw new Error(
            `${DEFAULT_CONFIG_PATH} does not exist, and docket can only ` +
                "create one for a vault with a sync folder",
        );
    }
    await deps.writeText(config, starterConfig(syncFolder));
    return true;
}
