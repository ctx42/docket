// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The add/edit dialog for one synced location: paste a Confluence link, and the
// dialog tells its kind and proposes a vault path — from the link at once, then
// from the page or space title once Confluence answers — both still editable.
// The entry is checked live and Save stays disabled until it is valid. The logic is
// locations.ts; this file is DOM glue, verified by typecheck + manual load.

import {
    ConfluenceClient,
    type docketSettings,
    pageID,
    siteHost,
    spaceLinkKey,
} from "@docket/core";
import {
    type App,
    Modal,
    requestUrl,
    Setting,
    type TextComponent,
} from "obsidian";
import { RequestUrlHttpClient } from "../adapters/http.ts";
import {
    checkLocation,
    detectKind,
    KIND_LABEL,
    type Location,
    type LocationKind,
    suggestDest,
    titleDest,
} from "./locations.ts";
import { normalizeConfluenceSource } from "./source.ts";
import { VaultPathSuggest } from "./suggest.ts";

/** TitleLookup fetches the title a link names, or `""` when it has none. */
export type TitleLookup = (kind: LocationKind, src: string) => Promise<string>;

/** LOOKUP_DELAY_MS waits for typing to settle before asking Confluence. */
const LOOKUP_DELAY_MS = 400;

/**
 * confluenceClient returns a client for the configured Site, or null when the
 * credentials are not filled in yet.
 */
export function confluenceClient(
    settings: docketSettings,
    token: string,
): ConfluenceClient | null {
    if (settings.site === "" || settings.account === "" || token === "") {
        return null;
    }
    return new ConfluenceClient(new RequestUrlHttpClient(requestUrl), {
        host: siteHost(settings.site),
        account: settings.account,
        token,
    });
}

/**
 * confluenceTitles returns a lookup of page and space titles on the configured
 * Site, or null when the credentials are not filled in yet. A folder has no
 * title lookup.
 */
export function confluenceTitles(
    settings: docketSettings,
    token: string,
): TitleLookup | null {
    const client = confluenceClient(settings, token);
    if (client === null) return null;
    return async (kind, src) => {
        if (kind === "page") return (await client.fetchPage(pageID(src))).title;
        if (kind === "space") {
            return (await client.resolveSpace(spaceLinkKey(src))).name;
        }
        return "";
    };
}

/**
 * editLocation opens the dialog — empty to add, filled from `prev` to edit — and
 * resolves the saved location, or null when the user cancels. `lookup`, when
 * given, names the proposed vault path after the fetched title.
 */
export function editLocation(
    app: App,
    settings: docketSettings,
    prev: Location | null,
    lookup: TitleLookup | null,
): Promise<Location | null> {
    return new Promise((resolve) => {
        new LocationModal(app, settings, prev, lookup, resolve).open();
    });
}

/** DEST_DESC explains the vault path field for each kind. */
const DEST_DESC: Record<LocationKind, string> = {
    page: "The note the page is synced to, ending in .md.",
    folder: "The vault folder the Confluence folder's pages are synced into.",
    space: "The vault folder the space's pages are synced into.",
};

class LocationModal extends Modal {
    private done = false;
    private kind: LocationKind;
    private src: string;
    private dest: string;
    /** destTouched is true once the user typed a path, so a new link stops
     * overwriting it with a suggestion. */
    private destTouched: boolean;
    private destField: TextComponent | null = null;
    private destSetting: Setting | null = null;
    private kindSelect: HTMLSelectElement | null = null;
    private kindNote: HTMLElement | null = null;
    private errorEl: HTMLElement | null = null;
    private saveBtn: HTMLButtonElement | null = null;
    /** lookupTimer debounces the title lookup; lookupSeq drops stale answers. */
    private lookupTimer = 0;
    private lookupSeq = 0;
    private looking = false;

    constructor(
        app: App,
        private readonly settings: docketSettings,
        private readonly prev: Location | null,
        private readonly lookup: TitleLookup | null,
        private readonly resolve: (l: Location | null) => void,
    ) {
        super(app);
        this.kind = prev?.kind ?? "page";
        this.src = prev?.src ?? "";
        this.dest = prev?.dest ?? "";
        this.destTouched = prev !== null;
    }

    override onOpen(): void {
        this.setTitle(
            this.prev === null ? "Add synced location" : "Edit synced location",
        );
        const { contentEl } = this;

        new Setting(contentEl)
            .setName("Confluence link")
            .setDesc("Paste the page, folder, or space URL from your browser.")
            .addText((t) => {
                t.inputEl.addClass("docket-wide-input");
                t.setPlaceholder(
                    "https://your-site.atlassian.net/wiki/spaces/…",
                )
                    .setValue(this.src)
                    .onChange((v) => this.onLink(v));
                window.setTimeout(() => t.inputEl.focus(), 0);
            });

        const kind = new Setting(contentEl).setName("Type").addDropdown((d) => {
            for (const k of ["page", "folder", "space"] as const) {
                d.addOption(k, KIND_LABEL[k]);
            }
            d.setValue(this.kind).onChange((v) => {
                this.kind = v as LocationKind;
                this.refresh();
            });
            this.kindSelect = d.selectEl;
        });
        this.kindNote = kind.descEl;

        this.destSetting = new Setting(contentEl)
            .setName("Vault path")
            .addText((t) => {
                this.destField = t;
                t.inputEl.addClass("docket-wide-input");
                t.setValue(this.dest).onChange((v) => {
                    this.dest = v.trim();
                    this.destTouched = true;
                    this.refresh();
                });
                new VaultPathSuggest(
                    this.app,
                    t.inputEl,
                    "notes",
                    () => this.settings.syncRoot,
                    (v) => this.pickPath(v),
                );
            });

        this.errorEl = contentEl.createDiv({ cls: "docket-field-error" });

        new Setting(contentEl)
            .addButton((b) =>
                b.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((b) => {
                this.saveBtn = b.buttonEl;
                b.setButtonText(this.prev === null ? "Add" : "Save")
                    .setCta()
                    .onClick(() => this.save());
            });
        this.contentEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !(this.saveBtn?.disabled ?? true)) {
                e.preventDefault();
                this.save();
            }
        });
        this.refresh();
    }

    /** onLink takes a new link: its kind, and a path unless the user set one. */
    private onLink(value: string): void {
        this.src = normalizeConfluenceSource(value);
        const kind = detectKind(this.src);
        if (kind !== null) {
            this.kind = kind;
            if (this.kindSelect !== null) this.kindSelect.value = kind;
        }
        if (!this.destTouched) {
            this.setDest(suggestDest(this.kind, this.src));
            this.scheduleLookup();
        }
        this.refresh();
    }

    /** setDest writes a proposed path into the field without marking it typed. */
    private setDest(dest: string): void {
        this.dest = dest;
        this.destField?.setValue(dest);
    }

    /**
     * scheduleLookup asks Confluence for the link's title once typing settles,
     * and proposes a path named after it unless the user typed one meanwhile.
     * A failed lookup keeps the path taken from the link.
     */
    private scheduleLookup(): void {
        window.clearTimeout(this.lookupTimer);
        const lookup = this.lookup;
        const kind = this.kind;
        const src = this.src;
        if (lookup === null || detectKind(src) === null || kind === "folder") {
            return;
        }
        this.lookupTimer = window.setTimeout(() => {
            const seq = ++this.lookupSeq;
            this.looking = true;
            this.refresh();
            lookup(kind, src)
                .then((title) => {
                    if (seq !== this.lookupSeq || this.destTouched) return;
                    if (kind !== this.kind || src !== this.src) return;
                    const dest = titleDest(kind, title);
                    if (dest !== "") this.setDest(dest);
                })
                .catch((err: unknown) => {
                    console.debug("docket: title lookup failed", err);
                })
                .finally(() => {
                    if (seq !== this.lookupSeq) return;
                    this.looking = false;
                    this.refresh();
                });
        }, LOOKUP_DELAY_MS);
    }

    /**
     * pickPath turns a chosen suggestion into the field's value: for a page, a
     * folder becomes a note inside it named after the proposed file.
     */
    private pickPath(value: string): string {
        if (this.kind !== "page" || value.endsWith(".md")) return value;
        const name = suggestDest("page", this.src) || "Untitled.md";
        return `${value}/${name}`;
    }

    /** refresh updates the hints, the error line, and the Save button. */
    private refresh(): void {
        const shape = detectKind(this.src);
        this.destSetting?.setDesc(
            this.looking
                ? "Looking up the title on Confluence…"
                : DEST_DESC[this.kind],
        );
        this.kindNote?.setText(
            this.src === ""
                ? ""
                : shape === null
                  ? "Couldn't tell the type from this link; pick it."
                  : `Detected from the link: ${KIND_LABEL[shape].toLowerCase()}.`,
        );
        const err = checkLocation(this.settings, this.next(), this.prev);
        // An empty field is not an error yet; the disabled button says enough.
        const show = this.src !== "" && this.dest !== "" ? err : "";
        this.errorEl?.setText(show);
        if (this.saveBtn !== null) this.saveBtn.disabled = err !== "";
    }

    private next(): Location {
        return { kind: this.kind, dest: this.dest, src: this.src };
    }

    private save(): void {
        if (checkLocation(this.settings, this.next(), this.prev) !== "") return;
        this.finish(this.next());
        this.close();
    }

    private finish(l: Location | null): void {
        if (!this.done) {
            this.done = true;
            this.resolve(l);
        }
    }

    override onClose(): void {
        window.clearTimeout(this.lookupTimer);
        this.lookupSeq++;
        this.contentEl.empty();
        this.finish(null); // Cancel, Escape, or click-out resolves null
    }
}
