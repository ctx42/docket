// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "@docket/docserver";
import { NodeDocFs } from "@docket/docserver-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assignPort, notePort, type PortDeps } from "../../src/mcp/port.ts";
import {
    ensureConfig,
    STARTER_SERVER,
    starterConfig,
} from "../../src/mcp/starter.ts";

/** memDeps is {@link PortDeps} over an in-memory file map, every port free. */
function memDeps(files: Record<string, string>): PortDeps {
    return {
        readText: async (p) => {
            const text = files[p];
            if (text === undefined) throw new Error(`ENOENT ${p}`);
            return text;
        },
        readOptional: async (p) => files[p],
        writeText: async (p, text) => {
            files[p] = text;
        },
        isFree: async () => true,
        anyPort: async () => 49152,
    };
}

describe("starterConfig", () => {
    it("names the server and serves the sync folder", () => {
        const have = starterConfig("conflu");

        expect(have).toMatch(
            /^---\nmcp-server: docs\nsources:\n {2}- conflu\nwatch: true\n---\n/,
        );
        expect(STARTER_SERVER).toBe("docs");
    });
});

describe("ensureConfig", () => {
    const CFG = "/v/project-config.md";

    it("creates a missing default config", async () => {
        const files: Record<string, string> = {};

        const have = await ensureConfig(memDeps(files), CFG, "", "conflu");

        expect(have).toBe(true);
        expect(files[CFG]).toBe(starterConfig("conflu"));
    });

    it("leaves an existing config alone", async () => {
        const files: Record<string, string> = { [CFG]: "---\nx: 1\n---\n" };

        const have = await ensureConfig(memDeps(files), CFG, "", "conflu");

        expect(have).toBe(false);
        expect(files[CFG]).toBe("---\nx: 1\n---\n");
    });

    it("never creates a config the setting names elsewhere", async () => {
        const files: Record<string, string> = {};
        const cfg = "/v/team/project-config.md";

        const have = await ensureConfig(
            memDeps(files),
            cfg,
            "team/project-config.md",
            "conflu",
        );

        expect(have).toBe(false);
        expect(files).toEqual({});
    });

    it("refuses without a sync folder to serve", async () => {
        const have = ensureConfig(memDeps({}), CFG, "", "");

        await expect(have).rejects.toThrow(
            "project-config.md does not exist, and docket can only create one " +
                "for a vault with a sync folder",
        );
    });

    it("gets its port on the first start", async () => {
        const files: Record<string, string> = {};
        const deps = memDeps(files);
        await ensureConfig(deps, CFG, "", "conflu");

        const have = await assignPort(deps, CFG);

        expect(have).toEqual({ port: 7777, written: true });
        expect(notePort(files[CFG] as string)).toBe(7777);
        expect(
            JSON.parse(files["/v/.mcp.json"] as string).mcpServers.docs.url,
        ).toBe("http://localhost:7777/mcp");
    });
});

describe("starterConfig on disk", () => {
    let vault = "";

    beforeEach(async () => {
        vault = await mkdtemp(join(tmpdir(), "docket-starter-"));
    });
    afterEach(async () => {
        await rm(vault, { recursive: true, force: true });
    });

    it("loads as a doc server config once it has a port", async () => {
        await mkdir(join(vault, "conflu"));
        const cfg = join(vault, "project-config.md");
        await writeFile(cfg, starterConfig("conflu"));
        await assignPort({ ...memDepsOnDisk(), isFree: async () => true }, cfg);

        const have = await loadConfig(new NodeDocFs(), cfg);

        expect([...have.sources.keys()]).toEqual(["conflu"]);
        expect(have.project?.server).toBe("docs");
        expect(have.watch.enabled).toBe(true);
    });
});

/** memDepsOnDisk is {@link PortDeps} over the real filesystem. */
function memDepsOnDisk(): PortDeps {
    return {
        readText: (p) => readFile(p, "utf8"),
        readOptional: async (p) => {
            try {
                return await readFile(p, "utf8");
            } catch {
                return undefined;
            }
        },
        writeText: (p, text) => writeFile(p, text),
        isFree: async () => true,
        anyPort: async () => 49152,
    };
}
