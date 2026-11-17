// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A reply button in the title row of every rendered `[!comment]` callout, in
// Live Preview and in Reading view. Clicking it opens the reply dialog for the
// callout's thread. DOM glue only: the button never changes the note's text,
// and the id it answers comes from reply-callout.ts.

import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import {
    editorInfoField,
    type MarkdownPostProcessor,
    setIcon,
    type TFile,
    type Vault,
} from "obsidian";
import { calloutCommentId } from "./reply-callout.ts";

/** ReplyHost is what the buttons need from the plugin. */
export interface ReplyHost {
    /** canReply reports whether the comments of `file` can be answered. */
    canReply(file: TFile): boolean;
    /** reply opens the reply dialog for comment `id` of `file`. */
    reply(file: TFile, id: string): void;
}

/** BUTTON_CLS marks a reply button, so a callout never gets two. */
const BUTTON_CLS = "docket-reply-button";

/** BLOCK_CLS marks a reply button beside a Live Preview block's edit button. */
const BLOCK_CLS = "docket-reply-block";

/** CALLOUTS selects the rendered comment callouts. */
const CALLOUTS = '.callout[data-callout="comment"]';

/**
 * addReplyButtons adds a reply button to every comment callout in `root`
 * (nested reply callouts included) that has an id and no button yet. A click
 * calls `onReply` with the callout's comment id; it stops the event, so Live
 * Preview neither opens the block for editing nor folds it.
 *
 * The outer callout of a Live Preview block gets its button beside Obsidian's
 * edit-block button, in the same corner and style: inside the block's
 * `.embed-actions` row (Obsidian 1.15+), else next to the bare
 * `.edit-block-button` (older). Until the block has either, it waits for a
 * later pass; a title-row button it carries is removed. Any other callout
 * gets its button in its title row, which styles.css pins to the corner.
 */
export function addReplyButtons(
    root: HTMLElement,
    onReply: (id: string) => void,
): void {
    const callouts = Array.from(root.querySelectorAll<HTMLElement>(CALLOUTS));
    if (root.matches(CALLOUTS)) callouts.unshift(root);
    for (const callout of callouts) {
        const title = callout.querySelector<HTMLElement>(
            ":scope > .callout-title",
        );
        if (title === null) continue;
        const inner = title.querySelector(".callout-title-inner");
        const id = calloutCommentId(inner?.textContent ?? "");
        if (id === null) continue;
        const button = placeButton(callout, title);
        if (button === null) continue;
        setIcon(button, "reply");
        button.setAttr("aria-label", "Reply to comment");
        button.setAttr("role", "button");
        button.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        button.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            onReply(id);
        });
    }
}

/**
 * placeButton creates the empty reply button of `callout` where it belongs
 * (see {@link addReplyButtons}), or returns null when the callout already has
 * one or its block's edit button is not drawn yet.
 */
function placeButton(
    callout: HTMLElement,
    title: HTMLElement,
): HTMLElement | null {
    const parent = callout.parentElement;
    const block = parent?.closest<HTMLElement>(".cm-embed-block") ?? null;
    if (block === null || parent?.closest(".callout") != null) {
        if (title.querySelector(`:scope > .${BUTTON_CLS}`) !== null) {
            return null;
        }
        return title.createDiv({ cls: `clickable-icon ${BUTTON_CLS}` });
    }
    // The Reading-view post processor also runs while Live Preview draws the
    // callout, before it sits in its block, and leaves a title-row button.
    title.querySelector(`:scope > .${BUTTON_CLS}`)?.remove();
    if (block.querySelector(`.${BUTTON_CLS}.${BLOCK_CLS}`) !== null) {
        return null;
    }
    const actions = block.querySelector<HTMLElement>(":scope > .embed-actions");
    if (actions !== null) {
        const button = createDiv({
            cls: `embed-action ${BUTTON_CLS} ${BLOCK_CLS}`,
        });
        actions.prepend(button);
        return button;
    }
    const edit = block.querySelector<HTMLElement>(
        ":scope > .edit-block-button",
    );
    if (edit !== null) {
        const button = createDiv({
            cls: `edit-block-button ${BUTTON_CLS} ${BLOCK_CLS}`,
        });
        edit.before(button);
        return button;
    }
    return null;
}

/**
 * replyButtonsPlugin adds the reply buttons in Live Preview. Callouts render
 * as widgets, some after a delay, so it watches the editor's DOM and adds a
 * button to each new comment callout of a note whose comments can be answered.
 */
export function replyButtonsPlugin(host: ReplyHost): Extension {
    return ViewPlugin.fromClass(
        class {
            private readonly observer: MutationObserver;

            constructor(private readonly view: EditorView) {
                this.observer = new MutationObserver(() => this.decorate());
                this.observer.observe(view.contentDOM, {
                    childList: true,
                    subtree: true,
                });
                this.decorate();
            }

            decorate(): void {
                const file = this.view.state.field(
                    editorInfoField,
                    false,
                )?.file;
                if (file == null || !host.canReply(file)) return;
                addReplyButtons(this.view.contentDOM, (id) =>
                    host.reply(file, id),
                );
            }

            destroy(): void {
                this.observer.disconnect();
            }
        },
    );
}

/** replyButtonsPostProcessor adds the reply buttons in Reading view. */
export function replyButtonsPostProcessor(
    vault: Vault,
    host: ReplyHost,
): MarkdownPostProcessor {
    return (el, ctx) => {
        const file = vault.getFileByPath(ctx.sourcePath);
        if (file === null || !host.canReply(file)) return;
        addReplyButtons(el, (id) => host.reply(file, id));
    };
}
