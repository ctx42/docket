// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A yes/no confirmation dialog, used before an action discards local edits.

import { type App, Modal, Setting } from "obsidian";

/**
 * confirmModal shows `title`, `message`, and a list of `items`, resolving true
 * when the user confirms with the destructive `confirmText` button and false
 * when they cancel or close the dialog.
 */
export function confirmModal(
    app: App,
    title: string,
    message: string,
    items: string[],
    confirmText: string,
): Promise<boolean> {
    return new Promise((resolve) => {
        let answered = false;
        const modal = new Modal(app).setTitle(title);
        modal.contentEl.createEl("p", { text: message });
        if (items.length > 0) {
            const list = modal.contentEl.createEl("ul", {
                cls: "docket-confirm-list",
            });
            for (const item of items) {
                list.createEl("li", { text: item });
            }
        }
        new Setting(modal.contentEl)
            .addButton((b) =>
                b.setButtonText("Cancel").onClick(() => modal.close()),
            )
            .addButton((b) => {
                b.setButtonText(confirmText).onClick(() => {
                    answered = true;
                    resolve(true);
                    modal.close();
                });
                b.buttonEl.addClass("mod-warning");
            });
        modal.onClose = () => {
            if (!answered) resolve(false);
        };
        modal.open();
    });
}
