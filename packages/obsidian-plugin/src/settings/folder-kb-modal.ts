// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The "Add local folder" dialog: a top-level vault folder picked from a list
// or typed as a new name, and whether the doc server serves it. A folder that
// is its own git repository is marked: one with a remote is added as a git
// knowledge base instead, one without is refused, and the dialog says so
// before anything is added. It resolves the new entry; creating a missing
// folder and registering it is the caller's job. DOM glue; the checks are
// core `config/knowledge.ts` and knowledge.ts.

import {
    type CloneInfo,
    type KnowledgeBase,
    knowledgeBaseProblem,
} from "@docket/core";
import { type App, Modal, Setting, setIcon } from "obsidian";
import type { AddedKnowledgeBase } from "./kb-modal.ts";
import { type LocalFolderPlan, localFolderPlan } from "./knowledge.ts";

/**
 * addLocalFolder opens the dialog and resolves the chosen folder, or null when
 * the user cancels. `choices` are the folders offered; `repos` holds what
 * each of them that is its own git repository says about its clone; `files`
 * are top-level names taken by files, which a folder cannot use; `existing`
 * and `syncFolder` feed the entry check.
 */
export function addLocalFolder(
    app: App,
    choices: readonly string[],
    repos: ReadonlyMap<string, CloneInfo>,
    files: ReadonlySet<string>,
    existing: readonly KnowledgeBase[],
    syncFolder: string,
): Promise<AddedKnowledgeBase | null> {
    return new Promise((resolve) => {
        new LocalFolderModal(
            app,
            choices,
            repos,
            files,
            existing,
            syncFolder,
            resolve,
        ).open();
    });
}

class LocalFolderModal extends Modal {
    private name = "";
    private serve = true;
    private done = false;
    private listEl: HTMLElement | null = null;
    private hintEl: HTMLElement | null = null;
    private nameInput: HTMLInputElement | null = null;
    private addBtn: HTMLButtonElement | null = null;

    constructor(
        app: App,
        private readonly choices: readonly string[],
        private readonly repos: ReadonlyMap<string, CloneInfo>,
        private readonly files: ReadonlySet<string>,
        private readonly existing: readonly KnowledgeBase[],
        private readonly syncFolder: string,
        private readonly resolve: (r: AddedKnowledgeBase | null) => void,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.setTitle("Add local folder");
        const { contentEl } = this;
        contentEl.createDiv({
            cls: "setting-item-description docket-picker-intro",
            text:
                "A top-level vault folder the doc server serves as a " +
                "knowledge base. Its history stays in the vault repository.",
        });
        this.listEl = contentEl.createDiv({ cls: "docket-picker-folders" });

        new Setting(contentEl)
            .setName("Folder")
            .setDesc("Pick one above, or type a new name.")
            .addText((t) => {
                this.nameInput = t.inputEl;
                t.setPlaceholder("notes").onChange((v) => {
                    this.name = v.trim();
                    this.refresh();
                });
            });
        this.hintEl = contentEl.createDiv({ cls: "docket-picker-hint" });

        new Setting(contentEl)
            .setName("Serve it in the doc server")
            .setDesc("Add the folder to the sources of project-config.md.")
            .addToggle((t) =>
                t.setValue(this.serve).onChange((v) => {
                    this.serve = v;
                }),
            );

        new Setting(contentEl)
            .addButton((b) =>
                b.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((b) => {
                this.addBtn = b.buttonEl;
                b.setButtonText("Add")
                    .setCta()
                    .onClick(() => this.add());
            });
        this.refresh();
    }

    /** plan is how the chosen folder would be added. */
    private plan(): LocalFolderPlan {
        return localFolderPlan(this.name, this.repos.get(this.name));
    }

    /** entry is the knowledge base the fields describe, following the plan. */
    private entry(): KnowledgeBase {
        const plan = this.plan();
        return plan.kind === "git"
            ? {
                  kind: "git",
                  name: this.name,
                  url: plan.url,
                  branch: plan.branch,
              }
            : { kind: "folder", name: this.name, url: "", branch: "" };
    }

    /** problem is why the folder cannot be added, or `""`. */
    private problem(): string {
        const p = knowledgeBaseProblem(
            this.entry(),
            this.existing,
            this.syncFolder,
        );
        if (p !== "") return p;
        if (this.files.has(this.name)) {
            return `${this.name} is a file, not a folder.`;
        }
        const plan = this.plan();
        return plan.kind === "refuse" ? plan.reason : "";
    }

    /** refresh redraws the folder list, the hint, and the button. */
    private refresh(): void {
        const list = this.listEl;
        if (list !== null) {
            list.empty();
            if (this.choices.length === 0) {
                list.createDiv({
                    cls: "setting-item-description",
                    text: "No free top-level folder. Type a new name below.",
                });
            }
            for (const c of this.choices) {
                const row = list.createDiv({
                    cls: `docket-picker-row docket-picker-folder${c === this.name ? " is-selected" : ""}`,
                });
                setIcon(
                    row.createSpan({ cls: "docket-location-icon" }),
                    "folder",
                );
                row.createSpan({ cls: "docket-picker-title", text: `${c}/` });
                if (this.repos.has(c)) {
                    row.createSpan({
                        cls: "docket-picker-badge",
                        text: "git repository",
                    });
                }
                row.addEventListener("click", () => {
                    this.name = c;
                    if (this.nameInput !== null) this.nameInput.value = c;
                    this.refresh();
                });
            }
        }
        const problem = this.name === "" ? "" : this.problem();
        const isNew = this.name !== "" && !this.choices.includes(this.name);
        const plan = this.name === "" ? null : this.plan();
        let hint = problem;
        if (hint === "" && plan?.kind === "git") {
            hint =
                `${this.name} is its own git repository (${plan.url}). It is ` +
                "added as a git knowledge base and kept out of the vault " +
                "repository.";
        } else if (hint === "" && isNew) {
            hint = `New folder: ${this.name}/ is created now.`;
        }
        this.hintEl?.setText(hint);
        this.hintEl?.toggleClass("docket-field-error", problem !== "");
        if (this.addBtn !== null) {
            this.addBtn.disabled = this.name === "" || problem !== "";
            this.addBtn.setText(
                plan?.kind === "git" ? "Add as git knowledge base" : "Add",
            );
        }
    }

    /** add resolves the entry when it passes the checks. */
    private add(): void {
        if (this.name === "" || this.problem() !== "") return;
        this.finish({ kb: this.entry(), serve: this.serve });
        this.close();
    }

    private finish(r: AddedKnowledgeBase | null): void {
        if (!this.done) {
            this.done = true;
            this.resolve(r);
        }
    }

    override onClose(): void {
        this.contentEl.empty();
        this.finish(null);
    }
}
