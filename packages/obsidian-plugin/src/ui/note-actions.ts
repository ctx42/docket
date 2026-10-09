// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Which docket actions a note's context menus and commands offer. Obsidian-free,
// so it unit-tests on a plain frontmatter object.

import { parseMeta } from "@docket/core";

/** NoteAction is one docket sync action offered on a note. */
export type NoteAction = "pull" | "push" | "discard";

/**
 * noteActions returns the actions for a note with frontmatter `fm`, in menu
 * order. Only a note pulled from Confluence (it carries a page id) gets any; an
 * `ignore-push` note gets no push.
 */
export function noteActions(fm: unknown): NoteAction[] {
    if (fm === null || fm === undefined) return [];
    const meta = parseMeta(fm);
    if (meta.pageId === "" || meta.local) return [];
    return meta.ignorePush ? ["pull", "discard"] : ["pull", "push", "discard"];
}

/**
 * canPublish reports whether a note's page can be offered for publishing: it
 * is on Confluence (carries a page id) and not marked local. Whether it is
 * still restricted is only known remotely, so publish checks that itself.
 */
export function canPublish(fm: unknown): boolean {
    if (fm === null || fm === undefined) return false;
    const meta = parseMeta(fm);
    return meta.pageId !== "" && !meta.local;
}

/**
 * noteLink returns the Confluence page URL a synced note carries in its `url`
 * frontmatter, or `""` when it has none (or it is not an http(s) URL).
 */
export function noteLink(fm: unknown): string {
    if (typeof fm !== "object" || fm === null) return "";
    const url = (fm as Record<string, unknown>)["url"];
    return typeof url === "string" && /^https?:\/\//.test(url) ? url : "";
}
