// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The knowledge-base button that the Git and History tabs add to their
// switch: it names the base picked last and, with more than one base, opens a
// menu of them, each with its change count and how many commits it is behind.
// DOM shell; which base it names is repo-choice.ts.

import { Menu, setIcon } from "obsidian";
import type { GitController } from "./controller.ts";
import type { GitRepos } from "./repos.ts";

/** KB_ICON marks a knowledge base on a switch and in its menu. */
export const KB_ICON = "book-open";

/** KbButton is what {@link kbButton} draws and does. */
export interface KbButton {
    repos: GitRepos;
    /** The knowledge base the button names. */
    kb: string;
    /** The knowledge base the tab shows, or null when it shows another kind. */
    shown: string | null;
    /** Whether the button shows its base's change count. */
    counts: boolean;
    /** pick shows the knowledge base in folder `name`. */
    pick: (name: string) => void;
}

/**
 * switchButton draws one switch button: icon, label, and, for a `git`, its
 * change count when it has changes.
 */
export function switchButton(
    bar: HTMLElement,
    label: string,
    icon: string,
    git: GitController | null,
): HTMLElement {
    const el = bar.createDiv({ cls: "clickable-icon docket-history-mode" });
    setIcon(el.createSpan(), icon);
    el.createSpan({ cls: "docket-git-label", text: label });
    const n = git?.ready === true ? git.changes.length : 0;
    if (n > 0) el.createSpan({ cls: "docket-git-badge", text: String(n) });
    return el;
}

/** kbButton draws the knowledge-base button at the end of `bar`. */
export function kbButton(bar: HTMLElement, o: KbButton): void {
    const git = o.repos.kb(o.kb);
    if (git === undefined) return;
    const el = switchButton(bar, o.kb, KB_ICON, o.counts ? git : null);
    el.addClass("docket-git-kb");
    if (o.shown === o.kb) el.addClass("is-active");
    const names = o.repos.kbNames();
    if (names.length === 1) {
        el.setAttribute("aria-label", "Knowledge base");
        el.onclick = () => o.pick(o.kb);
        return;
    }
    el.setAttribute("aria-label", "Pick a knowledge base");
    setIcon(el.createSpan({ cls: "docket-git-chevron" }), "chevron-down");
    el.onclick = () => kbMenu(el, names, o);
}

/** kbMenu opens the menu of knowledge bases under `button`. */
function kbMenu(button: HTMLElement, names: string[], o: KbButton): void {
    const menu = new Menu();
    for (const name of names) {
        const git = o.repos.kb(name);
        if (git === undefined) continue;
        const title = createFragment((f) => {
            const row = f.createSpan({ cls: "docket-git-menu-row" });
            row.createSpan({ cls: "docket-git-menu-name", text: name });
            const meta = row.createSpan({ cls: "docket-git-menu-meta" });
            const n = git.ready ? git.changes.length : 0;
            if (n > 0) {
                meta.createSpan({ cls: "docket-git-badge", text: String(n) });
            }
            const behind = git.counts?.behind ?? 0;
            if (behind > 0) meta.createSpan({ text: `↓${behind}` });
        });
        menu.addItem((item) =>
            item
                .setTitle(title)
                .setIcon(KB_ICON)
                .setChecked(name === o.shown)
                .onClick(() => o.pick(name)),
        );
    }
    const at = button.getBoundingClientRect();
    menu.showAtPosition({ x: at.left, y: at.bottom });
}
