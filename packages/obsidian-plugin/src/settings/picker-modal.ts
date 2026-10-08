// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The "Browse Confluence" picker: a filterable list of every space the account
// can see, each expanding lazily into its folders and pages, with a tick per
// node to start or stop syncing it and a rename action giving a page or synced
// root its local name, then a review step listing every addition (its vault
// path editable), removal, and rename before anything is saved. The logic is
// picker.ts; this file is DOM glue, verified by typecheck + manual load.

import {
    type ConfluenceClient,
    deriveName,
    type docketSettings,
    listChildren,
    type Space,
    spaceTopLevel,
} from "@docket/core";
import { type App, Modal, Setting, setIcon } from "obsidian";
import { KIND_LABEL, type LocationKind } from "./locations.ts";
import {
    canSave,
    changeCount,
    childNodes,
    type Draft,
    emptyDraft,
    groupSpaces,
    isTicked,
    localName,
    type Review,
    type ReviewRow,
    renameKind,
    review,
    setDest,
    setRename,
    spaceNode,
    syncedAs,
    type TreeNode,
    toggle,
} from "./picker.ts";
import { VaultPathSuggest } from "./suggest.ts";

/** KIND_ICON is each node kind's icon in the tree. */
const KIND_ICON: Record<LocationKind, string> = {
    page: "file-text",
    folder: "folder",
    space: "library",
};

/**
 * browseConfluence opens the picker and resolves the settings with the
 * reviewed changes applied, or null when the user cancels.
 */
export function browseConfluence(
    app: App,
    client: ConfluenceClient,
    settings: docketSettings,
    token: string,
): Promise<docketSettings | null> {
    return new Promise((resolve) => {
        new PickerModal(app, client, settings, token, resolve).open();
    });
}

/** Children is a node's loaded children, or the error loading them hit. */
type Children = { nodes: TreeNode[] } | { error: string };

class PickerModal extends Modal {
    private done = false;
    private draft: Draft = emptyDraft();
    private spaces: Space[] | null = null;
    private loadError = "";
    private accountId = "";
    private query = "";
    private personalOpen = false;
    /** expanded holds the keys of open nodes; children caches their listings. */
    private readonly expanded = new Set<string>();
    private readonly children = new Map<string, Children>();
    private listEl: HTMLElement | null = null;
    private countEl: HTMLElement | null = null;
    private reviewBtn: HTMLButtonElement | null = null;

    constructor(
        app: App,
        private readonly client: ConfluenceClient,
        private readonly settings: docketSettings,
        private readonly token: string,
        private readonly resolve: (s: docketSettings | null) => void,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.modalEl.addClass("docket-picker");
        this.showTree();
        void this.loadSpaces();
    }

    private async loadSpaces(): Promise<void> {
        try {
            const [spaces, accountId] = await Promise.all([
                this.client.listSpaces(),
                this.client.currentAccountID().catch(() => ""),
            ]);
            this.spaces = spaces;
            this.accountId = accountId;
        } catch (err) {
            this.loadError = errorMessage(err);
        }
        this.renderSpaces();
    }

    /** showTree draws the tree step: the filter, the space list, the footer. */
    private showTree(): void {
        this.setTitle("Browse Confluence");
        const { contentEl } = this;
        contentEl.empty();

        const filter = contentEl.createEl("input", {
            cls: "docket-picker-filter",
            attr: {
                type: "search",
                placeholder: "Filter spaces by name or key",
            },
        });
        filter.value = this.query;
        filter.addEventListener("input", () => {
            this.query = filter.value;
            this.renderSpaces();
        });
        window.setTimeout(() => filter.focus(), 0);

        this.listEl = contentEl.createDiv({ cls: "docket-picker-tree" });
        this.renderSpaces();

        const footer = new Setting(contentEl)
            .addButton((b) =>
                b.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((b) => {
                this.reviewBtn = b.buttonEl;
                b.setButtonText("Review")
                    .setCta()
                    .onClick(() => this.showReview());
            });
        footer.settingEl.addClass("docket-picker-footer");
        this.countEl = footer.infoEl;
        this.refreshCount();
    }

    /** renderSpaces redraws the space list under the current filter. */
    private renderSpaces(): void {
        const el = this.listEl;
        if (el === null) return;
        el.empty();
        if (this.loadError !== "") {
            el.createDiv({ cls: "docket-error", text: this.loadError });
            return;
        }
        if (this.spaces === null) {
            el.createDiv({ cls: "docket-muted", text: "Loading spaces…" });
            return;
        }
        const groups = groupSpaces(this.spaces, this.query, this.accountId);
        if (groups.team.length === 0 && groups.personal.length === 0) {
            el.createDiv({ cls: "docket-muted", text: "No space matches." });
            return;
        }
        for (const sp of groups.team) {
            this.renderNode(el, spaceNode(sp), 0);
        }
        if (groups.personal.length > 0) {
            const details = el.createEl("details", {
                cls: "docket-picker-group",
            });
            // A filter that matches personal spaces shows them.
            details.open = this.personalOpen || this.query.trim() !== "";
            details.addEventListener("toggle", () => {
                if (this.query.trim() === "") this.personalOpen = details.open;
            });
            details.createEl("summary", {
                text: `Personal spaces (${groups.personal.length})`,
            });
            for (const sp of groups.personal) {
                this.renderNode(details, spaceNode(sp), 0);
            }
        }
    }

    /** renderNode appends one row and, when it is open, its children. */
    private renderNode(
        parent: HTMLElement,
        node: TreeNode,
        depth: number,
    ): void {
        parent.appendChild(this.buildNode(node, depth));
    }

    /**
     * buildNode builds a detached row with its children container; opening,
     * closing, or a finished load replaces it with a fresh build in place.
     */
    private buildNode(node: TreeNode, depth: number): HTMLElement {
        const wrap = createDiv({ cls: "docket-picker-node" });
        const redraw = (): void => {
            if (wrap.isConnected) wrap.replaceWith(this.buildNode(node, depth));
        };
        const row = wrap.createDiv({ cls: "docket-picker-row" });
        row.style.setProperty("--docket-depth", String(depth));
        const kidsEl = wrap.createDiv({ cls: "docket-picker-kids" });

        const loaded = this.children.get(node.key);
        const leaf =
            loaded !== undefined &&
            "nodes" in loaded &&
            loaded.nodes.length === 0;
        const twisty = row.createSpan({ cls: "docket-picker-twisty" });
        if (!leaf) {
            twisty.addClass("is-clickable");
            setIcon(
                twisty,
                this.expanded.has(node.key) ? "chevron-down" : "chevron-right",
            );
            twisty.addEventListener("click", () => {
                if (this.expanded.has(node.key)) this.expanded.delete(node.key);
                else this.expanded.add(node.key);
                redraw();
            });
        }

        const box = row.createEl("input", { attr: { type: "checkbox" } });
        box.checked = isTicked(this.settings, this.draft, node);
        box.setAttribute("aria-label", `Sync ${node.title}`);

        const icon = row.createSpan({
            cls: "docket-location-icon",
            attr: { "aria-label": KIND_LABEL[node.kind] },
        });
        setIcon(icon, KIND_ICON[node.kind]);
        const title = row.createSpan({
            cls: "docket-picker-title",
            text: node.title,
        });
        const badges = row.createSpan({ cls: "docket-picker-badges" });
        const rename = row.createSpan({
            cls: "docket-picker-rename clickable-icon",
            attr: { "aria-label": "Rename locally" },
        });
        setIcon(rename, "pencil");
        const refreshRow = (): void => {
            this.renderBadges(badges, node);
            rename.toggleClass(
                "is-hidden",
                renameKind(this.settings, this.draft, node) === null,
            );
        };
        refreshRow();

        box.addEventListener("change", () => {
            this.draft = toggle(this.settings, this.draft, node);
            box.checked = isTicked(this.settings, this.draft, node);
            refreshRow();
            this.refreshCount();
        });
        rename.addEventListener("click", () =>
            this.editName(title, node, refreshRow),
        );

        if (this.expanded.has(node.key)) {
            this.renderKids(kidsEl, node, depth, redraw);
        }
        return wrap;
    }

    /**
     * editName swaps the node's title for an input holding its local name
     * (placeholder: the name its title derives to). Enter or leaving the field
     * stores the rename in the draft; Escape cancels.
     */
    private editName(
        title: HTMLElement,
        node: TreeNode,
        refreshRow: () => void,
    ): void {
        if (renameKind(this.settings, this.draft, node) === null) return;
        const input = createEl("input", {
            cls: "docket-picker-name",
            attr: {
                type: "text",
                "aria-label": `Local name for ${node.title}`,
            },
        });
        input.value = localName(this.settings, this.draft, node);
        try {
            input.placeholder = deriveName(node.title);
        } catch {
            // A title deriving to nothing leaves no placeholder.
        }
        title.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const end = (save: boolean): void => {
            if (done) return;
            done = true;
            if (save) {
                this.draft = setRename(
                    this.settings,
                    this.draft,
                    node,
                    input.value,
                );
            }
            input.replaceWith(title);
            refreshRow();
            this.refreshCount();
        };
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") end(true);
            if (e.key === "Escape") {
                e.stopPropagation(); // keep the modal open
                end(false);
            }
        });
        input.addEventListener("blur", () => end(true));
    }

    /** renderBadges shows what syncs the node and what a tick will do. */
    private renderBadges(el: HTMLElement, node: TreeNode): void {
        el.empty();
        const badge = (text: string, cls = ""): void => {
            el.createSpan({ cls: `docket-picker-badge ${cls}`, text });
        };
        if (node.space?.status === "archived") badge("archived");
        const own = syncedAs(this.settings, node);
        if (own !== null) {
            badge(
                this.draft.removes.has(node.key)
                    ? "will stop syncing"
                    : "synced",
                this.draft.removes.has(node.key) ? "is-remove" : "is-synced",
            );
        } else if (node.cover !== null) {
            badge(`in ${node.cover.dest}`, "is-covered");
        }
        if (node.kind === "page" && isTicked(this.settings, this.draft, node)) {
            badge("this page only");
        }
        const pending = this.draft.renames.get(node.key);
        const name = localName(this.settings, this.draft, node);
        if (pending !== undefined) {
            badge(
                pending.name === "" ? "default name" : `→ ${pending.name}`,
                "is-rename",
            );
        } else if (own === null && name !== "") {
            badge(`as ${name}.md`);
        }
    }

    /**
     * renderKids draws a node's children, loading them on first open and
     * redrawing the node once they arrive.
     */
    private renderKids(
        el: HTMLElement,
        node: TreeNode,
        depth: number,
        redraw: () => void,
    ): void {
        const note = (cls: string, text: string): void => {
            el.createDiv({
                cls: `${cls} docket-picker-note`,
                text,
            }).style.setProperty("--docket-depth", String(depth + 1));
        };
        const loaded = this.children.get(node.key);
        if (loaded === undefined) {
            note("docket-muted", "Loading…");
            void this.loadChildren(node).then(redraw);
            return;
        }
        if ("error" in loaded) {
            note("docket-error", loaded.error);
            return;
        }
        for (const kid of loaded.nodes) {
            this.renderNode(el, kid, depth + 1);
        }
    }

    /** loadChildren lists a node's children once, caching nodes or the error. */
    private async loadChildren(node: TreeNode): Promise<void> {
        try {
            if (node.space !== undefined) {
                const top = await spaceTopLevel(this.client, node.space);
                this.children.set(node.key, {
                    nodes: childNodes(
                        this.settings,
                        node,
                        top.children,
                        top.beside,
                    ),
                });
                return;
            }
            const kind = node.kind === "folder" ? "folder" : "page";
            const kids = await listChildren(this.client, kind, node.id);
            this.children.set(node.key, {
                nodes: childNodes(this.settings, node, kids),
            });
        } catch (err) {
            this.children.set(node.key, { error: errorMessage(err) });
        }
    }

    /** refreshCount updates the change count and the Review button. */
    private refreshCount(): void {
        const n = changeCount(this.draft);
        this.countEl?.setText(
            n === 0 ? "Tick what to sync." : `${n} change${n === 1 ? "" : "s"}`,
        );
        if (this.reviewBtn !== null) this.reviewBtn.disabled = n === 0;
    }

    /** showReview draws the review step: one row per change, then Save. */
    private showReview(): void {
        this.setTitle("Review changes");
        const { contentEl } = this;
        contentEl.empty();
        const banner = contentEl.createDiv({ cls: "docket-banner" });
        const list = contentEl.createDiv({ cls: "docket-picker-review" });
        const errors = new Map<string, HTMLElement>();
        let saveBtn: HTMLButtonElement | null = null;

        const refresh = (): Review => {
            const r = review(this.settings, this.draft, this.token);
            for (const row of r.rows) errors.get(row.key)?.setText(row.error);
            banner.empty();
            banner.toggleClass("is-visible", r.configError !== "");
            if (r.configError !== "") {
                setIcon(
                    banner.createSpan({ cls: "docket-banner-icon" }),
                    "alert-triangle",
                );
                banner.createSpan({ text: r.configError });
            }
            if (saveBtn !== null) saveBtn.disabled = !canSave(r);
            return r;
        };

        for (const row of review(this.settings, this.draft, this.token).rows) {
            const item = new Setting(list);
            item.settingEl.addClass("docket-location");
            const icon = item.nameEl.createSpan({
                cls: "docket-location-icon",
                attr: { "aria-label": OP_LABEL[row.op] },
            });
            setIcon(icon, OP_ICON[row.op]);
            const kind = item.nameEl.createSpan({
                cls: "docket-location-icon",
                attr: { "aria-label": KIND_LABEL[row.location.kind] },
            });
            setIcon(kind, KIND_ICON[row.location.kind]);
            item.nameEl.createSpan({ text: row.title });
            if (row.op === "remove") {
                item.setDesc(
                    `Stop syncing ${row.location.dest}. The notes stay in the vault.`,
                );
                continue;
            }
            if (row.op === "rename") {
                item.descEl.createDiv({ text: renameText(row) });
                errors.set(
                    row.key,
                    item.descEl.createDiv({ cls: "docket-field-error" }),
                );
                continue;
            }
            const err = item.descEl.createDiv({ cls: "docket-field-error" });
            errors.set(row.key, err);
            item.addText((t) => {
                t.inputEl.addClass("docket-wide-input");
                t.setValue(row.location.dest).onChange((v) => {
                    this.draft = setDest(this.draft, row.key, v);
                    refresh();
                });
                new VaultPathSuggest(
                    this.app,
                    t.inputEl,
                    row.location.kind === "page" ? "notes" : "folders",
                    () => this.settings.syncRoot,
                );
            });
        }

        new Setting(contentEl)
            .addButton((b) =>
                b.setButtonText("Back").onClick(() => this.showTree()),
            )
            .addButton((b) => {
                saveBtn = b.buttonEl;
                b.setButtonText("Save")
                    .setCta()
                    .onClick(() => {
                        const r = refresh();
                        if (!canSave(r)) return;
                        this.finish(r.settings);
                        this.close();
                    });
            });
        refresh();
    }

    private finish(s: docketSettings | null): void {
        if (!this.done) {
            this.done = true;
            this.resolve(s);
        }
    }

    override onClose(): void {
        this.contentEl.empty();
        this.finish(null); // Cancel, Escape, or click-out resolves null
    }
}

/** OP_ICON and OP_LABEL are each review operation's icon and label. */
const OP_ICON: Record<ReviewRow["op"], string> = {
    add: "plus",
    remove: "minus",
    rename: "pencil",
};
const OP_LABEL: Record<ReviewRow["op"], string> = {
    add: "Add",
    remove: "Remove",
    rename: "Rename",
};

/** renameText describes what saving a rename row does. */
function renameText(row: ReviewRow): string {
    if (row.pageId === "") {
        return `Sync to ${row.location.dest}. Notes already pulled stay at the old path.`;
    }
    if (row.location.dest === "") {
        return "Name the note after its Confluence title again on the next pull.";
    }
    return `Name the note ${row.location.dest} on the next pull, whatever its Confluence title.`;
}

/** errorMessage returns an unknown thrown value's message text. */
function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
