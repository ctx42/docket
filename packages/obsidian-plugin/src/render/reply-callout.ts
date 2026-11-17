// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Reading a rendered `[!comment]` callout. Obsidian-free, so it unit-tests on
// plain strings; the DOM glue that adds the reply button is reply-button.ts.

/**
 * calloutCommentId returns the comment id a rendered `[!comment]` callout's
 * title text starts with (`id:<id> · @author · …`), or null when it has none.
 */
export function calloutCommentId(title: string): string | null {
    const m = /^\s*id:([^\s·]+)/.exec(title);
    return m?.[1] ?? null;
}
