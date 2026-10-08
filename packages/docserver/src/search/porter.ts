// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Porter stemmer ported from github.com/blevesearch/go-porterstemmer v1.0.3,
// the stemmer bleve's English analyzer uses. It keeps that package's exact
// behaviour, including its departures from Martin Porter's reference
// ("bli" and "logi" in step 2, a suffix only matching a strictly longer
// word), because search scores must equal the Go server's. Words are arrays
// of code points (Go runes).

type Runes = string[];

function isConsonant(s: Runes, i: number): boolean {
    switch (s[i]) {
        case "a":
        case "e":
        case "i":
        case "o":
        case "u":
            return false;
        case "y":
            return i === 0 ? true : !isConsonant(s, i - 1);
        default:
            return true;
    }
}

/** measure counts the vowel-consonant sequences of s (Porter's m). */
function measure(s: Runes): number {
    const n = s.length;
    let result = 0;
    let i = 0;
    if (n === 0) return result;
    while (isConsonant(s, i)) {
        i++;
        if (i >= n) return result;
    }
    outer: while (i < n) {
        while (!isConsonant(s, i)) {
            i++;
            if (i >= n) break outer;
        }
        while (isConsonant(s, i)) {
            i++;
            if (i >= n) {
                result++;
                break outer;
            }
        }
        result++;
    }
    return result;
}

/** hasSuffix matches suffix only when s is strictly longer than it. */
function hasSuffix(s: Runes, suffix: string): boolean {
    const suf = [...suffix];
    if (s.length <= suf.length) return false;
    const off = s.length - suf.length;
    return suf.every((ch, i) => s[off + i] === ch);
}

function containsVowel(s: Runes): boolean {
    for (let i = 0; i < s.length; i++) {
        if (!isConsonant(s, i)) return true;
    }
    return false;
}

function hasRepeatDoubleConsonantSuffix(s: Runes): boolean {
    const n = s.length;
    return n >= 2 && s[n - 1] === s[n - 2] && isConsonant(s, n - 1);
}

function hasConsonantVowelConsonantSuffix(s: Runes): boolean {
    const n = s.length;
    return (
        n >= 3 &&
        isConsonant(s, n - 3) &&
        !isConsonant(s, n - 2) &&
        isConsonant(s, n - 1)
    );
}

function step1a(s: Runes): Runes {
    const n = s.length;
    if (hasSuffix(s, "sses")) return s.slice(0, n - 2);
    if (hasSuffix(s, "ies")) return s.slice(0, n - 2);
    if (hasSuffix(s, "ss")) return s;
    if (hasSuffix(s, "s")) return s.slice(0, n - 1);
    return s;
}

/**
 * step1bTail handles the stem left after "ed" or "ing" (Porter 1b). Go keeps
 * one rune of the suffix and, for "ing" (always) or a CVC stem, overwrites it
 * with "e"; for "ed" + at/bl/iz the kept rune already is "e".
 */
function step1bTail(s: Runes, suffixLen: number, ing: boolean): Runes {
    const n = s.length;
    const sub = s.slice(0, n - suffixLen);
    if (!containsVowel(sub)) return s;
    const keepOne = () => s.slice(0, n - suffixLen + 1);
    const withE = () => [...sub, "e"];
    if (hasSuffix(sub, "at") || hasSuffix(sub, "bl") || hasSuffix(sub, "iz")) {
        return ing ? withE() : keepOne();
    }
    const c = sub[sub.length - 1];
    if (
        c !== "l" &&
        c !== "s" &&
        c !== "z" &&
        hasRepeatDoubleConsonantSuffix(sub)
    ) {
        return sub.slice(0, sub.length - 1);
    }
    if (
        measure(sub) === 1 &&
        hasConsonantVowelConsonantSuffix(sub) &&
        c !== "w" &&
        c !== "x" &&
        c !== "y"
    ) {
        return withE();
    }
    return sub;
}

function step1b(s: Runes): Runes {
    const n = s.length;
    if (hasSuffix(s, "eed")) {
        return measure(s.slice(0, n - 3)) > 0 ? s.slice(0, n - 1) : s;
    }
    if (hasSuffix(s, "ed")) return step1bTail(s, 2, false);
    if (hasSuffix(s, "ing")) return step1bTail(s, 3, true);
    return s;
}

function step1c(s: Runes): Runes {
    const n = s.length;
    if (n < 2) return s;
    const last = s[n - 1];
    if ((last === "y" || last === "Y") && containsVowel(s.slice(0, n - 1))) {
        return [...s.slice(0, n - 1), last === "y" ? "i" : "I"];
    }
    return s;
}

/**
 * STEP2 lists Go's step 2 rules in order: suffix, runes to drop from the
 * end, and the replacement for the new tail (applied before the cut).
 */
const STEP2: readonly [string, number, string][] = [
    ["ational", 4, "e"], // relational -> relate
    ["tional", 2, ""],
    ["enci", 0, "e"],
    ["anci", 0, "e"],
    ["izer", 1, ""],
    ["bli", 0, "e"], // departure from Porter's "abli"
    ["alli", 2, ""],
    ["entli", 2, ""],
    ["eli", 2, ""],
    ["ousli", 2, ""],
    ["ization", 4, "e"],
    ["ation", 2, "e"],
    ["ator", 1, "e"],
    ["alism", 3, ""],
    ["iveness", 4, ""],
    ["fulness", 4, ""],
    ["ousness", 4, ""],
    ["aliti", 3, ""],
    ["iviti", 2, "e"],
    ["biliti", 3, "le"],
    ["logi", 1, ""], // departure from Porter
];

function step2(s: Runes): Runes {
    for (const [suffix, drop, repl] of STEP2) {
        if (!hasSuffix(s, suffix)) continue;
        if (measure(s.slice(0, s.length - suffix.length)) <= 0) return s;
        const kept = s.slice(0, s.length - drop);
        // The replacement overwrites the last runes of what is kept.
        const replRunes = [...repl];
        return [...kept.slice(0, kept.length - replRunes.length), ...replRunes];
    }
    return s;
}

/** STEP3 lists Go's step 3 rules: suffix and runes to drop when m > 0. */
const STEP3: readonly [string, number][] = [
    ["icate", 3],
    ["ative", 5],
    ["alize", 3],
    ["iciti", 3],
    ["ical", 2],
    ["ful", 3],
    ["ness", 4],
];

function step3(s: Runes): Runes {
    for (const [suffix, drop] of STEP3) {
        if (!hasSuffix(s, suffix)) continue;
        return measure(s.slice(0, s.length - suffix.length)) > 0
            ? s.slice(0, s.length - drop)
            : s;
    }
    return s;
}

/** STEP4 lists Go's step 4 suffixes, dropped whole when m > 1. */
const STEP4 = [
    "al",
    "ance",
    "ence",
    "er",
    "ic",
    "able",
    "ible",
    "ant",
    "ement",
    "ment",
    "ent",
    "ion",
    "ou",
    "ism",
    "ate",
    "iti",
    "ous",
    "ive",
    "ize",
];

function step4(s: Runes): Runes {
    for (const suffix of STEP4) {
        if (!hasSuffix(s, suffix)) continue;
        const sub = s.slice(0, s.length - suffix.length);
        if (measure(sub) <= 1) return s;
        if (suffix === "ion") {
            const c = sub[sub.length - 1];
            return c === "s" || c === "t" ? sub : s;
        }
        return sub;
    }
    return s;
}

function step5a(s: Runes): Runes {
    const n = s.length;
    if (s[n - 1] !== "e") return s;
    const sub = s.slice(0, n - 1);
    const m = measure(sub);
    if (m > 1) return sub;
    if (m === 1) {
        const c = sub[sub.length - 1];
        const cvc =
            hasConsonantVowelConsonantSuffix(sub) &&
            c !== "w" &&
            c !== "x" &&
            c !== "y";
        if (!cvc) return sub;
    }
    return s;
}

function step5b(s: Runes): Runes {
    const n = s.length;
    if (
        n > 2 &&
        s[n - 2] === "l" &&
        s[n - 1] === "l" &&
        measure(s.slice(0, n - 1)) > 1
    ) {
        return s.slice(0, n - 1);
    }
    return s;
}

/**
 * stemWithoutLowerCasing stems word as go-porterstemmer's
 * `StemWithoutLowerCasing`, the call bleve's `stemmer_porter` filter makes.
 * Words of up to two code points are returned unchanged.
 */
export function stemWithoutLowerCasing(word: string): string {
    let s: Runes = [...word];
    if (s.length <= 2) return word;
    s = step1a(s);
    s = step1b(s);
    s = step1c(s);
    s = step2(s);
    s = step3(s);
    s = step4(s);
    s = step5a(s);
    s = step5b(s);
    return s.join("");
}
