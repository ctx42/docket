// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// JSON encoding byte-compatible with Go `encoding/json`: HTML-safe escaping of
// `<`, `>`, `&` (optional, on by default as in `json.Marshal`), U+2028/U+2029
// always escaped, Go's control-character escapes, Go float formatting, and
// object fields in the order the caller built them (Go struct field order).
// REST bodies and MCP results must match the Go server byte for byte.

/** GoJSON is a value {@link encodeJSON} can encode. */
export type GoJSON =
    | null
    | boolean
    | number
    | bigint
    | string
    | readonly GoJSON[]
    | { readonly [key: string]: GoJSON | undefined };

/** EncodeOptions mirror `json.Encoder.SetEscapeHTML`. */
export interface EncodeOptions {
    /** escapeHTML escapes `<`, `>`, `&`; default true. */
    escapeHTML?: boolean;
}

/** JSONEncodeError is Go's `json.UnsupportedValueError` (NaN, ±Inf). */
export class JSONEncodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "JSONEncodeError";
    }
}

/**
 * encodeJSON returns v encoded like Go `json.Marshal`. Object properties
 * whose value is undefined are left out (the caller's `omitempty`). Numbers
 * are float64s; pass an int64 beyond 2^53 as a bigint.
 */
export function encodeJSON(v: GoJSON, opts: EncodeOptions = {}): string {
    const out: string[] = [];
    encodeValue(v, opts.escapeHTML ?? true, out);
    return out.join("");
}

/** encodeJSONLine is {@link encodeJSON} plus "\n", as `json.Encoder.Encode`. */
export function encodeJSONLine(v: GoJSON, opts: EncodeOptions = {}): string {
    return `${encodeJSON(v, opts)}\n`;
}

/** formatFloat formats f as Go `encoding/json` encodes a float64. */
export function formatFloat(f: number): string {
    if (!Number.isFinite(f)) {
        const s = Number.isNaN(f) ? "NaN" : f > 0 ? "+Inf" : "-Inf";
        throw new JSONEncodeError(`json: unsupported value: ${s}`);
    }
    if (Object.is(f, -0)) return "-0";
    // Go converts "as if by ES6 number to string conversion" with the same
    // exponent cutoffs (1e-6, 1e21); only the exponent spelling differs:
    // ES writes "1e-7" and "1e+21", which is what Go's cleanup produces too.
    return String(f);
}

/** encodeString quotes s as Go's encoder does. */
export function encodeString(s: string, escapeHTML = true): string {
    let out = '"';
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        let esc: string | undefined;
        if (c < 0x20) {
            esc = CONTROL[c] ?? `\\u00${c.toString(16).padStart(2, "0")}`;
        } else if (c === 0x22) {
            esc = '\\"';
        } else if (c === 0x5c) {
            esc = "\\\\";
        } else if (escapeHTML && (c === 0x3c || c === 0x3e || c === 0x26)) {
            esc = `\\u00${c.toString(16)}`;
        } else if (c === 0x2028 || c === 0x2029) {
            esc = `\\u${c.toString(16)}`;
        } else if (c >= 0xd800 && c <= 0xdfff) {
            // A paired surrogate passes through; a lone one is invalid UTF-8
            // to Go, which writes U+FFFD.
            const next = s.charCodeAt(i + 1);
            if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
                i++;
                continue;
            }
            esc = "\\ufffd";
        }
        if (esc !== undefined) {
            out += s.slice(start, i) + esc;
            start = i + 1;
        }
    }
    return `${out}${s.slice(start)}"`;
}

/** CONTROL holds Go's short escapes for control characters. */
const CONTROL: Readonly<Record<number, string>> = {
    8: "\\b",
    9: "\\t",
    10: "\\n",
    12: "\\f",
    13: "\\r",
};

function encodeValue(v: GoJSON, escapeHTML: boolean, out: string[]): void {
    if (v === null) {
        out.push("null");
    } else if (typeof v === "boolean") {
        out.push(v ? "true" : "false");
    } else if (typeof v === "number") {
        out.push(formatFloat(v));
    } else if (typeof v === "bigint") {
        out.push(v.toString());
    } else if (typeof v === "string") {
        out.push(encodeString(v, escapeHTML));
    } else if (Array.isArray(v)) {
        out.push("[");
        v.forEach((item: GoJSON, i: number) => {
            if (i > 0) out.push(",");
            encodeValue(item, escapeHTML, out);
        });
        out.push("]");
    } else {
        out.push("{");
        let first = true;
        for (const [key, item] of Object.entries(v)) {
            if (item === undefined) continue;
            if (!first) out.push(",");
            first = false;
            out.push(encodeString(key, escapeHTML), ":");
            encodeValue(item, escapeHTML, out);
        }
        out.push("}");
    }
}
