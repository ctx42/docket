// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// What every settings section shares: the context the tab hands it, and the
// whole-number field. DOM glue; the parsing is tab-model.ts.

import {
    type App,
    FileSystemAdapter,
    Setting,
    setIcon,
    setTooltip,
} from "obsidian";
import type docketPlugin from "../main.ts";
import { wholeNumber } from "./tab-model.ts";

/** SettingsCtx is what the tab hands each section it draws. */
export interface SettingsCtx {
    app: App;
    plugin: docketPlugin;
    /** commitScalar writes a field, persists it, and revalidates. */
    commitScalar(write: () => void): void;
    /** persist schedules a debounced `data.json` write. */
    persist(): void;
    /** flush runs a pending persist at once. */
    flush(): void;
    /** refreshValidation redraws the banner and marks the row it names. */
    refreshValidation(): void;
    /** redisplay redraws the whole tab. */
    redisplay(): void;
}

/**
 * numberSetting adds a whole-number field that commits only a value `parse`
 * accepts (by default any whole number); anything else is marked invalid
 * and left unsaved.
 */
export function numberSetting(
    parent: HTMLElement,
    name: string,
    desc: string,
    placeholder: string,
    value: number,
    commit: (n: number) => void,
    parse: (v: string) => number | null = wholeNumber,
): void {
    new Setting(parent)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
            t.inputEl.type = "number";
            t.inputEl.min = "0";
            t.setPlaceholder(placeholder)
                .setValue(String(value))
                .onChange((v) => {
                    const n = parse(v);
                    const ok = n !== null;
                    t.inputEl.toggleClass("is-invalid", !ok);
                    t.inputEl.setAttribute("aria-invalid", String(!ok));
                    if (ok) commit(n);
                });
        });
}

/**
 * Scope is where a section's values live: in the exported `.docket.yaml`, or
 * on this device only. Sections whose values live in `data.json` carry none.
 */
export type Scope = "exported" | "device";

/** SCOPE_TAG is each scope's label, icon, and tooltip. */
const SCOPE_TAG: Record<Scope, { text: string; icon: string; tip: string }> = {
    exported: {
        text: "exported",
        icon: "share-2",
        tip: "Included when you export .docket.yaml",
    },
    device: {
        text: "this device",
        icon: "monitor",
        tip: "Stored on this device only",
    },
};

/** scopeTag appends a small scope label to `parent`. */
export function scopeTag(parent: HTMLElement, scope: Scope): void {
    const tag = SCOPE_TAG[scope];
    const el = parent.createSpan({ cls: "docket-scope" });
    setIcon(el.createSpan({ cls: "docket-scope-icon" }), tag.icon);
    el.createSpan({ text: tag.text });
    setTooltip(el, tag.tip);
}

/** scopeHeading adds a section heading named `name` with a scope label. */
export function scopeHeading(
    parent: HTMLElement,
    name: string,
    scope: Scope,
): Setting {
    const heading = new Setting(parent).setName(name).setHeading();
    scopeTag(heading.nameEl, scope);
    return heading;
}

/** vaultBasePath returns the vault's absolute disk path, or `""` when it has none. */
export function vaultBasePath(app: App): string {
    const adapter = app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
}
