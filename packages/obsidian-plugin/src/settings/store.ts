// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Persistence for the plugin's configuration. The shareable settings live in the
// plugin's `data.json` (via Obsidian's `loadData`/`saveData`); the API token is a
// per-device secret kept out of that file, in per-vault localStorage (via
// `app.loadLocalStorage`/`saveLocalStorage`), so a synced `data.json` never
// carries the credential. Only methods on the injected `plugin` are used, so this
// module needs no Obsidian value import and is testable with a fake.

import {
    type docketSettings,
    mergeSettings,
    SETTINGS_SCHEMA_VERSION,
} from "@docket/core";
import type { Plugin } from "obsidian";
import { HISTORY_CAP, parseHistoryCap } from "../git/history.ts";

/** TOKEN_KEY is the per-vault localStorage key the API token is stored under. */
export const TOKEN_KEY = "docket-token";

/**
 * loadSettings reads the persisted settings from `data.json` and layers them over
 * the defaults (see `mergeSettings`), so a partial or absent file still yields a
 * complete, valid settings object (new fields added in later versions default
 * cleanly).
 */
export async function loadSettings(plugin: Plugin): Promise<docketSettings> {
    return mergeSettings(await plugin.loadData());
}

/**
 * saveSettings writes the settings to `data.json`, stamped with the current
 * {@link SETTINGS_SCHEMA_VERSION} so a file written before the field existed
 * gains it. The token is not included.
 */
export async function saveSettings(
    plugin: Plugin,
    settings: docketSettings,
): Promise<void> {
    await plugin.saveData({
        ...settings,
        schemaVersion: SETTINGS_SCHEMA_VERSION,
    });
}

/** loadToken reads the API token from per-vault localStorage, or `""` when unset. */
export function loadToken(plugin: Plugin): string {
    const value = plugin.app.loadLocalStorage(TOKEN_KEY);
    return typeof value === "string" ? value : "";
}

/**
 * saveToken writes the API token to per-vault localStorage, clearing the entry
 * (storing `null`) when the token is empty so no stale secret lingers.
 */
export function saveToken(plugin: Plugin, token: string): void {
    plugin.app.saveLocalStorage(TOKEN_KEY, token === "" ? null : token);
}

/** HIDE_PROPS_KEY is the localStorage key of the "hide docket properties" choice. */
export const HIDE_PROPS_KEY = "docket-hide-properties";

/**
 * loadHideProps reads whether this device hides the `docket_*` properties in the
 * Properties panel — a per-device display choice, so it stays out of
 * `data.json`. It defaults to true.
 */
export function loadHideProps(plugin: Plugin): boolean {
    return plugin.app.loadLocalStorage(HIDE_PROPS_KEY) !== "0";
}

/** saveHideProps records this device's "hide docket properties" choice. */
export function saveHideProps(plugin: Plugin, hide: boolean): void {
    plugin.app.saveLocalStorage(HIDE_PROPS_KEY, hide ? null : "0");
}

/** GIT_PATH_KEY is the localStorage key of this device's git binary path. */
export const GIT_PATH_KEY = "docket-git-path";

/**
 * loadGitPath reads this device's git binary path — a per-device choice, since
 * installs differ between machines — or `""` for whatever PATH finds.
 */
export function loadGitPath(plugin: Plugin): string {
    const value = plugin.app.loadLocalStorage(GIT_PATH_KEY);
    return typeof value === "string" ? value : "";
}

/** saveGitPath records this device's git binary path; `""` clears it. */
export function saveGitPath(plugin: Plugin, path: string): void {
    plugin.app.saveLocalStorage(GIT_PATH_KEY, path === "" ? null : path);
}

/** DIFF_SIGNS_KEY is the localStorage key of the "change bars" choice. */
export const DIFF_SIGNS_KEY = "docket-diff-signs";

/** loadDiffSigns reads whether this device shows editor change bars; default on. */
export function loadDiffSigns(plugin: Plugin): boolean {
    return plugin.app.loadLocalStorage(DIFF_SIGNS_KEY) !== "0";
}

/** saveDiffSigns records this device's "change bars" choice. */
export function saveDiffSigns(plugin: Plugin, on: boolean): void {
    plugin.app.saveLocalStorage(DIFF_SIGNS_KEY, on ? null : "0");
}

/** MCP_ENABLED_KEY is the localStorage key of this device's MCP server switch. */
export const MCP_ENABLED_KEY = "docket-mcp-enabled";

/**
 * loadMcpEnabled reads whether this device runs the MCP server; off unless
 * switched on, so a synced vault never starts a server on its own.
 */
export function loadMcpEnabled(plugin: Plugin): boolean {
    return plugin.app.loadLocalStorage(MCP_ENABLED_KEY) === "1";
}

/** saveMcpEnabled stores this device's MCP server switch. */
export function saveMcpEnabled(plugin: Plugin, on: boolean): void {
    plugin.app.saveLocalStorage(MCP_ENABLED_KEY, on ? "1" : null);
}

/** COMMIT_HISTORY_KEY is the localStorage key of this device's commit messages. */
export const COMMIT_HISTORY_KEY = "docket-commit-history";

/**
 * loadCommitHistory reads this device's committed messages, most recent first;
 * anything other than a list of strings reads as none.
 */
export function loadCommitHistory(plugin: Plugin): string[] {
    const value: unknown = plugin.app.loadLocalStorage(COMMIT_HISTORY_KEY);
    if (!Array.isArray(value)) return [];
    return value.filter((m): m is string => typeof m === "string");
}

/** saveCommitHistory records this device's commit messages; none clears it. */
export function saveCommitHistory(plugin: Plugin, list: string[]): void {
    plugin.app.saveLocalStorage(
        COMMIT_HISTORY_KEY,
        list.length === 0 ? null : list,
    );
}

/** HISTORY_CAP_KEY is the localStorage key of this device's history cap. */
export const HISTORY_CAP_KEY = "docket-commit-history-cap";

/**
 * loadHistoryCap reads how many commit messages this device keeps, or
 * {@link HISTORY_CAP} when unset or out of range.
 */
export function loadHistoryCap(plugin: Plugin): number {
    const value: unknown = plugin.app.loadLocalStorage(HISTORY_CAP_KEY);
    if (typeof value !== "string") return HISTORY_CAP;
    return parseHistoryCap(value) ?? HISTORY_CAP;
}

/** saveHistoryCap records this device's history cap; the default clears it. */
export function saveHistoryCap(plugin: Plugin, cap: number): void {
    plugin.app.saveLocalStorage(
        HISTORY_CAP_KEY,
        cap === HISTORY_CAP ? null : String(cap),
    );
}
