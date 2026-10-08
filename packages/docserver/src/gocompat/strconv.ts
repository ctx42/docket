// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Go `strconv.Quote` (also what `%q` and `%#v` print for a string): Go error
// texts quote names this way, so the port must too.

/** SHORT holds Go's single-letter escapes. */
const SHORT: Readonly<Record<number, string>> = {
    7: "\\a",
    8: "\\b",
    9: "\\t",
    10: "\\n",
    11: "\\v",
    12: "\\f",
    13: "\\r",
    34: '\\"',
    92: "\\\\",
};

/**
 * NON_PRINT matches what Go's `unicode.IsPrint` rejects: other (control,
 * format, surrogate, private, unassigned) and separators, except ASCII space.
 */
const NON_PRINT = /[\p{C}\p{Z}]/u;

/** goQuote returns s quoted like Go `strconv.Quote`. */
export function goQuote(s: string): string {
    let out = '"';
    for (const ch of s) {
        const cp = ch.codePointAt(0) as number;
        const short = SHORT[cp];
        if (short !== undefined) {
            out += short;
        } else if (cp === 0x20 || !NON_PRINT.test(ch)) {
            out += ch;
        } else if (cp >= 0xdc80 && cp <= 0xdcff) {
            // An invalid byte kept by utf8DecodeEscaped, quoted as Go
            // quotes an invalid byte.
            out += `\\x${(cp - 0xdc00).toString(16).padStart(2, "0")}`;
        } else if (cp >= 0xd800 && cp <= 0xdfff) {
            out += "\\ufffd"; // invalid UTF-8 to Go
        } else if (cp < 0x80) {
            out += `\\x${cp.toString(16).padStart(2, "0")}`;
        } else if (cp < 0x10000) {
            out += `\\u${cp.toString(16).padStart(4, "0")}`;
        } else {
            out += `\\U${cp.toString(16).padStart(8, "0")}`;
        }
    }
    return `${out}"`;
}
