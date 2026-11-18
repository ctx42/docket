// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The reply dialog: it shows the comment being answered and takes the reply's
// text, so a user never types callout syntax. The reply is sent at once, or
// saved as a draft in the note for the next push to send. Obsidian glue; the thread under
// the cursor comes from note-actions.ts, sending from the controller.

import type { CommentRef } from "@docket/core";
import { type App, Modal, Platform, Setting } from "obsidian";

/** QUOTE_MAX caps the quoted comment, so a long one leaves room to write. */
const QUOTE_MAX = 600;

/** ReplyAnswer is the dialog's answer: send the text now, or keep it as a draft. */
export interface ReplyAnswer {
    action: "send" | "draft";
    /** The reply, trimmed, never empty. */
    text: string;
}

/**
 * replyModal asks for a reply to the comment `ref`, starting from the thread's
 * draft `draft` when it has one. It resolves with the text and whether to
 * send it now or save it as the draft, or null when the user cancels.
 * Ctrl+Enter (Cmd+Enter on macOS) sends.
 */
export function replyModal(
    app: App,
    ref: CommentRef,
    draft: string | null,
): Promise<ReplyAnswer | null> {
    return new Promise((resolve) => {
        let answered = false;
        const who = ref.author === "" ? "comment" : ref.author;
        const verb = draft === null ? "Reply" : "Edit draft reply";
        const modal = new Modal(app).setTitle(`${verb} to ${who}`);
        const el = modal.contentEl;
        if (ref.text !== "") {
            const quote =
                ref.text.length > QUOTE_MAX
                    ? `${ref.text.slice(0, QUOTE_MAX)}…`
                    : ref.text;
            el.createEl("blockquote", {
                cls: "docket-reply-quote",
                text: quote,
            });
        }
        const area = el.createEl("textarea", {
            cls: "docket-reply-text",
            attr: {
                rows: "6",
                placeholder:
                    "Your reply. Markdown works: **bold**, [link](url).",
            },
        });
        area.value = draft ?? "";
        const key = Platform.isMacOS ? "Cmd" : "Ctrl";
        el.createEl("p", {
            cls: "setting-item-description",
            text:
                `Send posts it to Confluence at once (${key}+Enter). ` +
                "Save as draft keeps it in the note under the comment; " +
                "your next push offers to send it.",
        });
        const answer = (action: ReplyAnswer["action"]): void => {
            const text = area.value.trim();
            if (text === "") return;
            answered = true;
            resolve({ action, text });
            modal.close();
        };
        const buttons: HTMLButtonElement[] = [];
        new Setting(el)
            .addButton((b) =>
                b.setButtonText("Cancel").onClick(() => modal.close()),
            )
            .addButton((b) => {
                buttons.push(b.buttonEl);
                b.setButtonText("Save as draft").onClick(() => answer("draft"));
            })
            .addButton((b) => {
                buttons.push(b.buttonEl);
                b.setButtonText("Send")
                    .setCta()
                    .onClick(() => answer("send"));
            });
        const sync = (): void => {
            for (const b of buttons) b.disabled = area.value.trim() === "";
        };
        area.oninput = sync;
        area.onkeydown = (e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                answer("send");
            }
        };
        sync();
        modal.onClose = () => {
            if (!answered) resolve(null);
        };
        modal.open();
        area.focus();
    });
}
