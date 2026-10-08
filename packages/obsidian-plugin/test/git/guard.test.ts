// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    autoCommits,
    findObsidianGit,
    type ObsidianGit,
    type ObsidianGitSettings,
    stopAutoCommit,
} from "../../src/git/guard.ts";

/** fake builds an obsidian-git stand-in recording saves and reloads. */
function fake(settings: ObsidianGitSettings, fail = false) {
    const calls: string[] = [];
    const og: ObsidianGit = {
        settings,
        saveSettings: async () => {
            calls.push("save");
            if (fail) throw new Error("disk full");
        },
        automaticsManager: {
            reload: (...t: string[]) => calls.push(`reload ${t.join(",")}`),
        },
    };
    return { og, calls };
}

describe("findObsidianGit", () => {
    it("finds an enabled obsidian-git only", () => {
        const { og } = fake({});
        const plugins = { "obsidian-git": og };

        expect(
            findObsidianGit({
                plugins,
                enabledPlugins: new Set(["obsidian-git"]),
            }),
        ).toBe(og);
        expect(
            findObsidianGit({ plugins, enabledPlugins: new Set() }),
        ).toBeNull();
        expect(
            findObsidianGit({ plugins: {}, enabledPlugins: new Set() }),
        ).toBeNull();
        expect(findObsidianGit(undefined)).toBeNull();
    });
});

describe("autoCommits", () => {
    it("flags a commit interval or commit-after-change", () => {
        expect(autoCommits({ autoSaveInterval: 5 })).toBe(true);
        expect(autoCommits({ autoBackupAfterFileChange: true })).toBe(true);
        expect(autoCommits({ autoSaveInterval: 0, autoPushInterval: 5 })).toBe(
            false,
        );
    });
});

describe("stopAutoCommit", () => {
    it("moves the interval to push only and reloads the timers", async () => {
        const { og, calls } = fake({
            autoSaveInterval: 5,
            autoPushInterval: 0,
            differentIntervalCommitAndPush: false,
            autoBackupAfterFileChange: true,
        });

        await stopAutoCommit(og);

        expect(og.settings).toEqual({
            autoSaveInterval: 0,
            autoPushInterval: 5,
            differentIntervalCommitAndPush: true,
            autoBackupAfterFileChange: false,
        });
        expect(autoCommits(og.settings)).toBe(false);
        expect(calls).toEqual(["save", "reload commit,push"]);
    });

    it("keeps a separate push interval", async () => {
        const { og } = fake({
            autoSaveInterval: 5,
            autoPushInterval: 30,
            differentIntervalCommitAndPush: true,
        });

        await stopAutoCommit(og);

        expect(og.settings.autoPushInterval).toBe(30);
    });

    it("restores the settings when saving fails", async () => {
        const { og } = fake({ autoSaveInterval: 5 }, true);

        await expect(stopAutoCommit(og)).rejects.toThrow("disk full");

        expect(og.settings).toEqual({ autoSaveInterval: 5 });
    });
});
