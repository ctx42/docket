// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Go `time.Duration` parsing and formatting. Config values such as
// `watch-debounce: 500ms` are Go duration strings, and log lines print
// durations with Go's `Duration.String`, so both directions port Go's code
// (int64 nanoseconds as bigint) including its error texts.

import { byteString, quoteBytes } from "./utf8.ts";

/** Duration is a Go `time.Duration`: int64 nanoseconds. */
export type Duration = bigint;

/** Duration units, in nanoseconds. */
export const NANOSECOND: Duration = 1n;
export const MICROSECOND: Duration = 1000n * NANOSECOND;
export const MILLISECOND: Duration = 1000n * MICROSECOND;
export const SECOND: Duration = 1000n * MILLISECOND;
export const MINUTE: Duration = 60n * SECOND;
export const HOUR: Duration = 60n * MINUTE;

/** Go uint64 bounds the parser checks against. */
const MAX_INT64 = (1n << 63n) - 1n;
const ONE_63 = 1n << 63n;

/** UNITS maps unit suffixes (as UTF-8 byte strings) to nanoseconds. */
const UNITS: ReadonlyMap<string, bigint> = new Map([
    ["ns", NANOSECOND],
    ["us", MICROSECOND],
    [byteString("µs"), MICROSECOND], // U+00B5 micro sign
    [byteString("μs"), MICROSECOND], // U+03BC Greek mu
    ["ms", MILLISECOND],
    ["s", SECOND],
    ["m", MINUTE],
    ["h", HOUR],
]);

/** DurationParseError is Go's duration parse error; message is Error(). */
export class DurationParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DurationParseError";
    }
}

/**
 * parseDuration parses a Go duration string ("300ms", "-1.5h", "2h45m") like
 * Go `time.ParseDuration`, throwing a {@link DurationParseError} with Go's
 * message.
 */
export function parseDuration(input: string): Duration {
    // Go indexes the string by byte; so do we.
    const orig = byteString(input);
    const invalid = () =>
        new DurationParseError(`time: invalid duration ${quoteBytes(orig)}`);
    let s = orig;
    let d = 0n;
    let neg = false;

    if (s !== "" && (s[0] === "-" || s[0] === "+")) {
        neg = s[0] === "-";
        s = s.slice(1);
    }
    if (s === "0") return 0n;
    if (s === "") throw invalid();

    while (s !== "") {
        let f = 0n;
        let scale = 1;

        if (!(s[0] === "." || isDigit(s[0]))) throw invalid();

        // Consume [0-9]*.
        const lead = leadingInt(s);
        if (!lead) throw invalid();
        let v = lead.x;
        const pre = lead.rem.length !== s.length;
        s = lead.rem;

        // Consume (\.[0-9]*)?.
        let post = false;
        if (s !== "" && s[0] === ".") {
            s = s.slice(1);
            const frac = leadingFraction(s);
            post = frac.rem.length !== s.length;
            f = frac.x;
            scale = frac.scale;
            s = frac.rem;
        }
        if (!pre && !post) throw invalid();

        // Consume the unit.
        let i = 0;
        while (i < s.length && !(s[i] === "." || isDigit(s[i]))) i++;
        if (i === 0) {
            throw new DurationParseError(
                `time: missing unit in duration ${quoteBytes(orig)}`,
            );
        }
        const u = s.slice(0, i);
        s = s.slice(i);
        const unit = UNITS.get(u);
        if (unit === undefined) {
            throw new DurationParseError(
                `time: unknown unit ${quoteBytes(u)} in duration ${quoteBytes(orig)}`,
            );
        }
        if (v > ONE_63 / unit) throw invalid();
        v *= unit;
        if (f > 0n) {
            // float64 arithmetic, truncated, exactly as Go computes it.
            v += BigInt(Math.trunc(Number(f) * (Number(unit) / scale)));
            if (v > ONE_63) throw invalid();
        }
        d += v;
        if (d > ONE_63) throw invalid();
    }
    if (neg) return -d;
    if (d > MAX_INT64) throw invalid();
    return d;
}

/**
 * formatDuration returns Go's `Duration.String()` of d: "1h2m3.5s", "1.5ms",
 * "0s".
 */
export function formatDuration(d: Duration): string {
    let u = d < 0n ? -d : d;
    let out: string;
    if (u < SECOND) {
        // Below one second use the largest unit with a nonzero integer part.
        let prec: number;
        let unit: string;
        if (u === 0n) return "0s";
        if (u < MICROSECOND) {
            prec = 0;
            unit = "ns";
        } else if (u < MILLISECOND) {
            prec = 3;
            unit = "µs";
        } else {
            prec = 6;
            unit = "ms";
        }
        const [frac, whole] = fmtFrac(u, prec);
        out = `${whole}${frac}${unit}`;
    } else {
        const [frac, secs] = fmtFrac(u, 9);
        u = secs;
        out = `${u % 60n}${frac}s`;
        u /= 60n;
        if (u > 0n) {
            out = `${u % 60n}m${out}`;
            u /= 60n;
            // Stop at hours because days can be different lengths.
            if (u > 0n) out = `${u}h${out}`;
        }
    }
    return d < 0n ? `-${out}` : out;
}

/**
 * fmtFrac returns the fraction of v/10**prec (".12345", trailing zeros and a
 * bare point omitted) and the integer part v/10**prec.
 */
function fmtFrac(v: bigint, prec: number): [string, bigint] {
    let digits = "";
    let print = false;
    for (let i = 0; i < prec; i++) {
        const digit = v % 10n;
        print = print || digit !== 0n;
        if (print) digits = `${digit}${digits}`;
        v /= 10n;
    }
    return [print ? `.${digits}` : "", v];
}

function isDigit(c: string | undefined): boolean {
    return c !== undefined && c >= "0" && c <= "9";
}

/** leadingInt is Go's leadingInt; undefined on uint64 overflow. */
function leadingInt(s: string): { x: bigint; rem: string } | undefined {
    let x = 0n;
    let i = 0;
    for (; i < s.length && isDigit(s[i]); i++) {
        if (x > ONE_63 / 10n) return undefined;
        x = x * 10n + BigInt(s.charCodeAt(i) - 48);
        if (x > ONE_63) return undefined;
    }
    return { x, rem: s.slice(i) };
}

/**
 * leadingFraction is Go's leadingFraction: on overflow it keeps consuming
 * digits but stops accumulating precision.
 */
function leadingFraction(s: string): {
    x: bigint;
    scale: number;
    rem: string;
} {
    let x = 0n;
    let scale = 1;
    let overflow = false;
    let i = 0;
    for (; i < s.length && isDigit(s[i]); i++) {
        if (overflow) continue;
        if (x > MAX_INT64 / 10n) {
            overflow = true;
            continue;
        }
        const y = x * 10n + BigInt(s.charCodeAt(i) - 48);
        if (y > ONE_63) {
            overflow = true;
            continue;
        }
        x = y;
        scale *= 10;
    }
    return { x, scale, rem: s.slice(i) };
}
