// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Unicode word segmentation as github.com/blevesearch/segment v0.9.1 does it,
// the scanner behind bleve's "unicode" tokenizer. That scanner is a Ragel
// longest-match machine over UAX#29 word-break classes (Unicode 8.0); this
// port rebuilds its grammar as an NFA over the same property tables and runs
// it with Ragel's rule: the longest match wins, then the earliest pattern.

import { WB_PROPS, WB_RANGES } from "./segment-tables.ts";

/** SegmentType is the segment type blevesearch/segment reports. */
export type SegmentType = "none" | "number" | "letter" | "ideo";

/** Segment is one scanned segment; offsets are UTF-8 byte offsets. */
export interface Segment {
    text: string;
    type: SegmentType;
    start: number;
    end: number;
}

type Prop = (typeof WB_PROPS)[number];

/** bit returns the mask bit of a property. */
function bit(p: Prop): number {
    return 1 << WB_PROPS.indexOf(p);
}

const B = {
    DQ: bit("Double_Quote"),
    SQ: bit("Single_Quote"),
    HL: bit("Hebrew_Letter"),
    CR: bit("CR"),
    LF: bit("LF"),
    NL: bit("Newline"),
    EXT: bit("Extend"),
    FMT: bit("Format"),
    KAT: bit("Katakana"),
    AL: bit("ALetter"),
    ML: bit("MidLetter"),
    MN: bit("MidNum"),
    MNL: bit("MidNumLet"),
    NUM: bit("Numeric"),
    ENL: bit("ExtendNumLet"),
    RI: bit("Regional_Indicator"),
    HANGUL: bit("Hangul"),
    HAN: bit("Han"),
    HIRA: bit("Hiragana"),
};

/** maskOf returns the property mask of code point cp. */
export function maskOf(cp: number): number {
    let lo = 0;
    let hi = WB_RANGES.length / 3 - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const first = WB_RANGES[mid * 3] as number;
        if (cp < first) hi = mid - 1;
        else if (cp > (WB_RANGES[mid * 3 + 1] as number)) lo = mid + 1;
        else return WB_RANGES[mid * 3 + 2] as number;
    }
    return 0;
}

// --- Grammar as a regular-expression AST ---

type Ast =
    | { t: "cls"; mask: number }
    | { t: "cat"; xs: Ast[] }
    | { t: "alt"; xs: Ast[] }
    | { t: "star"; x: Ast };

const cls = (mask: number): Ast => ({ t: "cls", mask });
const cat = (...xs: Ast[]): Ast => ({ t: "cat", xs });
const alt = (...xs: Ast[]): Ast => ({ t: "alt", xs });
const star = (x: Ast): Ast => ({ t: "star", x });
const plus = (x: Ast): Ast => cat(x, star(x));
/** ex is `P ( Extend | Format )*`. */
const ex = (mask: number): Ast => cat(cls(mask), star(cls(B.EXT | B.FMT)));

const HangulEx = ex(B.HANGUL);
const HebrewOrALetterEx = ex(B.HL | B.AL);
const NumericEx = ex(B.NUM);
const KatakanaEx = ex(B.KAT);
const MidLetterEx = ex(B.ML | B.MNL | B.SQ);
const MidNumericEx = ex(B.MN | B.MNL | B.SQ);
const ExtendNumLetEx = ex(B.ENL);
const HanEx = ex(B.HAN);
const HiraganaEx = ex(B.HIRA);
const SingleQuoteEx = ex(B.SQ);
const DoubleQuoteEx = ex(B.DQ);
const HebrewLetterEx = ex(B.HL);
const RegionalIndicatorEx = ex(B.RI);

/** numericRun is `NumericEx ( ( ExtendNumLetEx* | MidNumericEx ) NumericEx )*`. */
const numericRun = cat(
    NumericEx,
    star(cat(alt(star(ExtendNumLetEx), MidNumericEx), NumericEx)),
);
const katakanaRun = cat(
    KatakanaEx,
    star(cat(star(ExtendNumLetEx), KatakanaEx)),
);
const letterRun = cat(
    HebrewOrALetterEx,
    star(cat(alt(star(ExtendNumLetEx), MidLetterEx), HebrewOrALetterEx)),
);
const hebrewQuote = cat(
    HebrewLetterEx,
    alt(SingleQuoteEx, cat(DoubleQuoteEx, HebrewLetterEx)),
);

const WordNumeric = cat(
    star(ExtendNumLetEx),
    NumericEx,
    star(cat(alt(star(ExtendNumLetEx), MidNumericEx), NumericEx)),
    star(ExtendNumLetEx),
);
const Word = cat(
    star(ExtendNumLetEx),
    alt(
        katakanaRun,
        plus(alt(hebrewQuote, numericRun, letterRun, ExtendNumLetEx)),
    ),
    star(
        cat(
            plus(ExtendNumLetEx),
            alt(katakanaRun, plus(alt(hebrewQuote, numericRun, letterRun))),
        ),
    ),
    star(ExtendNumLetEx),
);

/** PATTERNS are the scanner's patterns in Ragel order, with their types. */
const PATTERNS: readonly [Ast, SegmentType][] = [
    [WordNumeric, "number"],
    [plus(HangulEx), "letter"],
    [plus(KatakanaEx), "ideo"],
    [Word, "letter"],
    [HanEx, "ideo"],
    [HiraganaEx, "ideo"],
    [plus(RegionalIndicatorEx), "none"],
    [cat(cls(B.CR), cls(B.LF)), "none"],
    [cls(B.CR), "none"],
    [cls(B.LF), "none"],
    [cls(B.NL), "none"],
    [star(cls(B.EXT | B.FMT)), "none"],
];

// --- Thompson NFA with a lazily built DFA ---

interface NfaState {
    eps: number[];
    mask: number;
    next: number;
    /** accept is the pattern index this state accepts, or -1. */
    accept: number;
}

const nfa: NfaState[] = [];

function state(): number {
    nfa.push({ eps: [], mask: 0, next: -1, accept: -1 });
    return nfa.length - 1;
}

/** build adds ast between fresh states and returns [start, end]. */
function build(ast: Ast): [number, number] {
    switch (ast.t) {
        case "cls": {
            const s = state();
            const e = state();
            (nfa[s] as NfaState).mask = ast.mask;
            (nfa[s] as NfaState).next = e;
            return [s, e];
        }
        case "cat": {
            const s = state();
            let cur = s;
            for (const x of ast.xs) {
                const [xs, xe] = build(x);
                (nfa[cur] as NfaState).eps.push(xs);
                cur = xe;
            }
            return [s, cur];
        }
        case "alt": {
            const s = state();
            const e = state();
            for (const x of ast.xs) {
                const [xs, xe] = build(x);
                (nfa[s] as NfaState).eps.push(xs);
                (nfa[xe] as NfaState).eps.push(e);
            }
            return [s, e];
        }
        case "star": {
            const s = state();
            const e = state();
            const [xs, xe] = build(ast.x);
            (nfa[s] as NfaState).eps.push(xs, e);
            (nfa[xe] as NfaState).eps.push(xs, e);
            return [s, e];
        }
    }
}

const START = state();
PATTERNS.forEach(([ast], i) => {
    const [s, e] = build(ast);
    (nfa[START] as NfaState).eps.push(s);
    (nfa[e] as NfaState).accept = i;
});

interface DfaState {
    states: number[];
    /** accept is the lowest accepting pattern index, or -1. */
    accept: number;
    next: Map<number, DfaState | null>;
}

const dfaCache = new Map<string, DfaState>();

function closure(seed: number[]): DfaState {
    const seen = new Set<number>();
    const stack = [...seed];
    while (stack.length > 0) {
        const s = stack.pop() as number;
        if (seen.has(s)) continue;
        seen.add(s);
        stack.push(...(nfa[s] as NfaState).eps);
    }
    const states = [...seen].sort((a, b) => a - b);
    const key = states.join(",");
    let d = dfaCache.get(key);
    if (d === undefined) {
        let accept = -1;
        for (const s of states) {
            const a = (nfa[s] as NfaState).accept;
            if (a >= 0 && (accept < 0 || a < accept)) accept = a;
        }
        d = { states, accept, next: new Map() };
        dfaCache.set(key, d);
    }
    return d;
}

function step(d: DfaState, mask: number): DfaState | null {
    const hit = d.next.get(mask);
    if (hit !== undefined) return hit;
    const seed: number[] = [];
    for (const s of d.states) {
        const st = nfa[s] as NfaState;
        if (st.next >= 0 && (st.mask & mask) !== 0) seed.push(st.next);
    }
    const out = seed.length === 0 ? null : closure(seed);
    d.next.set(mask, out);
    return out;
}

const DFA_START = closure([START]);

/** utf8Len returns the UTF-8 byte length of code point cp. */
function utf8Len(cp: number): number {
    return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/**
 * segmentWords splits text into segments as blevesearch/segment's
 * `NewWordSegmenterDirect` does. "none" segments (spaces, punctuation)
 * are included; bleve's tokenizer skips them.
 */
export function segmentWords(text: string): Segment[] {
    // A lone surrogate is invalid UTF-8 to Go; it reads as U+FFFD.
    const chars = [...text].map((ch) => {
        const cp = ch.codePointAt(0) as number;
        return cp >= 0xd800 && cp <= 0xdfff ? "\ufffd" : ch;
    });
    const cps = chars.map((ch) => ch.codePointAt(0) as number);
    const masks = cps.map(maskOf);
    const out: Segment[] = [];
    const NLCRLF = B.NL | B.CR | B.LF;
    const X = B.EXT | B.FMT;
    let byte = 0;
    for (let i = 0; i < cps.length; ) {
        let len = 0;
        let pat = -1;
        let d: DfaState | null = DFA_START;
        if (d.accept >= 0) pat = d.accept;
        for (let j = i; j < cps.length && d !== null; j++) {
            d = step(d, masks[j] as number);
            if (d !== null && d.accept >= 0) {
                len = j - i + 1;
                pat = d.accept;
            }
        }
        // Ragel's Other pattern matches one byte that is not a line break,
        // then Extend/Format runes; past a multi-byte rune that is just the
        // rune (the action widens the match to the rune's end).
        if (((masks[i] as number) & NLCRLF) === 0) {
            let other = 1;
            if ((cps[i] as number) < 0x80) {
                while (
                    i + other < cps.length &&
                    ((masks[i + other] as number) & X) !== 0
                ) {
                    other++;
                }
            }
            if (other > len) {
                len = other;
                pat = -1;
            }
        }
        if (len === 0) len = 1; // unreachable: every rune has a pattern
        const type: SegmentType =
            pat >= 0 ? (PATTERNS[pat] as [Ast, SegmentType])[1] : "none";
        let bytes = 0;
        for (let k = i; k < i + len; k++) bytes += utf8Len(cps[k] as number);
        out.push({
            text: chars.slice(i, i + len).join(""),
            type,
            start: byte,
            end: byte + bytes,
        });
        byte += bytes;
        i += len;
    }
    return out;
}
