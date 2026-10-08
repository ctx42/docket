// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// bleve's "en" analyzer, which the Go server indexes and queries with:
// the "unicode" tokenizer, then the possessive_en, to_lower, stop_en, and
// stemmer_porter filters, each ported from bleve v2.6.0 with its byte-level
// quirks, so terms and positions equal the Go index's.

import { utf8Decode, utf8Encode } from "../gocompat/utf8.ts";
import { stemWithoutLowerCasing } from "./porter.ts";
import { segmentWords } from "./segment.ts";
import { STOP_WORDS_EN } from "./stop-words.ts";

/** Token is one analyzed term. */
export interface Token {
    term: string;
    /** position is 1-based and counts every tokenizer token. */
    position: number;
    /** start and end are UTF-8 byte offsets of the source token. */
    start: number;
    end: number;
}

/** tokenize is bleve's "unicode" tokenizer: word segments, positions. */
export function tokenize(text: string): Token[] {
    const out: Token[] = [];
    let pos = 1;
    for (const seg of segmentWords(text)) {
        if (seg.type === "none") continue;
        out.push({
            term: seg.text,
            position: pos++,
            start: seg.start,
            end: seg.end,
        });
    }
    return out;
}

/** POSSESSIVE_MARKS are the apostrophes possessive_en strips before "s". */
const POSSESSIVE_MARKS = new Set(["’", "'", "＇"]);

/** possessive drops a trailing "'s" (any of three apostrophes, s or S). */
export function possessive(term: string): string {
    const runes = [...term];
    const last = runes[runes.length - 1];
    if (
        (last === "s" || last === "S") &&
        POSSESSIVE_MARKS.has(runes[runes.length - 2] as string)
    ) {
        return runes.slice(0, -2).join("");
    }
    return term;
}

/**
 * toLower is bleve's to_lower filter (`toLowerDeferredCopy`), byte for byte:
 * each rune maps through Go's `unicode.ToLower`; a final capital sigma
 * becomes "ς"; a rune whose lowercase is wider hands the rest to
 * `bytes.ToLower`. Its in-place copy skips unchanged runes after a rune that
 * shrank, which garbles the term; that is reproduced too.
 */
export function toLower(term: string): string {
    const s = utf8Encode(term);
    let j = 0;
    for (let i = 0; i < s.length; ) {
        const [r, wid] = decodeRune(s, i);
        let l = goToLower(r);
        if (l === r) {
            i += wid;
            j += wid;
            continue;
        }
        if (l === 0x3c3 && i + 2 === s.length) l = 0x3c2; // final sigma
        const enc = utf8Encode(String.fromCodePoint(l));
        if (enc.length > wid) {
            const rest = utf8Encode(
                [...utf8Decode(s.subarray(i))]
                    .map((ch) =>
                        String.fromCodePoint(
                            goToLower(ch.codePointAt(0) as number),
                        ),
                    )
                    .join(""),
            );
            const rv = new Uint8Array(j + rest.length);
            rv.set(s.subarray(0, j));
            rv.set(rest, j);
            return utf8Decode(rv);
        }
        s.set(enc, j);
        i += wid;
        j += enc.length;
    }
    return utf8Decode(s.subarray(0, j));
}

/** decodeRune decodes the UTF-8 rune at s[i] (input is valid UTF-8). */
function decodeRune(s: Uint8Array, i: number): [number, number] {
    const b = s[i] as number;
    if (b < 0x80) return [b, 1];
    const n = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
    let cp = b & (0xff >> (n + 1));
    for (let k = 1; k < n; k++) cp = (cp << 6) | ((s[i + k] as number) & 0x3f);
    return [cp, n];
}

/**
 * goToLower is Go's `unicode.ToLower` on a code point: the simple mapping,
 * without the multi-rune results and context rules of JS `toLowerCase`.
 */
export function goToLower(cp: number): number {
    if (cp < 0x80) return cp >= 0x41 && cp <= 0x5a ? cp + 32 : cp;
    if (cp === 0x130) return 0x69; // İ
    const lower = String.fromCodePoint(cp).toLowerCase();
    const runes = [...lower];
    return runes.length === 1
        ? ((runes[0] as string).codePointAt(0) as number)
        : cp;
}

/**
 * analyze runs text through bleve's "en" analyzer. Stop words leave gaps in
 * the positions, as bleve's stop filter keeps the others' positions.
 */
export function analyze(text: string): Token[] {
    const out: Token[] = [];
    for (const tok of tokenize(text)) {
        const term = toLower(possessive(tok.term));
        if (STOP_WORDS_EN.has(term)) continue;
        out.push({ ...tok, term: stemWithoutLowerCasing(term) });
    }
    return out;
}
