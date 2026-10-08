// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's settings tab. It composes the sections — Connection
// (section-connection.ts), Synced locations (section-locations.ts), Notes,
// Git and Advanced (section-options.ts), and MCP server (section-mcp.ts) —
// owns the debounced `data.json` write they share, and shows the first
// `buildConfig` validation error as a banner at the top, marking the location
// row it names. All logic worth asserting lives in
// `tab-model.ts`/`locations.ts`/`model.ts`/`store.ts`/`../mcp/config.ts`;
// the DOM glue is verified by typecheck + manual load.

import { type App, Notice, PluginSettingTab, setIcon } from "obsidian";
import type docketPlugin from "../main.ts";
import { type Debounced, debounce } from "./debounce.ts";
import type { SettingsCtx } from "./fields.ts";
import { connectionSection } from "./section-connection.ts";
import { LocationsSection } from "./section-locations.ts";
import { McpSection } from "./section-mcp.ts";
import {
    advancedSection,
    gitSection,
    notesSection,
} from "./section-options.ts";
import { errorMessage, validation } from "./tab-model.ts";

/**
 * PERSIST_DEBOUNCE_MS coalesces keystrokes into one `data.json` write. Long
 * enough that ordinary typing writes once at the end, short enough that a pause
 * still saves promptly; any tab hide or explicit commit flushes before it lapses.
 */
export const PERSIST_DEBOUNCE_MS = 400;

export class docketSettingTab extends PluginSettingTab {
    private bannerEl: HTMLElement | null = null;
    private readonly ctx: SettingsCtx;
    private readonly mcp: McpSection;

    /**
     * persist debounces `data.json` writes so a burst of keystrokes collapses
     * into one write. Its errors surface (console + Notice) instead of being
     * swallowed. It is flushed on {@link hide} and on every map commit so the
     * final keystrokes are never lost.
     */
    private readonly persist: Debounced<[]> = debounce(() => {
        this.plugin.persistSettings().catch((err: unknown) => {
            const msg = errorMessage(err);
            console.error("docket: failed to persist settings", err);
            new Notice(`docket: failed to save settings: ${msg}`);
        });
    }, PERSIST_DEBOUNCE_MS);

    constructor(
        app: App,
        private readonly plugin: docketPlugin,
    ) {
        super(app, plugin);
        this.ctx = {
            app,
            plugin,
            // commitScalar writes a scalar field, persists, and revalidates —
            // the work every field's onChange shares.
            commitScalar: (write) => {
                write();
                this.persist();
                this.refreshValidation();
            },
            persist: () => this.persist(),
            flush: () => this.persist.flush(),
            refreshValidation: () => this.refreshValidation(),
            redisplay: () => this.display(),
        };
        this.mcp = new McpSection(this.ctx, PERSIST_DEBOUNCE_MS);
    }

    /** hide flushes any pending debounced write so no keystrokes are lost when
     * the settings tab closes. */
    override hide(): void {
        this.persist.flush();
        this.mcp.cancel();
        // A config path left edited restarts the server on it.
        void this.plugin.mcp.configChanged();
        super.hide();
    }

    /**
     * display builds the settings tab imperatively with the `Setting` API, the
     * form available on every supported Obsidian (unlike the declarative
     * `getSettingDefinitions` API, which is 1.13+ only). Each scalar field writes
     * its change straight back to the settings, schedules a debounced persist, and
     * refreshes the validation banner. Obsidian calls this on open, and an import
     * calls it to re-render.
     */
    override display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass("docket-settings");

        this.bannerEl = containerEl.createDiv({ cls: "docket-banner" });
        connectionSection(this.ctx, containerEl);
        new LocationsSection(this.ctx).render(containerEl);
        notesSection(this.ctx, containerEl);
        gitSection(this.ctx, containerEl);
        this.mcp.render(containerEl);
        advancedSection(this.ctx, containerEl);
        this.refreshValidation();
    }

    /**
     * refreshValidation shows the first buildConfig error as the top banner (or
     * hides it) and marks the location row the error names.
     */
    private refreshValidation(): void {
        const banner = this.bannerEl;
        if (banner === null) {
            return;
        }
        const v = validation(this.plugin.settings, this.plugin.token);
        banner.empty();
        banner.toggleClass("is-visible", v.message !== "");
        if (v.message !== "") {
            setIcon(
                banner.createSpan({ cls: "docket-banner-icon" }),
                "alert-triangle",
            );
            banner.createSpan({ text: v.message });
        }
        for (const row of Array.from(
            this.containerEl.querySelectorAll<HTMLElement>(".docket-location"),
        )) {
            row.toggleClass(
                "is-invalid",
                v.dest !== "" && row.dataset["dest"] === v.dest,
            );
        }
    }
}
