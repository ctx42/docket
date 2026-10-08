// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    buildPluginConfig,
    DEFAULT_SETTINGS,
    type docketSettings,
    mergeSettings,
    parseSettings,
    SETTINGS_SCHEMA_VERSION,
    SettingsVersionError,
} from "../../src/config/settings.ts";

function valid(overrides: Partial<docketSettings> = {}): docketSettings {
    return {
        ...DEFAULT_SETTINGS,
        site: "ex",
        account: "you@example.com",
        ...overrides,
    };
}

describe("buildPluginConfig", () => {
    it("maps defaults and injects the token", () => {
        const config = buildPluginConfig(valid(), "secret-token");
        expect(config.host).toBe("https://ex.atlassian.net");
        expect(config.account).toBe("you@example.com");
        expect(config.token).toBe("secret-token");
        expect(config.flavor).toBe("obsidian");
        expect(config.margin).toBe(0);
    });

    it("resolves an empty sync root to the vault root", () => {
        const config = buildPluginConfig(valid({ syncRoot: "" }), "t");
        expect(config.syncRoot).toBe(".");
    });

    it("converts timeout seconds to milliseconds", () => {
        const config = buildPluginConfig(valid({ timeoutSeconds: 45 }), "t");
        expect(config.timeoutMs).toBe(45_000);
    });

    it("resolves page destinations under the sync root", () => {
        const config = buildPluginConfig(
            valid({ pages: { "notes/a.md": "/wiki/spaces/T/pages/1" } }),
            "t",
        );
        expect(config.pages["notes/a.md"]).toBe("/wiki/spaces/T/pages/1");
    });

    it("propagates an invalid site subdomain error", () => {
        expect(() =>
            buildPluginConfig(valid({ site: "https://ex.atlassian.net" }), "t"),
        ).toThrow(/bare subdomain/);
    });

    it("propagates a duplicate-destination error", () => {
        expect(() =>
            buildPluginConfig(
                valid({ pages: { "a.md": "s1", "./a.md": "s2" } }),
                "t",
            ),
        ).toThrow(/same destination/);
    });

    it("carries name overrides", () => {
        const config = buildPluginConfig(valid({ names: { "7": "faq" } }), "t");
        expect(config.names).toEqual({ "7": "faq" });
    });

    it("propagates an invalid name override error", () => {
        expect(() =>
            buildPluginConfig(valid({ names: { "7": "faq.md" } }), "t"),
        ).toThrow("must not end in .md");
    });

    it("propagates an unknown-flavor error", () => {
        expect(() => buildPluginConfig(valid({ flavor: "nope" }), "t")).toThrow(
            /flavor/,
        );
    });
});

describe("mergeSettings", () => {
    it("layers saved data over the defaults", () => {
        const have = mergeSettings({ site: "ex", margin: 80 });
        expect(have.site).toBe("ex");
        expect(have.margin).toBe(80);
        expect(have.flavor).toBe(DEFAULT_SETTINGS.flavor);
    });

    it("defaults names for a file saved before they existed", () => {
        expect(mergeSettings({ site: "ex" }).names).toEqual({});
    });

    it("loads a data.json saved before mcpConfigPath unchanged", () => {
        // --- Given --- a complete file as a version-1 build wrote it.
        const saved = {
            schemaVersion: 1,
            site: "ex",
            account: "you@example.com",
            syncRoot: "confluence",
            timeoutSeconds: 60,
            margin: 80,
            flavor: "obsidian",
            comments: true,
            pages: { "a.md": "https://ex.atlassian.net/wiki/x/1" },
            folders: {},
            spaces: { docs: "DOC" },
            names: { "1": "Intro" },
        };

        // --- When ---
        const have = parseSettings(structuredClone(saved));

        // --- Then ---
        expect(have).toEqual({ ...saved, mcpConfigPath: "" });
    });

    it("keeps a saved mcpConfigPath", () => {
        const have = mergeSettings({ mcpConfigPath: "srd/project-config.md" });
        expect(have.mcpConfigPath).toBe("srd/project-config.md");
    });

    it("reads a file without schemaVersion as version 1", () => {
        expect(mergeSettings({ site: "ex" }).schemaVersion).toBe(1);
    });

    it("returns the defaults for a non-object", () => {
        expect(mergeSettings(null)).toEqual({
            ...DEFAULT_SETTINGS,
            schemaVersion: 1,
        });
        expect(mergeSettings([1])).toEqual({
            ...DEFAULT_SETTINGS,
            schemaVersion: 1,
        });
    });
});

describe("parseSettings", () => {
    it("accepts every version up to the supported one", () => {
        for (let v = 1; v <= SETTINGS_SCHEMA_VERSION; v++) {
            expect(parseSettings({ schemaVersion: v }).schemaVersion).toBe(v);
        }
    });

    it("accepts a file without schemaVersion", () => {
        expect(parseSettings({}).schemaVersion).toBe(1);
    });

    it("refuses a newer schema version", () => {
        expect(() =>
            parseSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION + 1 }),
        ).toThrow(SettingsVersionError);
    });

    it("refuses an invalid schema version", () => {
        for (const v of [0, -1, 1.5, "1", null]) {
            expect(() => parseSettings({ schemaVersion: v })).toThrow(
                /invalid schemaVersion/,
            );
        }
    });
});
