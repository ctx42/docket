// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Gap helpers ported from Go `pkg/gaps/helpers.go`: file-name slugs, nil
// slices, and case-insensitive de-duplication of ask names. (Go's syncDir
// is the DocFs `syncDir` method here.)

import { trimRight, trimSpace } from "../gocompat/strings.ts";
import { goToLower } from "../search/analyzer.ts";

/**
 * fileSlug returns the lowercase ASCII letters and digits of text, each run
 * joined to the next by one "-", cut to at most limit bytes without a
 * trailing "-"; "" when text has none. Lowercasing is Go's, so the Kelvin
 * sign becomes "k".
 */
export function fileSlug(text: string, limit: number): string {
    let out = "";
    let gap = false;
    for (const ch of text) {
        const r = goToLower(ch.codePointAt(0) as number);
        const ascii = (r >= 0x61 && r <= 0x7a) || (r >= 0x30 && r <= 0x39);
        if (!ascii) {
            gap = out.length > 0;
            continue;
        }
        if (gap) {
            out += "-";
            gap = false;
        }
        out += String.fromCharCode(r);
    }
    if (out.length > limit) out = trimRight(out.slice(0, limit), "-");
    return out;
}

/** nonNil returns ss, or an empty array for null or undefined. */
export function nonNil(ss: readonly string[] | null | undefined): string[] {
    return ss === null || ss === undefined ? [] : [...ss];
}

/**
 * uniqueFold returns ss trimmed, without blank entries, keeping only the
 * first of those equal under Unicode case folding (Go `strings.EqualFold`).
 */
export function uniqueFold(ss: readonly string[] | null | undefined): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of ss ?? []) {
        const str = trimSpace(raw);
        const key = goFold(str);
        if (str === "" || seen.has(key)) continue;
        seen.add(key);
        out.push(str);
    }
    return out;
}

/**
 * goFold maps s so that goFold(a) === goFold(b) when Go's
 * `strings.EqualFold(a, b)` holds: each rune to one representative of its
 * simple case-folding orbit.
 */
export function goFold(s: string): string {
    let out = "";
    for (const ch of s) {
        // Dotted and dotless i fold only to themselves in Go.
        if (ch === "İ" || ch === "ı") {
            out += ch;
            continue;
        }
        const upper = ch.toUpperCase();
        const base = [...upper].length === 1 ? upper : ch;
        const lower = base.toLowerCase();
        out += [...lower].length === 1 ? lower : base;
    }
    return out;
}
