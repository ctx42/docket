// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// UTF-8 helpers. Go strings are UTF-8 bytes, so byte-level behaviour (error
// quoting, hashing) needs the encoded form; TextEncoder is not in the
// runtime-neutral ES2022 lib, hence a small hand-written encoder.

/**
 * utf8Encode returns the UTF-8 bytes of s. A lone surrogate encodes as
 * U+FFFD, as Go does when converting invalid UTF-16 to a string.
 */
export function utf8Encode(s: string): Uint8Array {
    const out: number[] = [];
    for (const ch of s) {
        let cp = ch.codePointAt(0) as number;
        if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
        if (cp < 0x80) {
            out.push(cp);
        } else if (cp < 0x800) {
            out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        } else if (cp < 0x10000) {
            out.push(
                0xe0 | (cp >> 12),
                0x80 | ((cp >> 6) & 0x3f),
                0x80 | (cp & 0x3f),
            );
        } else {
            out.push(
                0xf0 | (cp >> 18),
                0x80 | ((cp >> 12) & 0x3f),
                0x80 | ((cp >> 6) & 0x3f),
                0x80 | (cp & 0x3f),
            );
        }
    }
    return Uint8Array.from(out);
}

/**
 * byteString returns s's UTF-8 bytes as a string of one char per byte
 * (U+0000..U+00FF), so Go's byte-indexed string code ports index for index.
 */
export function byteString(s: string): string {
    let out = "";
    for (const b of utf8Encode(s)) out += String.fromCharCode(b);
    return out;
}

/**
 * quoteBytes quotes a {@link byteString} as Go's time package quotes error
 * values: `"` and `\` escaped, control and non-ASCII bytes as `\xNN`.
 */
export function quoteBytes(bin: string): string {
    let out = '"';
    for (let i = 0; i < bin.length; i++) {
        const b = bin.charCodeAt(i);
        if (b >= 0x80 || b < 0x20) {
            out += `\\x${b.toString(16).padStart(2, "0")}`;
        } else {
            const ch = bin[i] as string;
            if (ch === '"' || ch === "\\") out += "\\";
            out += ch;
        }
    }
    return `${out}"`;
}

/**
 * utf8Decode decodes UTF-8 bytes, replacing each invalid sequence with
 * U+FFFD (what Go's encoders write for a string holding invalid UTF-8).
 * `invalid` gives the text for an invalid byte; Go reads invalid UTF-8 one
 * byte at a time.
 */
export function utf8Decode(
    bytes: Uint8Array,
    invalid: (b: number) => string = () => "\uFFFD",
): string {
    let out = "";
    for (let i = 0; i < bytes.length; ) {
        const b = bytes[i] as number;
        let need = 0;
        let cp = 0;
        let min = 0;
        if (b < 0x80) {
            out += String.fromCharCode(b);
            i++;
            continue;
        } else if (b >= 0xc2 && b <= 0xdf) {
            need = 1;
            cp = b & 0x1f;
            min = 0x80;
        } else if (b >= 0xe0 && b <= 0xef) {
            need = 2;
            cp = b & 0x0f;
            min = 0x800;
        } else if (b >= 0xf0 && b <= 0xf4) {
            need = 3;
            cp = b & 0x07;
            min = 0x10000;
        } else {
            out += invalid(b);
            i++;
            continue;
        }
        let j = 1;
        for (; j <= need; j++) {
            const c = bytes[i + j];
            if (c === undefined || (c & 0xc0) !== 0x80) break;
            cp = (cp << 6) | (c & 0x3f);
        }
        if (
            j <= need ||
            cp < min ||
            cp > 0x10ffff ||
            (cp >= 0xd800 && cp <= 0xdfff)
        ) {
            out += invalid(b);
            i++;
            continue;
        }
        out += String.fromCodePoint(cp);
        i += need + 1;
    }
    return out;
}

/**
 * utf8DecodeEscaped decodes UTF-8 bytes keeping each invalid byte b as the
 * lone low surrogate U+DC80+b, so the string still holds the bytes a Go
 * string would: {@link goQuote}-style quoting shows them as `\xNN`, and Go's
 * JSON encoding (gocompat/json.ts) writes them as `\ufffd`.
 */
export function utf8DecodeEscaped(bytes: Uint8Array): string {
    return utf8Decode(bytes, (b) => String.fromCharCode(0xdc00 + b));
}
