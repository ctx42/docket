// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The push review: a modal listing a pre-flight's candidates so the user picks
// what goes to Confluence. Rows and commit semantics come from review.ts; this
// file is DOM glue, verified by typecheck + manual load.

import { type PreflightEntry, replyLabel } from "@docket/core";
import { type App, DropdownComponent, Modal, Setting } from "obsidian";
import {
    type NewChoice,
    type ReviewRow,
    reviewCommit,
    reviewHold,
    reviewModel,
} from "./review.ts";

/**
 * PushChoice is the review's answer: the dests to push and to mark never, and
 * the reply drafts to keep back, by dest → draft keys.
 */
export interface PushChoice {
    push: string[];
    never: string[];
    hold: Map<string, Set<string>>;
}

/**
 * reviewPush opens the push review over `entries` and resolves the user's
 * choice, or `null` when they cancel or close it.
 */
export function reviewPush(
    app: App,
    entries: PreflightEntry[],
): Promise<PushChoice | null> {
    return new Promise((resolve) => {
        new PushReviewModal(app, entries, resolve).open();
    });
}

/** NEW_OPTIONS are a new note's choices, in dropdown order. */
const NEW_OPTIONS: Array<[NewChoice, string]> = [
    ["later", "Ask later"],
    ["create", "Create page"],
    ["never", "Never push"],
];

class PushReviewModal extends Modal {
    private done = false;
    private readonly picked = new Set<string>();
    private readonly answers = new Map<string, NewChoice>();
    private readonly unticked = new Map<string, Set<string>>();
    private readonly boxes: HTMLInputElement[] = [];
    private goBtn: HTMLButtonElement | null = null;

    constructor(
        app: App,
        private readonly entries: PreflightEntry[],
        private readonly resolve: (c: PushChoice | null) => void,
    ) {
        super(app);
    }

    override onOpen(): void {
        const { rows, hidden } = reviewModel(this.entries);
        this.modalEl.addClass("docket-review");
        this.setTitle("Push to Confluence");
        for (const r of rows) {
            if (r.control === "pick") this.picked.add(r.entry.dest);
        }

        const ready = rows.filter((r) => r.control !== "locked").length;
        const extra =
            hidden > 0 ? ` ${hidden} unchanged notes are left out.` : "";
        this.contentEl.createEl("p", {
            cls: "docket-review-sub",
            text: `${ready} of ${rows.length} ${rows.length === 1 ? "note" : "notes"} can be pushed.${extra}`,
        });

        const pickable = rows.filter((r) => r.control === "pick");
        if (pickable.length > 1) {
            const all = this.contentEl.createEl("label", {
                cls: "docket-review-all",
            });
            const box = all.createEl("input", { type: "checkbox" });
            box.checked = true;
            box.onchange = () => {
                for (const r of pickable) {
                    if (box.checked) this.picked.add(r.entry.dest);
                    else this.picked.delete(r.entry.dest);
                }
                for (const b of this.boxes) b.checked = box.checked;
                this.refresh();
            };
            all.createSpan({ text: "Select all" });
        }

        const list = this.contentEl.createDiv({ cls: "docket-review-list" });
        for (const r of rows) this.row(list, r);

        new Setting(this.contentEl)
            .addButton((b) =>
                b.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((b) => {
                this.goBtn = b.buttonEl;
                b.setCta().onClick(() => this.commit());
            });
        this.refresh();
    }

    /** row draws one candidate: a checkbox, a new-note dropdown, or locked. */
    private row(list: HTMLElement, r: ReviewRow): void {
        const e = r.entry;
        const row = list.createEl(r.control === "pick" ? "label" : "div", {
            cls: `docket-review-row is-${r.kind}`,
        });
        if (r.control === "locked") row.addClass("is-locked");
        const lead = row.createDiv({ cls: "docket-review-lead" });
        if (r.control === "pick") {
            const box = lead.createEl("input", { type: "checkbox" });
            box.checked = true;
            box.onchange = () => {
                if (box.checked) this.picked.add(e.dest);
                else this.picked.delete(e.dest);
                this.refresh();
            };
            this.boxes.push(box);
        } else if (r.control === "locked") {
            lead.createEl("input", { type: "checkbox" }).disabled = true;
        }
        const main = row.createDiv({ cls: "docket-review-main" });
        main.createDiv({ cls: "docket-review-name", text: e.name });
        main.createDiv({ cls: "docket-review-note", text: r.note });
        for (const c of e.resolves) {
            main.createDiv({
                cls: "docket-review-note",
                text: `Resolves comment ${c}`,
            });
        }
        this.replies(list, r);
        if (r.control === "new") {
            const dd = new DropdownComponent(row);
            for (const [value, text] of NEW_OPTIONS) dd.addOption(value, text);
            dd.setValue("later").onChange((v) => {
                this.answers.set(e.dest, v as NewChoice);
                this.refresh();
            });
        }
    }

    /**
     * replies draws a note's reply drafts under its row: one ticked checkbox
     * each, or a locked one for a draft that cannot be sent. Unticking keeps
     * the draft in the note for a later push.
     */
    private replies(list: HTMLElement, r: ReviewRow): void {
        if (r.control !== "pick") return;
        const dest = r.entry.dest;
        for (const reply of r.entry.replies) {
            const row = list.createEl("label", {
                cls: "docket-review-reply",
            });
            const box = row.createEl("input", { type: "checkbox" });
            box.checked = reply.mark === "";
            box.disabled = reply.mark !== "";
            box.onchange = () => {
                const keys = this.unticked.get(dest) ?? new Set<string>();
                if (box.checked) keys.delete(reply.key);
                else keys.add(reply.key);
                this.unticked.set(dest, keys);
            };
            row.createSpan({ text: replyLabel(reply) });
        }
    }

    /** refresh relabels the commit button with the number of notes it pushes. */
    private refresh(): void {
        const n = reviewCommit(this.picked, this.answers).push.length;
        if (this.goBtn === null) return;
        this.goBtn.setText(n === 0 ? "Push" : `Push ${n}`);
        const never = [...this.answers.values()].some((v) => v === "never");
        this.goBtn.disabled = n === 0 && !never;
    }

    private commit(): void {
        this.finish({
            ...reviewCommit(this.picked, this.answers),
            hold: reviewHold(this.entries, this.unticked),
        });
        this.close();
    }

    private finish(c: PushChoice | null): void {
        if (!this.done) {
            this.done = true;
            this.resolve(c);
        }
    }

    override onClose(): void {
        this.contentEl.empty();
        this.finish(null); // Cancel, Escape, or click-out resolves null
    }
}
