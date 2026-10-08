// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { SETTINGS_SCHEMA_VERSION } from "@docket/core";
import type { Plugin } from "obsidian";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/settings/model.ts";
import {
    COMMIT_HISTORY_KEY,
    HISTORY_CAP_KEY,
    loadCommitHistory,
    loadDiffSigns,
    loadGitPath,
    loadHideProps,
    loadHistoryCap,
    loadMcpEnabled,
    loadSettings,
    loadToken,
    MCP_ENABLED_KEY,
    saveCommitHistory,
    saveDiffSigns,
    saveGitPath,
    saveHideProps,
    saveHistoryCap,
    saveMcpEnabled,
    saveSettings,
    saveToken,
    TOKEN_KEY,
} from "../../src/settings/store.ts";

/** fakePlugin is a minimal stand-in for the parts of Plugin the store touches. */
function fakePlugin(data: unknown = null) {
    const local = new Map<string, unknown>();
    let saved: unknown = data;
    const plugin = {
        loadData: async () => saved,
        saveData: async (d: unknown) => {
            saved = d;
        },
        app: {
            loadLocalStorage: (k: string) => local.get(k) ?? null,
            saveLocalStorage: (k: string, v: unknown) => {
                if (v === null) {
                    local.delete(k);
                } else {
                    local.set(k, v);
                }
            },
        },
    };
    return plugin as unknown as Plugin;
}

describe("settings store", () => {
    it("merges saved data over the defaults", async () => {
        const plugin = fakePlugin({ site: "ex", margin: 80 });
        const settings = await loadSettings(plugin);
        expect(settings.site).toBe("ex");
        expect(settings.margin).toBe(80);
        expect(settings.flavor).toBe(DEFAULT_SETTINGS.flavor);
    });

    it("returns the defaults when there is no saved data", async () => {
        const settings = await loadSettings(fakePlugin(null));
        expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it("round-trips settings through saveSettings/loadSettings", async () => {
        const plugin = fakePlugin();
        await saveSettings(plugin, { ...DEFAULT_SETTINGS, account: "me@x" });
        expect((await loadSettings(plugin)).account).toBe("me@x");
    });

    it("stamps the schema version on save", async () => {
        const plugin = fakePlugin({ site: "ex" });
        const { schemaVersion: _, ...legacy } = DEFAULT_SETTINGS;
        await saveSettings(plugin, { ...legacy, schemaVersion: 0 });
        const have = (await plugin.loadData()) as { schemaVersion: number };
        expect(have.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    });

    it("round-trips the token through localStorage", () => {
        const plugin = fakePlugin();
        expect(loadToken(plugin)).toBe("");
        saveToken(plugin, "abc");
        expect(loadToken(plugin)).toBe("abc");
        expect(TOKEN_KEY).toBe("docket-token");
    });

    it("clears the token when saving an empty string", () => {
        const plugin = fakePlugin();
        saveToken(plugin, "abc");
        saveToken(plugin, "");
        expect(loadToken(plugin)).toBe("");
    });
});

describe("hide-properties preference", () => {
    it("defaults to hiding and round-trips a change", () => {
        const plugin = fakePlugin();

        expect(loadHideProps(plugin)).toBe(true);
        saveHideProps(plugin, false);
        expect(loadHideProps(plugin)).toBe(false);
        saveHideProps(plugin, true);
        expect(loadHideProps(plugin)).toBe(true);
    });

    it("keeps the git path and change bars per device", () => {
        const plugin = fakePlugin();
        expect(loadGitPath(plugin)).toBe("");
        expect(loadDiffSigns(plugin)).toBe(true);

        saveGitPath(plugin, "/opt/git");
        saveDiffSigns(plugin, false);

        expect(loadGitPath(plugin)).toBe("/opt/git");
        expect(loadDiffSigns(plugin)).toBe(false);
        saveGitPath(plugin, "");
        expect(loadGitPath(plugin)).toBe("");
    });
});

describe("commit message history", () => {
    it("reads none and the default cap on a fresh device", () => {
        const plugin = fakePlugin();

        expect(loadCommitHistory(plugin)).toEqual([]);
        expect(loadHistoryCap(plugin)).toBe(20);
    });

    it("round-trips the messages and the cap", () => {
        const plugin = fakePlugin();

        saveCommitHistory(plugin, ["b", "a"]);
        saveHistoryCap(plugin, 5);

        expect(loadCommitHistory(plugin)).toEqual(["b", "a"]);
        expect(loadHistoryCap(plugin)).toBe(5);
        saveCommitHistory(plugin, []);
        saveHistoryCap(plugin, 20);
        expect(plugin.app.loadLocalStorage(COMMIT_HISTORY_KEY)).toBeNull();
        expect(plugin.app.loadLocalStorage(HISTORY_CAP_KEY)).toBeNull();
    });

    it("reads junk as no messages and the default cap", () => {
        const plugin = fakePlugin();
        plugin.app.saveLocalStorage(COMMIT_HISTORY_KEY, ["a", 1, null, "b"]);
        plugin.app.saveLocalStorage(HISTORY_CAP_KEY, "101");

        expect(loadCommitHistory(plugin)).toEqual(["a", "b"]);
        expect(loadHistoryCap(plugin)).toBe(20);
        plugin.app.saveLocalStorage(COMMIT_HISTORY_KEY, "a");
        expect(loadCommitHistory(plugin)).toEqual([]);
    });
});

describe("MCP server switch", () => {
    it("defaults to off and round-trips a change", () => {
        // --- Given ---
        const plugin = fakePlugin();
        expect(loadMcpEnabled(plugin)).toBe(false);

        // --- When ---
        saveMcpEnabled(plugin, true);

        // --- Then ---
        expect(loadMcpEnabled(plugin)).toBe(true);
        expect(plugin.app.loadLocalStorage(MCP_ENABLED_KEY)).toBe("1");
        saveMcpEnabled(plugin, false);
        expect(loadMcpEnabled(plugin)).toBe(false);
        expect(plugin.app.loadLocalStorage(MCP_ENABLED_KEY)).toBeNull();
        expect(MCP_ENABLED_KEY).toBe("docket-mcp-enabled");
    });

    it("keeps the path in data.json and the switch out of it", async () => {
        // --- Given ---
        const plugin = fakePlugin({ site: "ex" });
        saveMcpEnabled(plugin, true);
        const settings = await loadSettings(plugin);

        // --- When ---
        await saveSettings(plugin, {
            ...settings,
            mcpConfigPath: "srd/project-config.md",
        });

        // --- Then ---
        const have = (await plugin.loadData()) as Record<string, unknown>;
        expect(have["mcpConfigPath"]).toBe("srd/project-config.md");
        expect(Object.keys(have).sort()).toEqual(
            Object.keys(DEFAULT_SETTINGS).sort(),
        );
        expect(settings.mcpConfigPath).toBe("");
    });
});
