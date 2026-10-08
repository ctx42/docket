// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyConfig } from "@docket/docserver";
import { NodeDocFs } from "@docket/docserver-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    configDiskPath,
    configPath,
    DEFAULT_CONFIG_PATH,
    mcpPort,
    mcpUrl,
    readMcpConfig,
} from "../../src/mcp/config.ts";

/** BOOKSHOP is the example project the doc server tests use. */
const BOOKSHOP = new URL(
    "../../../docserver-node/test/testdata/bookshop",
    import.meta.url,
).pathname;

let vault: string;

beforeEach(() => {
    vault = fs.mkdtempSync(join(tmpdir(), "vault-"));
    fs.cpSync(BOOKSHOP, join(vault, "srd"), { recursive: true });
});

afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
});

describe("configDiskPath", () => {
    it.each([
        ["note at the root", "project-config.md", "/v/project-config.md"],
        ["nested note", "srd/project-config.md", "/v/srd/project-config.md"],
        ["surrounding space", " srd/a.md ", "/v/srd/a.md"],
        ["dot segments", "srd/../a.md", "/v/a.md"],
        ["backslashes", "srd\\a.md", "/v/srd/a.md"],
        ["empty means the root config", "  ", "/v/project-config.md"],
    ])("%s", (_name, rel, want) => {
        // --- When ---
        const have = configDiskPath("/v", rel);

        // --- Then ---
        expect(have).toBe(want);
    });

    it.each([
        ["error - absolute", "/etc/a.md", "must be relative to the vault"],
        ["error - drive", "C:\\a.md", "must be relative to the vault"],
        ["error - escaping", "../a.md", "leaves the vault"],
        ["error - parent", "srd/../..", "leaves the vault"],
    ])("%s", (_name, rel, want) => {
        // --- When ---
        const have = () => configDiskPath("/v", rel);

        // --- Then ---
        expect(have).toThrow(want);
    });
});

describe("configPath", () => {
    it.each([
        ["set", "srd/project-config.md", "srd/project-config.md"],
        ["surrounding space", " srd/a.md ", "srd/a.md"],
        ["empty", "", DEFAULT_CONFIG_PATH],
        ["blank", "  ", DEFAULT_CONFIG_PATH],
    ])("%s", (_name, setting, want) => {
        // --- When ---
        const have = configPath(setting);

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("mcpPort", () => {
    it.each([
        ["any address", ":7777", 7777],
        ["host address", "localhost:8080", 8080],
        ["IPv6 address", "[::1]:9000", 9000],
    ])("%s", (_name, listen, want) => {
        // --- When ---
        const have = mcpPort({ ...emptyConfig(), listen });

        // --- Then ---
        expect(have).toBe(want);
    });

    it("takes a project's mcp-port", () => {
        // --- Given ---
        const project = { root: "/p", server: "srd", port: 7788 };

        // --- When ---
        const have = mcpPort({ ...emptyConfig(), listen: ":1", project });

        // --- Then ---
        expect(have).toBe(7788);
    });

    it.each([
        ["error - stdio only", ""],
        ["error - no port", "localhost"],
        ["error - zero port", ":0"],
        ["error - port out of range", ":99999"],
        ["error - hex port", ":0x50"],
        ["error - exponent port", ":1e3"],
        ["error - spaced port", ": 80"],
    ])("%s", (_name, listen) => {
        // --- When ---
        const have = () => mcpPort({ ...emptyConfig(), listen });

        // --- Then ---
        expect(have).toThrow("the config sets no HTTP port");
    });
});

describe("mcpUrl", () => {
    it("is the localhost MCP endpoint", () => {
        expect(mcpUrl(7777)).toBe("http://localhost:7777/mcp");
    });
});

describe("readMcpConfig", () => {
    it("reads a project note", async () => {
        // --- When ---
        const have = await readMcpConfig(
            new NodeDocFs(),
            vault,
            "srd/project-config.md",
        );

        // --- Then ---
        expect(have.ok).toBe(true);
        if (!have.ok) return;
        expect(have.url).toBe("http://localhost:7777/mcp");
        expect(have.path).toBe(join(vault, "srd/project-config.md"));
        expect(have.config.project?.root).toBe(join(vault, "srd"));
        expect([...have.config.sources.keys()].sort()).toEqual([
            "docs",
            "initiatives",
            "kb",
        ]);
    });

    it("reads a YAML config", async () => {
        // --- When ---
        const have = await readMcpConfig(
            new NodeDocFs(),
            vault,
            "srd/bookshop.yaml",
        );

        // --- Then ---
        expect(have).toMatchObject({
            ok: true,
            url: "http://localhost:7777/mcp",
        });
    });

    it("error - missing file", async () => {
        // --- When ---
        const have = await readMcpConfig(new NodeDocFs(), vault, "nope.md");

        // --- Then ---
        expect(have.ok).toBe(false);
        expect(have).toMatchObject({
            error: expect.stringMatching(/^read config: .*nope\.md/),
        });
    });

    it("error - invalid config", async () => {
        // --- Given ---
        fs.writeFileSync(
            join(vault, "srd/project-config.md"),
            "---\nmcp-server: srd\nmcp-port: 99999\nsources: [docs]\n---\n",
        );

        // --- When ---
        const have = await readMcpConfig(
            new NodeDocFs(),
            vault,
            "srd/project-config.md",
        );

        // --- Then ---
        expect(have).toEqual({
            ok: false,
            error: expect.stringContaining(
                "mcp-port must be between 1 and 65535, have 99999",
            ),
        });
    });

    it("reads the vault root's config when no path is set", async () => {
        // --- Given ---
        fs.cpSync(BOOKSHOP, vault, { recursive: true });

        // --- When ---
        const have = await readMcpConfig(new NodeDocFs(), vault, "");

        // --- Then ---
        expect(have).toMatchObject({
            ok: true,
            path: join(vault, "project-config.md"),
            url: "http://localhost:7777/mcp",
        });
    });

    it("error - no config at the vault root", async () => {
        // --- When ---
        const have = await readMcpConfig(new NodeDocFs(), vault, "");

        // --- Then ---
        expect(have).toMatchObject({
            ok: false,
            error: expect.stringMatching(/^read config: .*project-config\.md/),
        });
    });
});

describe("configDiskPath on Windows", () => {
    it("joins onto a drive path", () => {
        // --- When ---
        const have = configDiskPath("C:/Vault", "srd\\project-config.md");

        // --- Then ---
        expect(have).toBe("C:/Vault/srd/project-config.md");
    });

    it("error - another drive", () => {
        // --- When ---
        const have = () => configDiskPath("C:/Vault", "D:\\a.md");

        // --- Then ---
        expect(have).toThrow("must be relative to the vault");
    });
});
