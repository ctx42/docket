// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Corpus helpers ported from Go `pkg/corpus/helpers.go`: the token estimate
// that decides whether a document is chunked, and the body URL a document
// cites when its front matter names none.

import { fields, trimRight } from "../gocompat/strings.ts";

/**
 * ANY_URL matches an http(s) URL; it stops at whitespace (RE2 `\s`: ASCII
 * only), ")" or "]", so a Markdown link yields its target alone.
 */
const ANY_URL = /https?:\/\/[^\t\n\f\r )\]]+/;

/**
 * estTokens estimates the token count of s from its word count, using the
 * rule-of-thumb ratio of four tokens per three words.
 */
export function estTokens(s: string): number {
    return Math.floor((fields(s).length * 4) / 3);
}

/** nonEmpty returns the non-empty elements of ss in order. */
export function nonEmpty(ss: readonly string[] | null | undefined): string[] {
    return (ss ?? []).filter((s) => s !== "");
}

/** sourceURL returns the first http(s) URL in body, or "" when none. */
export function sourceURL(body: string): string {
    return trimURL(ANY_URL.exec(body)?.[0] ?? "");
}

/** trimURL drops trailing punctuation a URL picks up from prose. */
export function trimURL(url: string): string {
    return trimRight(url, ").,]>");
}
