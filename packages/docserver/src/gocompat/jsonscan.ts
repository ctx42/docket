// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Go `encoding/json` syntax checking (scanner.go): the error texts Go's
// `json.Unmarshal` reports for malformed input, such as "unexpected end of
// JSON input" or "invalid character '}' looking for beginning of object key
// string". The scanner runs over UTF-8 bytes, as Go's does.

import { goQuote } from "./strconv.ts";
import { utf8Encode } from "./utf8.ts";

type Step = (c: number) => void;

/** Parse states: what the scanner is inside of. */
const OBJECT_KEY = 0;
const OBJECT_VALUE = 1;
const ARRAY_VALUE = 2;

/**
 * goJSONSyntaxError returns the message Go's `json.Unmarshal` reports for a
 * syntax error in text, or undefined when text is valid JSON.
 */
export function goJSONSyntaxError(text: string): string | undefined {
    const res = scan(utf8Encode(text), false);
    return res.kind === "error" ? res.message : undefined;
}

/** FirstValue is the outcome of {@link goJSONFirstValue}. */
export type FirstValue =
    | { kind: "value"; start: number; end: number }
    | { kind: "error"; message: string }
    | { kind: "more" };

/**
 * goJSONFirstValue scans the first JSON value of data as Go's
 * `json.Decoder.Decode` reads it: it returns the value's byte range once it
 * is complete (later bytes are never looked at), "EOF" or "unexpected EOF"
 * when data ends first (eof true), Go's syntax error text, or "more" when
 * data ends before the value does and more input may follow (eof false).
 */
export function goJSONFirstValue(data: Uint8Array, eof = true): FirstValue {
    return scan(data, true, eof) as FirstValue;
}

type ScanResult =
    | { kind: "value"; start: number; end: number }
    | { kind: "error"; message: string }
    | { kind: "more" }
    | { kind: "ok" };

function scan(data: Uint8Array, first: boolean, eof = true): ScanResult {
    const stack: number[] = [];
    let endTop = false;
    let err: string | undefined;
    let step: Step;

    const fail = (c: number, context: string): void => {
        err = `invalid character ${quoteChar(c)} ${context}`;
    };
    const isSpace = (c: number) =>
        c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
    const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
    const isHex = (c: number) =>
        isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);

    const pop = (): void => {
        stack.pop();
        if (stack.length === 0) {
            step = endTopState;
            endTop = true;
        } else {
            step = endValue;
        }
    };
    const endTopState: Step = (c) => {
        if (!isSpace(c)) fail(c, "after top-level value");
    };
    const endValue: Step = (c) => {
        const n = stack.length;
        if (n === 0) {
            step = endTopState;
            endTop = true;
            endTopState(c);
            return;
        }
        if (isSpace(c)) return;
        switch (stack[n - 1]) {
            case OBJECT_KEY:
                if (c === 0x3a) {
                    stack[n - 1] = OBJECT_VALUE;
                    step = beginValue;
                    return;
                }
                return fail(c, "after object key");
            case OBJECT_VALUE:
                if (c === 0x2c) {
                    stack[n - 1] = OBJECT_KEY;
                    step = beginString;
                    return;
                }
                if (c === 0x7d) return pop();
                return fail(c, "after object key:value pair");
            default:
                if (c === 0x2c) {
                    step = beginValue;
                    return;
                }
                if (c === 0x5d) return pop();
                return fail(c, "after array element");
        }
    };
    const beginValue: Step = (c) => {
        if (isSpace(c)) return;
        switch (c) {
            case 0x7b: // {
                stack.push(OBJECT_KEY);
                step = beginStringOrEmpty;
                return;
            case 0x5b: // [
                stack.push(ARRAY_VALUE);
                step = beginValueOrEmpty;
                return;
            case 0x22:
                step = inString;
                return;
            case 0x2d:
                step = neg;
                return;
            case 0x30:
                step = zero;
                return;
            case 0x74:
                step = literal("true", 1);
                return;
            case 0x66:
                step = literal("false", 1);
                return;
            case 0x6e:
                step = literal("null", 1);
                return;
        }
        if (c >= 0x31 && c <= 0x39) {
            step = one;
            return;
        }
        fail(c, "looking for beginning of value");
    };
    const beginStringOrEmpty: Step = (c) => {
        if (isSpace(c)) return;
        if (c === 0x7d) {
            stack[stack.length - 1] = OBJECT_VALUE;
            return pop();
        }
        beginString(c);
    };
    const beginString: Step = (c) => {
        if (isSpace(c)) return;
        if (c === 0x22) {
            step = inString;
            return;
        }
        fail(c, "looking for beginning of object key string");
    };
    const beginValueOrEmpty: Step = (c) => {
        if (isSpace(c)) return;
        if (c === 0x5d) return pop();
        beginValue(c);
    };
    const inString: Step = (c) => {
        if (c === 0x22) {
            step = endValue;
            return;
        }
        if (c === 0x5c) {
            step = inStringEsc;
            return;
        }
        if (c < 0x20) fail(c, "in string literal");
    };
    const inStringEsc: Step = (c) => {
        if ('bfnrt\\/"'.includes(String.fromCharCode(c))) {
            step = inString;
            return;
        }
        if (c === 0x75) {
            step = hexEsc(4);
            return;
        }
        fail(c, "in string escape code");
    };
    const hexEsc =
        (left: number): Step =>
        (c) => {
            if (!isHex(c))
                return fail(c, "in \\u hexadecimal character escape");
            step = left === 1 ? inString : hexEsc(left - 1);
        };
    const neg: Step = (c) => {
        if (c === 0x30) {
            step = zero;
            return;
        }
        if (c >= 0x31 && c <= 0x39) {
            step = one;
            return;
        }
        fail(c, "in numeric literal");
    };
    const one: Step = (c) => {
        if (isDigit(c)) return;
        zero(c);
    };
    const zero: Step = (c) => {
        if (c === 0x2e) {
            step = dot;
            return;
        }
        if (c === 0x65 || c === 0x45) {
            step = exp;
            return;
        }
        step = endValue;
        endValue(c);
    };
    const dot: Step = (c) => {
        if (isDigit(c)) {
            step = dot0;
            return;
        }
        fail(c, "after decimal point in numeric literal");
    };
    const dot0: Step = (c) => {
        if (isDigit(c)) return;
        if (c === 0x65 || c === 0x45) {
            step = exp;
            return;
        }
        step = endValue;
        endValue(c);
    };
    const exp: Step = (c) => {
        if (c === 0x2b || c === 0x2d) {
            step = expSign;
            return;
        }
        expSign(c);
    };
    const expSign: Step = (c) => {
        if (isDigit(c)) {
            step = exp0;
            return;
        }
        fail(c, "in exponent of numeric literal");
    };
    const exp0: Step = (c) => {
        if (isDigit(c)) return;
        step = endValue;
        endValue(c);
    };
    const literal =
        (word: string, i: number): Step =>
        (c) => {
            const want = word.charCodeAt(i);
            if (c !== want) {
                return fail(
                    c,
                    `in literal ${word} (expecting ${quoteChar(want)})`,
                );
            }
            step = i + 1 === word.length ? endValue : literal(word, i + 1);
        };

    step = beginValue;
    let start = -1;
    for (const [i, c] of data.entries()) {
        if (start < 0 && !isSpace(c)) start = i;
        const depth = stack.length;
        step(c);
        if (err !== undefined) return { kind: "error", message: err };
        if (!first) continue;
        // An object or array ends at its closing byte; any other value at
        // the byte after it, which is not part of the value.
        if (endTop) {
            const closer = depth === 1 && (c === 0x7d || c === 0x5d);
            return { kind: "value", start, end: closer ? i + 1 : i };
        }
    }
    if (first) {
        if (!eof) return { kind: "more" };
        if (start < 0) return { kind: "error", message: "EOF" };
        step(0x20);
        if (err === undefined && endTop)
            return { kind: "value", start, end: data.length };
        return { kind: "error", message: "unexpected EOF" };
    }
    if (endTop) return { kind: "ok" };
    step(0x20);
    if (err !== undefined) return { kind: "error", message: err };
    return endTop
        ? { kind: "ok" }
        : { kind: "error", message: "unexpected end of JSON input" };
}

/** quoteChar formats a byte as Go's scanner does in its errors. */
function quoteChar(c: number): string {
    if (c === 0x27) return "'\\''";
    if (c === 0x22) return "'\"'";
    const s = goQuote(String.fromCharCode(c));
    return `'${s.slice(1, -1)}'`;
}
