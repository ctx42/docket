// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The Lean Terminal companion plugin. Claude starts from its terminal, so the
// Sync tab warns while it is not ready, and docket gives its ribbon button the
// team's icon. Sync itself does not need it, so nothing here stops docket. The
// icon is written through Lean Terminal's live settings and its own
// `saveSettings()`. No Obsidian import: the plugin registry is passed in.

import type { PluginRegistry } from "./git/guard.ts";

/** LEAN_TERMINAL_ID is Lean Terminal's plugin id. */
export const LEAN_TERMINAL_ID = "lean-terminal";

/** LEAN_TERMINAL_ICON is the ribbon icon docket gives Lean Terminal. */
export const LEAN_TERMINAL_ICON = "square-chevron-right";

/** DEFAULT_ICON is Lean Terminal's own ribbon icon. */
const DEFAULT_ICON = "terminal";

/** LeanRegistry is the plugin registry with its installed manifests. */
export type LeanRegistry = PluginRegistry & {
    manifests?: Record<string, unknown>;
};

/** LeanTerminal is the slice of Lean Terminal's plugin instance docket uses. */
interface LeanTerminal {
    settings?: { ribbonIcon?: unknown };
    saveSettings?: () => Promise<void>;
    updateIcon?: (icon: string) => void;
    binaryManager?: { isReady?: () => boolean };
}

/**
 * leanTerminalProblem returns what keeps Lean Terminal from opening a terminal,
 * or `""` when nothing does. Without a registry, or for a plugin still loading,
 * it reports nothing, so a warning is never a false alarm.
 */
export function leanTerminalProblem(
    registry: LeanRegistry | undefined,
): string {
    if (registry?.manifests === undefined) return "";
    if (!(LEAN_TERMINAL_ID in registry.manifests)) {
        return "Lean Terminal is not installed. You need it to start Claude in this vault. Install it under Settings → Community plugins.";
    }
    if (registry.enabledPlugins?.has(LEAN_TERMINAL_ID) !== true) {
        return "Lean Terminal is turned off. Turn it on under Settings → Community plugins.";
    }
    const instance = registry.plugins?.[LEAN_TERMINAL_ID] as
        | LeanTerminal
        | undefined;
    if (instance?.binaryManager?.isReady?.() === false) {
        return "Lean Terminal cannot open a terminal yet. Select Download under Settings → Lean Terminal.";
    }
    return "";
}

/**
 * applyTerminalIcon gives Lean Terminal {@link LEAN_TERMINAL_ICON} while it
 * still has its default icon, leaving a user's own choice alone. It reports
 * whether the work is done, so false means trying again later: the plugin is
 * off, not loaded, a version without these settings, or its save failed.
 */
export async function applyTerminalIcon(
    registry: LeanRegistry | undefined,
): Promise<boolean> {
    if (registry?.enabledPlugins?.has(LEAN_TERMINAL_ID) !== true) return false;
    const instance = registry.plugins?.[LEAN_TERMINAL_ID] as
        | LeanTerminal
        | undefined;
    const { settings, saveSettings, updateIcon } = instance ?? {};
    if (
        settings === undefined ||
        typeof saveSettings !== "function" ||
        typeof updateIcon !== "function"
    ) {
        return false;
    }
    if (settings.ribbonIcon !== DEFAULT_ICON) return true;
    const before = settings.ribbonIcon;
    settings.ribbonIcon = LEAN_TERMINAL_ICON;
    try {
        await saveSettings.call(instance);
    } catch {
        settings.ribbonIcon = before;
        return false;
    }
    updateIcon.call(instance, LEAN_TERMINAL_ICON);
    return true;
}
