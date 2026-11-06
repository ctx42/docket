// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import {
    applyTerminalIcon,
    LEAN_TERMINAL_ICON,
    LEAN_TERMINAL_ID,
    type LeanRegistry,
    leanTerminalProblem,
} from "../src/lean-terminal.ts";

/** registry builds a plugin registry holding `instance` as Lean Terminal. */
function registry(instance?: unknown, enabled = true): LeanRegistry {
    return {
        manifests: { [LEAN_TERMINAL_ID]: {} },
        enabledPlugins: new Set(enabled ? [LEAN_TERMINAL_ID] : []),
        plugins: instance === undefined ? {} : { [LEAN_TERMINAL_ID]: instance },
    };
}

/** terminal builds a Lean Terminal instance with the given ribbon icon. */
function terminal(ribbonIcon: string) {
    return {
        settings: { ribbonIcon },
        saveSettings: vi.fn(async () => {}),
        updateIcon: vi.fn(),
    };
}

describe("leanTerminalProblem", () => {
    const ready = { binaryManager: { isReady: () => true } };

    it("says nothing when the terminal is ready", () => {
        expect(leanTerminalProblem(registry(ready))).toBe("");
    });

    it("reports a plugin that is not installed", () => {
        // --- Given ---
        const r: LeanRegistry = { manifests: {} };

        // --- When ---
        const have = leanTerminalProblem(r);

        // --- Then ---
        expect(have).toBe(
            "Lean Terminal is not installed. You need it to start Claude in this vault. Install it under Settings → Community plugins.",
        );
    });

    it("reports a plugin that is turned off", () => {
        expect(leanTerminalProblem(registry(undefined, false))).toBe(
            "Lean Terminal is turned off. Turn it on under Settings → Community plugins.",
        );
    });

    it("reports binaries that are not downloaded", () => {
        // --- Given ---
        const instance = { binaryManager: { isReady: () => false } };

        // --- When ---
        const have = leanTerminalProblem(registry(instance));

        // --- Then ---
        expect(have).toBe(
            "Lean Terminal cannot open a terminal yet. Select Download under Settings → Lean Terminal.",
        );
    });

    it("waits for an enabled plugin that has not loaded yet", () => {
        expect(leanTerminalProblem(registry())).toBe("");
    });

    it("trusts a version without the binaries check", () => {
        expect(leanTerminalProblem(registry({}))).toBe("");
    });

    it("says nothing when Obsidian hides its plugin registry", () => {
        expect(leanTerminalProblem(undefined)).toBe("");
    });
});

describe("applyTerminalIcon", () => {
    it("replaces the default icon, saves, and redraws it", async () => {
        // --- Given ---
        const instance = terminal("terminal");

        // --- When ---
        const have = await applyTerminalIcon(registry(instance));

        // --- Then ---
        expect(have).toBe(true);
        expect(instance.settings.ribbonIcon).toBe(LEAN_TERMINAL_ICON);
        expect(instance.saveSettings).toHaveBeenCalledOnce();
        expect(instance.updateIcon).toHaveBeenCalledWith(LEAN_TERMINAL_ICON);
    });

    it("leaves an icon the user chose", async () => {
        // --- Given ---
        const instance = terminal("rocket");

        // --- When ---
        const have = await applyTerminalIcon(registry(instance));

        // --- Then ---
        expect(have).toBe(true);
        expect(instance.settings.ribbonIcon).toBe("rocket");
        expect(instance.saveSettings).not.toHaveBeenCalled();
    });

    it("reports not done while the plugin is not loaded", async () => {
        expect(await applyTerminalIcon(registry())).toBe(false);
        expect(await applyTerminalIcon(undefined)).toBe(false);
    });

    it("skips a turned-off plugin", async () => {
        // --- Given ---
        const instance = terminal("terminal");

        // --- When ---
        const have = await applyTerminalIcon(registry(instance, false));

        // --- Then ---
        expect(have).toBe(false);
        expect(instance.settings.ribbonIcon).toBe("terminal");
    });

    it("skips a version with other settings or methods", async () => {
        // --- Given ---
        const noUpdate = { settings: { ribbonIcon: "terminal" } };
        const noSettings = { saveSettings: async () => {} };

        // --- When ---
        const hNoUpdate = await applyTerminalIcon(registry(noUpdate));
        const hNoSettings = await applyTerminalIcon(registry(noSettings));

        // --- Then ---
        expect(hNoUpdate).toBe(false);
        expect(hNoSettings).toBe(false);
        expect(noUpdate.settings.ribbonIcon).toBe("terminal");
    });

    it("reports not done when saving fails", async () => {
        // --- Given ---
        const instance = terminal("terminal");
        instance.saveSettings.mockRejectedValue(new Error("disk full"));

        // --- When ---
        const have = await applyTerminalIcon(registry(instance));

        // --- Then ---
        expect(have).toBe(false);
        expect(instance.updateIcon).not.toHaveBeenCalled();
    });
});
