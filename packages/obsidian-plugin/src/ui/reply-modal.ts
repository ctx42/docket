// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The reply dialog: it shows the comment being answered and takes the reply's
// text, so a user never types callout syntax. Obsidian glue; the thread under
// the cursor comes from note-actions.ts, sending from the controller.

import type { CommentRef } from "@docket/core";
import { type App, Modal, Platform, Setting } from "obsidian";

/** QUOTE_MAX caps the quoted comment, so a long one leaves room to write. */
const QUOTE_MAX = 600;

/**
 * replyModal asks for a reply to the comment `ref`, resolving with the text
 * (trimmed, never empty) when the user sends it, or null when they cancel.
 * Ctrl+Enter (Cmd+Enter on macOS) sends too.
 */
export function replyModal(app: App, ref: CommentRef): Promise<string | null> {
    return new Promise((resolve) => {
        let answered = false;
        const who = ref.author === "" ? "comment" : ref.author;
        const modal = new Modal(app).setTitle(`Reply to ${who}`);
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
        const key = Platform.isMacOS ? "Cmd" : "Ctrl";
        el.createEl("p", {
            cls: "setting-item-description",
            text: `Send posts it to Confluence at once (${key}+Enter).`,
        });
        const send = (): void => {
            const text = area.value.trim();
            if (text === "") return;
            answered = true;
            resolve(text);
            modal.close();
        };
        let ok: HTMLButtonElement | null = null;
        new Setting(el)
            .addButton((b) =>
                b.setButtonText("Cancel").onClick(() => modal.close()),
            )
            .addButton((b) => {
                ok = b.buttonEl;
                b.setButtonText("Send").setCta().onClick(send);
            });
        const sync = (): void => {
            if (ok !== null) ok.disabled = area.value.trim() === "";
        };
        area.oninput = sync;
        area.onkeydown = (e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
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
