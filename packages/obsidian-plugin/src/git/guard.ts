// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The obsidian-git auto-commit guard. docket's grouped commits only work while
// nothing else commits the vault behind them, so when obsidian-git is enabled and
// commits on its own timer, the Git tab warns and offers a fix: keep its
// automatic push (and pull) but stop its automatic commit. The fix writes through
// obsidian-git's live settings object and its own `saveSettings()`, then asks it
// to restart its timers. No Obsidian import: the plugin registry is passed in.

/** OBSIDIAN_GIT_ID is obsidian-git's plugin id. */
export const OBSIDIAN_GIT_ID = "obsidian-git";

/** ObsidianGitSettings are the obsidian-git settings the guard reads and writes. */
export interface ObsidianGitSettings {
    autoSaveInterval?: number;
    autoPushInterval?: number;
    differentIntervalCommitAndPush?: boolean;
    autoBackupAfterFileChange?: boolean;
}

/** ObsidianGit is the slice of obsidian-git's plugin instance the guard uses. */
export interface ObsidianGit {
    settings: ObsidianGitSettings;
    saveSettings(): Promise<void>;
    automaticsManager?: { reload?(...types: string[]): void };
}

/** PluginRegistry is the slice of Obsidian's undocumented `app.plugins`. */
export interface PluginRegistry {
    plugins?: Record<string, unknown>;
    enabledPlugins?: { has(id: string): boolean };
}

/**
 * findObsidianGit returns obsidian-git's loaded instance when it is enabled and
 * exposes settings plus `saveSettings`, or null.
 */
export function findObsidianGit(
    registry: PluginRegistry | undefined,
): ObsidianGit | null {
    if (registry?.enabledPlugins?.has(OBSIDIAN_GIT_ID) !== true) return null;
    const p = registry.plugins?.[OBSIDIAN_GIT_ID] as
        | Partial<ObsidianGit>
        | undefined;
    if (
        p === undefined ||
        typeof p.settings !== "object" ||
        p.settings === null ||
        typeof p.saveSettings !== "function"
    ) {
        return null;
    }
    return p as ObsidianGit;
}

/**
 * autoCommits reports whether obsidian-git commits on its own: a commit
 * interval is set (with or without a separate push interval, it commits on it),
 * or it commits after file changes.
 */
export function autoCommits(s: ObsidianGitSettings): boolean {
    return (
        (s.autoSaveInterval ?? 0) > 0 || s.autoBackupAfterFileChange === true
    );
}

/**
 * stopAutoCommit turns obsidian-git's automatic commit off, moving a combined
 * commit-and-sync interval over to push only, saves, and reloads its timers.
 * It throws when saving fails; the settings are then restored.
 */
export async function stopAutoCommit(og: ObsidianGit): Promise<void> {
    const s = og.settings;
    const before = { ...s };
    const separate = s.differentIntervalCommitAndPush === true;
    s.autoPushInterval = separate
        ? (s.autoPushInterval ?? 0)
        : (s.autoSaveInterval ?? 0);
    s.differentIntervalCommitAndPush = true;
    s.autoSaveInterval = 0;
    s.autoBackupAfterFileChange = false;
    try {
        await og.saveSettings();
    } catch (err) {
        for (const k of Object.keys(s) as (keyof ObsidianGitSettings)[]) {
            if (!(k in before)) delete s[k];
        }
        Object.assign(s, before);
        throw err;
    }
    og.automaticsManager?.reload?.("commit", "push");
}
