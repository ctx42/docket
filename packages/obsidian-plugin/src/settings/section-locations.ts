// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The settings tab's Synced locations section: the sync folder, the locations
// list (added and edited through a dialog, or picked from Confluence), and the
// `.docket.yaml` import and export. DOM glue; the logic is locations.ts and
// portable.ts.

import { homedir } from "node:os";
import { posixDir } from "@docket/core";
import { Notice, parseYaml, Setting, setIcon, stringifyYaml } from "obsidian";
import { confirmModal } from "../ui/confirm.ts";
import { confirmOverwrite, promptVaultPath } from "./dialogs.ts";
import { type SettingsCtx, vaultBasePath } from "./fields.ts";
import {
    confluenceClient,
    confluenceTitles,
    editLocation,
} from "./location-modal.ts";
import {
    KIND_LABEL,
    type Location,
    type LocationKind,
    locations,
    putLocation,
    removeLocation,
} from "./locations.ts";
import type { docketSettings } from "./model.ts";
import { browseConfluence } from "./picker-modal.ts";
import {
    applyImportedMaps,
    expandTilde,
    isInVault,
    resolvePortablePath,
    toPortableConfig,
} from "./portable.ts";
import { VaultPathSuggest } from "./suggest.ts";
import { errorMessage } from "./tab-model.ts";
import { readPath, statPath, writePath } from "./vault-io.ts";

/** KIND_ICON is each location kind's icon in the list. */
const KIND_ICON: Record<LocationKind, string> = {
    page: "file-text",
    folder: "folder",
    space: "library",
};

export class LocationsSection {
    private listEl: HTMLElement | null = null;

    constructor(private readonly ctx: SettingsCtx) {}

    /** render draws the section into `el`. */
    render(el: HTMLElement): void {
        const s = this.ctx.plugin.settings;

        new Setting(el)
            .setName("Synced locations")
            .setHeading()
            .addButton((b) =>
                b
                    .setButtonText("Browse Confluence…")
                    .onClick(() => void this.browse()),
            )
            .addButton((b) =>
                b
                    .setButtonText("Add location")
                    .setCta()
                    .onClick(() => void this.edit(null)),
            );

        new Setting(el)
            .setName("Sync folder")
            .setDesc(
                "The vault folder every location below is relative to. Empty syncs into the whole vault.",
            )
            .addText((t) => {
                t.setPlaceholder("(vault root)")
                    .setValue(s.syncRoot)
                    .onChange((v) =>
                        this.ctx.commitScalar(() => {
                            s.syncRoot = v.trim();
                        }),
                    );
                new VaultPathSuggest(
                    this.ctx.app,
                    t.inputEl,
                    "folders",
                    () => "",
                );
            });

        this.listEl = el.createDiv({ cls: "docket-locations" });
        this.renderList();

        new Setting(el)
            .setName("Import / export")
            .setDesc(
                "Share the synced locations as a .docket.yaml file. It never includes your credentials.",
            )
            .addButton((b) =>
                b.setButtonText("Import").onClick(() => {
                    void this.importPortable();
                }),
            )
            .addButton((b) =>
                b.setButtonText("Export").onClick(() => {
                    void this.exportPortable();
                }),
            );
    }

    /** renderList redraws the synced-locations list. */
    private renderList(): void {
        const el = this.listEl;
        if (el === null) return;
        el.empty();
        const list = locations(this.ctx.plugin.settings);
        if (list.length === 0) {
            el.createDiv({
                cls: "docket-locations-empty setting-item-description",
                text: "Nothing synced yet. Add a Confluence page, folder, or space.",
            });
            return;
        }
        for (const l of list) {
            const row = new Setting(el).setDesc(l.src);
            row.settingEl.addClass("docket-location");
            row.settingEl.dataset["dest"] = l.dest;
            const icon = row.nameEl.createSpan({
                cls: "docket-location-icon",
                attr: { "aria-label": KIND_LABEL[l.kind] },
            });
            setIcon(icon, KIND_ICON[l.kind]);
            row.nameEl.createSpan({ text: l.dest });
            row.addExtraButton((b) =>
                b
                    .setIcon("pencil")
                    .setTooltip("Edit")
                    .onClick(() => void this.edit(l)),
            ).addExtraButton((b) =>
                b
                    .setIcon("trash-2")
                    .setTooltip("Remove (the notes stay in the vault)")
                    .onClick(() => {
                        this.save(removeLocation(this.ctx.plugin.settings, l));
                    }),
            );
        }
    }

    /** edit opens the location dialog and saves what it returns. */
    private async edit(prev: Location | null): Promise<void> {
        const { app, plugin } = this.ctx;
        const next = await editLocation(
            app,
            plugin.settings,
            prev,
            confluenceTitles(plugin.settings, plugin.token),
        );
        if (next === null) return;
        this.save(putLocation(plugin.settings, next, prev));
    }

    /**
     * browse opens the Confluence picker and saves the changes it returns. It
     * needs the connection filled in, and says so otherwise.
     */
    private async browse(): Promise<void> {
        const { app, plugin } = this.ctx;
        const client = confluenceClient(plugin.settings, plugin.token);
        if (client === null) {
            new Notice(
                "docket: fill in the site, account email, and API token first.",
            );
            return;
        }
        const next = await browseConfluence(
            app,
            client,
            plugin.settings,
            plugin.token,
        );
        if (next === null) return;
        this.save(next);
    }

    /** save stores changed settings at once and redraws the list. */
    private save(next: docketSettings): void {
        this.ctx.plugin.settings = next;
        this.ctx.persist();
        this.ctx.flush();
        this.renderList();
        this.ctx.refreshValidation();
    }

    /**
     * exportPortable prompts for a path — vault-relative, an absolute OS path, or
     * a `~`-relative one — resolves it (a folder gets the file name appended), and
     * writes the current shareable config as `.docket.yaml`. The target's
     * containing folder must already exist — export never creates directories, so
     * a path into a missing folder is rejected. An existing target file is
     * overwritten only after confirmation. A target inside the vault needs
     * confirmation too: the CLI refuses to run from a vault folder holding a
     * `.docket.yaml`. Any failure surfaces as a Notice rather than throwing.
     */
    private async exportPortable(): Promise<void> {
        const { app, plugin } = this.ctx;
        const input = await promptVaultPath(app, {
            title: "Export .docket.yaml",
            placeholder: plugin.settings.syncRoot || "folder or file path",
            cta: "Export",
        });
        if (input === null) {
            return;
        }
        try {
            const expanded = expandTilde(input, homedir());
            const inputStat = await statPath(app, expanded);
            const path = resolvePortablePath(
                expanded,
                inputStat?.type === "folder",
            );
            const dir = posixDir(path);
            if (dir !== "." && (await statPath(app, dir))?.type !== "folder") {
                new Notice(`docket: no such folder: ${dir}`);
                return;
            }
            if (
                isInVault(path, vaultBasePath(app)) &&
                !(await confirmModal(
                    app,
                    "Export inside the vault?",
                    "Inside a vault the docket CLI reads this plugin's " +
                        "settings, so it will refuse to run from this folder " +
                        "while this file exists:",
                    [path],
                    "Export",
                ))
            ) {
                return;
            }
            if ((await statPath(app, path)) !== null) {
                if (!(await confirmOverwrite(app, path))) {
                    return;
                }
            }
            const text = stringifyYaml(toPortableConfig(plugin.settings));
            await writePath(app, path, text);
            new Notice(`docket: exported to ${path}`);
        } catch (err) {
            new Notice(`docket: export failed: ${errorMessage(err)}`);
        }
    }

    /**
     * importPortable prompts for a path — vault-relative, an absolute OS path, or
     * a `~`-relative one — resolves it (a folder gets the file name appended),
     * reads and parses the YAML, merges its page/folder/space maps into the
     * settings (incoming wins), persists, and re-renders. Any failure surfaces as
     * a Notice rather than throwing.
     */
    private async importPortable(): Promise<void> {
        const { app, plugin } = this.ctx;
        const input = await promptVaultPath(app, {
            title: "Import .docket.yaml",
            placeholder: plugin.settings.syncRoot || "folder or file path",
            cta: "Import",
        });
        if (input === null) {
            return;
        }
        try {
            const expanded = expandTilde(input, homedir());
            const inputStat = await statPath(app, expanded);
            const path = resolvePortablePath(
                expanded,
                inputStat?.type === "folder",
            );
            const text = await readPath(app, path);
            const { settings, imported } = applyImportedMaps(
                plugin.settings,
                parseYaml(text),
            );
            plugin.settings = settings;
            await plugin.persistSettings();
            this.ctx.redisplay();
            new Notice(`docket: imported ${imported} mappings from ${path}`);
        } catch (err) {
            new Notice(`docket: import failed: ${errorMessage(err)}`);
        }
    }
}
