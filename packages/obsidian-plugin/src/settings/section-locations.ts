// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The settings tab's Sources section: the `.docket.yaml` import and export,
// and the Confluence card — the sync folder, the connection (folded to one
// line once it is filled in), and the synced locations as a tree of titles
// (added and edited through a dialog, or picked from Confluence). DOM glue;
// the logic is location-tree.ts, locations.ts, and portable.ts.

import { homedir } from "node:os";
import { posixDir, siteDomain, syncFolder } from "@docket/core";
import {
    Menu,
    Notice,
    normalizePath,
    parseYaml,
    Setting,
    setIcon,
    setTooltip,
    stringifyYaml,
} from "obsidian";
import { confirmOverwrite, promptVaultPath } from "./dialogs.ts";
import { type SettingsCtx, scopeTag } from "./fields.ts";
import {
    confluenceClient,
    confluenceTitles,
    editLocation,
} from "./location-modal.ts";
import {
    buildTree,
    FILTER_AT,
    notePath,
    pageUrl,
    type TreeGroup,
    type TreeRow,
} from "./location-tree.ts";
import {
    KIND_LABEL,
    type Location,
    type LocationKind,
    locations,
    putLocation,
    removeLocation,
} from "./locations.ts";
import type { docketSettings } from "./model.ts";
import { electronDialog, pickFile, pickFolder } from "./native-picker.ts";
import { browseConfluence } from "./picker-modal.ts";
import {
    applyImportedMaps,
    expandTilde,
    importSummary,
    isPortableConfig,
    resolvePortablePath,
    toPortableConfig,
} from "./portable.ts";
import { connectionRows } from "./section-connection.ts";
import { KnowledgeSection } from "./section-knowledge.ts";
import {
    connectionReady,
    errorMessage,
    syncFolderDesc,
    validation,
} from "./tab-model.ts";
import { readPath, statPath, writePath } from "./vault-io.ts";

/** KIND_ICON is the icon each location kind shows by its title. */
const KIND_ICON: Record<LocationKind, string> = {
    page: "file-text",
    folder: "folder",
    space: "library",
};

/**
 * LocationsSection draws the Sources section. It keeps the card's view state
 * — whether the connection is unfolded, the filter, and which groups the user
 * opened or closed — across redraws of the tree.
 */
export class LocationsSection {
    private cardEl: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private connOpen = false;
    private query = "";
    private readonly open = new Map<string, boolean>();

    private readonly kb: KnowledgeSection;

    constructor(private readonly ctx: SettingsCtx) {
        this.kb = new KnowledgeSection(ctx);
    }

    render(el: HTMLElement): void {
        const heading = new Setting(el)
            .setName("Sources")
            .setHeading()
            .addExtraButton((b) =>
                b
                    .setIcon("download")
                    .setTooltip("Import a config from a file or the clipboard")
                    .onClick(() => this.importMenu(b.extraSettingsEl)),
            )
            .addExtraButton((b) =>
                b
                    .setIcon("upload")
                    .setTooltip(
                        "Export the sources and shared options to a folder " +
                            "or the clipboard. It never includes your " +
                            "credentials.",
                    )
                    .onClick(() => this.exportMenu(b.extraSettingsEl)),
            )
            .addButton((b) =>
                b
                    .setButtonText("Add ▾")
                    .setCta()
                    .setTooltip("Add a Confluence location or a knowledge base")
                    .onClick(() => this.addMenu(b.buttonEl)),
            );
        scopeTag(heading.nameEl, "exported");

        this.cardEl = el.createDiv({ cls: "docket-source" });
        this.renderCard();
        this.kb.render(el);
    }

    /** addMenu opens the Add menu under `anchor`. */
    private addMenu(anchor: HTMLElement): void {
        const menu = new Menu();
        menu.addItem((i) =>
            i
                .setTitle("Confluence page, folder, or space…")
                .setIcon("link")
                .onClick(() => void this.edit(null)),
        );
        menu.addItem((i) =>
            i
                .setTitle("Browse Confluence…")
                .setIcon("globe")
                .onClick(() => void this.browse()),
        );
        menu.addSeparator();
        menu.addItem((i) =>
            i
                .setTitle("Git repository…")
                .setIcon("git-branch")
                .onClick(() => void this.kb.addGit()),
        );
        menu.addItem((i) =>
            i
                .setTitle("Local folder…")
                .setIcon("folder")
                .onClick(() => void this.kb.addLocal()),
        );
        showBelow(menu, anchor);
    }

    /** renderCard draws the Confluence card: head, connection, tools, tree. */
    private renderCard(): void {
        const card = this.cardEl;
        if (card === null) return;
        card.empty();
        const { plugin } = this.ctx;
        const s = plugin.settings;
        const ready = connectionReady(s, plugin.token);
        const folder = syncFolder(s.syncRoot);

        const head = card.createDiv({ cls: "docket-source-head" });
        setIcon(
            head.createDiv({ cls: "docket-source-icon is-confluence" }),
            "book-open",
        );
        const title = head.createDiv({ cls: "docket-source-title" });
        const name = title.createDiv({ cls: "docket-source-name" });
        const nameText = name.createSpan({
            text: folder === "" ? "Sync folder not set" : folder,
        });
        setTooltip(nameText, syncFolderDesc(s.syncRoot));
        name.createSpan({ cls: "docket-badge is-blue", text: "Confluence" });

        const sub = title.createDiv({ cls: "docket-source-sub is-one-line" });
        const who = [
            s.site === "" ? "No site yet" : siteDomain(s.site),
            s.account === "" ? "Not signed in" : s.account,
        ].join(" · ");
        setTooltip(sub.createSpan({ cls: "docket-ellipsis", text: who }), who);
        if (ready) {
            iconButton(
                sub,
                this.connOpen ? "check" : "pencil",
                this.connOpen ? "Done" : "Change the connection",
                () => {
                    this.connOpen = !this.connOpen;
                    this.renderCard();
                },
            );
        }
        const count = locations(s).length;
        title.createDiv({
            cls: "docket-source-sub",
            text: `${count} location${count === 1 ? "" : "s"}`,
        });

        const body = card.createDiv({ cls: "docket-source-body" });
        if (folder === "") {
            body.createDiv({
                cls: "setting-item-description",
                text: syncFolderDesc(s.syncRoot),
            });
        }
        if (!ready || this.connOpen) {
            connectionRows(
                this.ctx,
                body.createDiv({ cls: "docket-source-conn" }),
            );
        }

        const tools = body.createDiv({ cls: "docket-tree-tools" });
        if (count >= FILTER_AT) {
            const filter = tools.createEl("input", {
                cls: "docket-tree-filter",
                type: "search",
                placeholder: "Filter by title, path, or space",
                value: this.query,
            });
            filter.addEventListener("input", () => {
                this.query = filter.value;
                this.renderList();
            });
        }
        tools.createDiv({ cls: "docket-tree-spacer" });
        iconButton(
            tools,
            "globe",
            "Browse Confluence…",
            () => void this.browse(),
        );
        const add = tools.createEl("button", { text: "Add by link" });
        add.addEventListener("click", () => void this.edit(null));

        this.listEl = body.createDiv({ cls: "docket-tree" });
        this.renderList();
    }

    /** renderList draws the location tree under the current filter. */
    private renderList(): void {
        const el = this.listEl;
        if (el === null) return;
        el.empty();
        const list = locations(this.ctx.plugin.settings);
        if (list.length === 0) {
            el.createDiv({
                cls: "docket-tree-empty setting-item-description",
                text: "Nothing synced yet. Add a Confluence page, folder, or space.",
            });
            return;
        }
        const { plugin } = this.ctx;
        const groups = buildTree(
            list,
            (l) => this.noteTitle(l),
            this.query,
            this.open,
            validation(plugin.settings, plugin.token).dest,
        );
        if (groups.length === 0) {
            el.createDiv({
                cls: "docket-tree-empty setting-item-description",
                text: "No location matches the filter.",
            });
            return;
        }
        const header = el.createDiv({ cls: "docket-tree-row is-header" });
        header.createDiv({ cls: "docket-tree-path", text: "Vault path" });
        header.createDiv({ cls: "docket-tree-title", text: "Confluence" });
        header.createDiv({ cls: "docket-tree-meta", text: "Space" });
        for (const g of groups) {
            if (g.name !== "") this.groupRow(el, g);
            if (!g.open) continue;
            for (const row of g.rows) {
                this.locationRow(el, row, g.name !== "", g.space !== "");
            }
        }
    }

    /** groupRow draws a folder row that opens or closes its group. */
    private groupRow(el: HTMLElement, g: TreeGroup): void {
        const row = el.createDiv({ cls: "docket-tree-group" });
        setIcon(
            row.createSpan({ cls: "docket-tree-chevron" }),
            g.open ? "chevron-down" : "chevron-right",
        );
        row.createSpan({ cls: "docket-tree-group-name", text: `${g.name}/` });
        const n = g.rows.length;
        const info = [`${n} location${n === 1 ? "" : "s"}`];
        if (g.space !== "") info.push(g.space);
        row.createSpan({
            cls: "docket-tree-group-info",
            text: info.join(" · "),
        });
        row.addEventListener("click", () => {
            this.open.set(g.name, !g.open);
            this.renderList();
        });
    }

    /**
     * locationRow draws one location: kind icon, title, space chip, hover
     * actions, and the vault path. CSS lays it out as two lines in a narrow
     * card and as one row of columns in a wide one. `shared` hides the chip
     * in the narrow layout, where the group line already names the space.
     */
    private locationRow(
        el: HTMLElement,
        r: TreeRow,
        nested: boolean,
        shared: boolean,
    ): void {
        const { loc } = r;
        const s = this.ctx.plugin.settings;
        const row = el.createDiv({
            cls: `docket-tree-row docket-location${nested ? " is-nested" : ""}`,
        });
        row.dataset["dest"] = loc.dest;

        const icon = row.createDiv({ cls: "docket-tree-icon" });
        setIcon(icon, KIND_ICON[loc.kind]);
        setTooltip(icon, KIND_LABEL[loc.kind]);

        const title = row.createDiv({ cls: "docket-tree-title" });
        const text = title.createSpan({
            cls: "docket-tree-text",
            text: r.title,
        });
        const folder = syncFolder(s.syncRoot);
        setTooltip(
            text,
            [
                r.title,
                loc.src,
                `Vault: ${folder === "" ? "" : `${folder}/`}${loc.dest}`,
            ].join("\n"),
        );
        if (r.titleSource === "link") {
            title.createSpan({
                cls: "docket-tree-note",
                text: "not pulled yet",
            });
        }

        const meta = row.createDiv({
            cls: `docket-tree-meta${shared ? " is-shared" : ""}`,
        });
        if (r.space !== "") {
            meta.createSpan({ cls: "docket-tree-chip", text: r.space });
        }

        const acts = row.createDiv({ cls: "docket-tree-acts" });
        const url = pageUrl(s.site, loc.src);
        if (url !== "") {
            iconButton(acts, "external-link", "Open in Confluence", () => {
                window.open(url);
            });
        }
        iconButton(acts, "pencil", "Edit", () => void this.edit(loc));
        iconButton(
            acts,
            "trash-2",
            "Remove (the notes stay in the vault)",
            () => this.save(removeLocation(this.ctx.plugin.settings, loc)),
        );

        const path = row.createDiv({ cls: "docket-tree-path", text: r.label });
        setTooltip(path, loc.dest);
    }

    /**
     * noteTitle reads the `title` property of the pulled note behind `l`, or
     * returns `""` when the note is not in the vault yet.
     */
    private noteTitle(l: Location): string {
        const { app, plugin } = this.ctx;
        const folder = syncFolder(plugin.settings.syncRoot);
        if (folder === "") return "";
        const file = app.vault.getFileByPath(
            normalizePath(`${folder}/${notePath(l)}`),
        );
        if (file === null) return "";
        const t = app.metadataCache.getFileCache(file)?.frontmatter?.["title"];
        return typeof t === "string" ? t : "";
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
        this.renderCard();
        this.ctx.refreshValidation();
    }

    /** importMenu opens the Import menu under `anchor`. */
    private importMenu(anchor: HTMLElement): void {
        const menu = new Menu();
        menu.addItem((i) =>
            i
                .setTitle("Import from file…")
                .setIcon("file-input")
                .onClick(() => void this.importFromFile()),
        );
        menu.addItem((i) =>
            i
                .setTitle("Paste from clipboard")
                .setIcon("clipboard-paste")
                .onClick(() => void this.importFromClipboard()),
        );
        showBelow(menu, anchor);
    }

    /** exportMenu opens the Export menu under `anchor`. */
    private exportMenu(anchor: HTMLElement): void {
        const menu = new Menu();
        menu.addItem((i) =>
            i
                .setTitle("Export to folder…")
                .setIcon("folder-output")
                .onClick(() => void this.exportToFolder()),
        );
        menu.addItem((i) =>
            i
                .setTitle("Copy to clipboard")
                .setIcon("clipboard-copy")
                .onClick(() => void this.exportToClipboard()),
        );
        showBelow(menu, anchor);
    }

    /** portableText is the shareable config as YAML text. */
    private portableText(): string {
        return stringifyYaml(toPortableConfig(this.ctx.plugin.settings));
    }

    /**
     * exportToFolder asks for a folder, with the system picker when there is
     * one and a typed path otherwise, and writes `docket.yaml` into it. An
     * existing file is overwritten only after confirmation. Any failure
     * surfaces as a Notice.
     */
    private async exportToFolder(): Promise<void> {
        const { app, plugin } = this.ctx;
        const title = "Export docket.yaml";
        const dialog = electronDialog(require);
        const input =
            dialog === null
                ? await promptVaultPath(app, {
                      title,
                      placeholder: plugin.settings.syncRoot || "folder path",
                      cta: "Export",
                  })
                : await pickFolder(dialog, title);
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
            if ((await statPath(app, path)) !== null) {
                if (!(await confirmOverwrite(app, path))) {
                    return;
                }
            }
            await writePath(app, path, this.portableText());
            new Notice(`docket: exported to ${path}`);
        } catch (err) {
            new Notice(`docket: export failed: ${errorMessage(err)}`);
        }
    }

    /** exportToClipboard copies the shareable config to the clipboard. */
    private async exportToClipboard(): Promise<void> {
        try {
            await navigator.clipboard.writeText(this.portableText());
            new Notice("docket: copied the config to the clipboard.");
        } catch (err) {
            new Notice(`docket: copy failed: ${errorMessage(err)}`);
        }
    }

    /**
     * importFromFile asks for a file, with the system picker when there is one
     * and a typed path otherwise, and imports it. Any failure surfaces as a
     * Notice.
     */
    private async importFromFile(): Promise<void> {
        const { app, plugin } = this.ctx;
        const title = "Import a docket config";
        const dialog = electronDialog(require);
        const input =
            dialog === null
                ? await promptVaultPath(app, {
                      title,
                      placeholder: plugin.settings.syncRoot || "file path",
                      cta: "Import",
                  })
                : await pickFile(dialog, title);
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
            await this.importText(await readPath(app, path), path);
        } catch (err) {
            new Notice(`docket: import failed: ${errorMessage(err)}`);
        }
    }

    /** importFromClipboard imports the config the clipboard holds. */
    private async importFromClipboard(): Promise<void> {
        try {
            const text = await navigator.clipboard.readText();
            await this.importText(text, "the clipboard");
        } catch (err) {
            new Notice(`docket: import failed: ${errorMessage(err)}`);
        }
    }

    /**
     * importText parses config `text` from `source`, merges its maps into the
     * settings (incoming wins), persists, and re-renders. It throws when the
     * text is not YAML or not a docket config, leaving the settings unchanged.
     */
    private async importText(text: string, source: string): Promise<void> {
        const { plugin } = this.ctx;
        const parsed: unknown = parseYaml(text);
        if (!isPortableConfig(parsed)) {
            throw new Error(`${source} does not hold a docket config`);
        }
        const r = applyImportedMaps(plugin.settings, parsed);
        plugin.settings = r.settings;
        await plugin.persistSettings();
        this.ctx.redisplay();
        new Notice(importSummary(r, source), 10000);
    }
}

/** showBelow opens `menu` under `anchor`. */
function showBelow(menu: Menu, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
}

/** iconButton appends a small icon button with a tooltip to `el`. */
function iconButton(
    el: HTMLElement,
    icon: string,
    tip: string,
    onClick: () => void,
): void {
    const b = el.createEl("button", { cls: "clickable-icon" });
    setIcon(b, icon);
    setTooltip(b, tip);
    b.setAttribute("aria-label", tip);
    b.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
    });
}
