// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The "Add knowledge base" dialog: an SSH URL checked with `git ls-remote` as
// it is typed, the vault folder proposed from it, the branch to clone, and
// whether the doc server serves it. "Clone and add" clones into the folder and
// resolves the new entry; a failure stays in the dialog as plain advice. DOM
// glue; the logic is core `config/knowledge.ts`, core `git/remote.ts`, and
// knowledge.ts.

import {
    cloneRepo,
    type GitExec,
    type KnowledgeBase,
    knowledgeBaseProblem,
    lsRemote,
    proposeName,
    type RemoteInfo,
} from "@docket/core";
import { type App, Modal, Setting, setIcon } from "obsidian";
import { remoteAdvice } from "./knowledge.ts";

/** CHECK_DELAY_MS is how long the URL must stay unchanged before it is checked. */
const CHECK_DELAY_MS = 600;

/** AddedKnowledgeBase is what the dialog resolves: the entry and how to serve it. */
export interface AddedKnowledgeBase {
    kb: KnowledgeBase;
    /** Whether to add the folder to the doc server's `sources`. */
    serve: boolean;
}

/**
 * addKnowledgeBase opens the dialog and resolves the cloned entry, or null
 * when the user cancels. `exec` runs git at the vault root; `taken` holds the
 * top-level names the folder cannot use; `existing` and `syncFolder` feed the
 * entry check.
 */
export function addKnowledgeBase(
    app: App,
    exec: GitExec,
    existing: readonly KnowledgeBase[],
    syncFolder: string,
    taken: ReadonlySet<string>,
): Promise<AddedKnowledgeBase | null> {
    return new Promise((resolve) => {
        new KnowledgeBaseModal(
            app,
            exec,
            existing,
            syncFolder,
            taken,
            resolve,
        ).open();
    });
}

/** Check is the URL check's state. */
type Check =
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "ok"; info: RemoteInfo }
    | { kind: "failed"; advice: string };

class KnowledgeBaseModal extends Modal {
    private url = "";
    private name = "";
    /** nameEdited is set once the user types a name, so the URL stops proposing one. */
    private nameEdited = false;
    private branch = "";
    private serve = true;
    private check: Check = { kind: "idle" };
    /** seq numbers URL checks, so a slow answer for an old URL is dropped. */
    private seq = 0;
    private timer = 0;
    private cloning = false;
    private closed = false;
    private done = false;

    private statusEl: HTMLElement | null = null;
    private nameInput: HTMLInputElement | null = null;
    private nameError: HTMLElement | null = null;
    private branchSelect: HTMLSelectElement | null = null;
    private addBtn: HTMLButtonElement | null = null;

    constructor(
        app: App,
        private readonly exec: GitExec,
        private readonly existing: readonly KnowledgeBase[],
        private readonly syncFolder: string,
        private readonly taken: ReadonlySet<string>,
        private readonly resolve: (r: AddedKnowledgeBase | null) => void,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.setTitle("Add knowledge base");
        this.modalEl.addClass("docket-kb-modal");
        const { contentEl } = this;

        new Setting(contentEl)
            .setName("SSH URL")
            .setDesc(
                "The repository to clone, e.g. git@bitbucket.org:team/kb.git.",
            )
            .addText((t) => {
                t.inputEl.addClass("docket-wide-input");
                t.setPlaceholder("git@host:owner/repo.git").onChange((v) => {
                    this.url = v.trim();
                    this.urlChanged();
                });
                window.setTimeout(() => t.inputEl.focus(), 0);
            });
        this.statusEl = contentEl.createDiv({ cls: "docket-kb-status" });

        new Setting(contentEl)
            .setName("Folder")
            .setDesc("The top-level vault folder it is cloned into.")
            .addText((t) => {
                this.nameInput = t.inputEl;
                t.onChange((v) => {
                    this.name = v.trim();
                    this.nameEdited = true;
                    this.refresh();
                });
            });
        this.nameError = contentEl.createDiv({ cls: "docket-field-error" });

        new Setting(contentEl).setName("Branch").addDropdown((d) => {
            this.branchSelect = d.selectEl;
            d.onChange((v) => {
                this.branch = v;
            });
        });

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
                b.setButtonText("Clone and add")
                    .setCta()
                    .onClick(() => void this.clone());
            });
        this.refresh();
    }

    /** urlChanged proposes a folder name and schedules the URL check. */
    private urlChanged(): void {
        if (!this.nameEdited && this.nameInput !== null) {
            this.name = proposeName(this.url, this.taken);
            this.nameInput.value = this.name;
        }
        window.clearTimeout(this.timer);
        this.seq++;
        this.check = this.url === "" ? { kind: "idle" } : { kind: "checking" };
        this.refresh();
        if (this.url === "") return;
        const seq = this.seq;
        this.timer = window.setTimeout(
            () => void this.runCheck(seq),
            CHECK_DELAY_MS,
        );
    }

    /** runCheck lists the URL's branches, unless a newer URL replaced it. */
    private async runCheck(seq: number): Promise<void> {
        let next: Check;
        try {
            next = { kind: "ok", info: await lsRemote(this.exec, this.url) };
        } catch (err) {
            next = { kind: "failed", advice: remoteAdvice(err) };
        }
        if (seq !== this.seq) return;
        this.check = next;
        this.fillBranches();
        this.refresh();
    }

    /** fillBranches offers the checked branches, the default one first. */
    private fillBranches(): void {
        const sel = this.branchSelect;
        if (sel === null) return;
        sel.empty();
        if (this.check.kind !== "ok") return;
        const { head, branches } = this.check.info;
        sel.createEl("option", {
            value: "",
            text: head === "" ? "Default branch" : `${head} (default)`,
        });
        for (const b of branches) {
            if (b !== head) sel.createEl("option", { value: b, text: b });
        }
        sel.value = "";
        this.branch = "";
    }

    /** problem is why the dialog cannot clone yet, or `""`. */
    private problem(): string {
        const kb = this.entry();
        const p = knowledgeBaseProblem(kb, this.existing, this.syncFolder);
        if (p !== "") return p;
        if (this.taken.has(kb.name)) {
            return `The vault already has ${kb.name}. Choose another folder.`;
        }
        return "";
    }

    /** entry is the knowledge base the fields describe. */
    private entry(): KnowledgeBase {
        return {
            kind: "git",
            name: this.name,
            url: this.url,
            branch: this.branch,
        };
    }

    /** refresh redraws the status line, the name error, and the button. */
    private refresh(): void {
        const status = this.statusEl;
        if (status !== null) {
            status.empty();
            const show = (icon: string, cls: string, text: string): void => {
                status.className = `docket-kb-status ${cls}`;
                setIcon(
                    status.createSpan({ cls: "docket-kb-status-icon" }),
                    icon,
                );
                status.createSpan({ text });
            };
            const c = this.check;
            if (this.cloning) show("loader", "is-pending", "Cloning…");
            else if (c.kind === "checking") {
                show("loader", "is-pending", "Checking with your SSH key…");
            } else if (c.kind === "ok") {
                const n = c.info.branches.length;
                show(
                    "check",
                    "is-ok",
                    `Reachable · ${n} branch${n === 1 ? "" : "es"}`,
                );
            } else if (c.kind === "failed") {
                show("x", "is-err", c.advice);
            } else {
                status.className = "docket-kb-status";
            }
        }
        const problem = this.url === "" ? "" : this.problem();
        this.nameError?.setText(this.name === "" ? "" : problem);
        if (this.branchSelect !== null) {
            this.branchSelect.disabled = this.check.kind !== "ok";
        }
        if (this.addBtn !== null) {
            this.addBtn.disabled =
                this.cloning || this.check.kind !== "ok" || problem !== "";
        }
    }

    /** clone clones the repository and resolves the entry, or shows why not. */
    private async clone(): Promise<void> {
        if (this.cloning || this.check.kind !== "ok" || this.problem() !== "") {
            return;
        }
        const kb = this.entry();
        this.cloning = true;
        this.refresh();
        try {
            await cloneRepo(this.exec, kb.url, kb.name, kb.branch);
        } catch (err) {
            this.cloning = false;
            if (this.closed) {
                this.finish(null);
                return;
            }
            this.check = { kind: "failed", advice: remoteAdvice(err) };
            this.refresh();
            return;
        }
        this.cloning = false;
        this.finish({ kb, serve: this.serve });
        this.close();
    }

    private finish(r: AddedKnowledgeBase | null): void {
        if (!this.done) {
            this.done = true;
            this.resolve(r);
        }
    }

    /**
     * onClose resolves null — unless a clone is running: that one still
     * resolves its entry when it finishes, so a cloned folder is never left
     * unregistered.
     */
    override onClose(): void {
        this.closed = true;
        window.clearTimeout(this.timer);
        this.seq++;
        this.contentEl.empty();
        if (!this.cloning) this.finish(null);
    }
}
