// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Go `time` formatting and parsing for the two layouts the server uses:
// RFC 3339 (gap `created`, JSON timestamps) and `YYYY-MM-DD` (gap `asked`,
// dated notes). Parsing ports Go's general layout parser for these layouts,
// so accepted inputs and error texts match `time.Parse` exactly.

import { byteString, quoteBytes } from "./utf8.ts";

/**
 * GoTime is an instant plus the zone offset it is shown in, the parts of a Go
 * `time.Time` that formatting depends on.
 */
export interface GoTime {
    /** unix is whole seconds since the Unix epoch. */
    unix: number;
    /** nsec is the nanosecond within the second, 0..999999999. */
    nsec: number;
    /** offset is the zone offset in seconds east of UTC. */
    offset: number;
}

/** TimeLayout names a layout {@link parseTime} accepts. */
export type TimeLayout = "RFC3339" | "DateOnly";

/** LAYOUTS maps each layout name to its Go layout string. */
const LAYOUTS: Record<TimeLayout, string> = {
    RFC3339: "2006-01-02T15:04:05Z07:00",
    DateOnly: "2006-01-02",
};

/** TimeParseError is Go's `*time.ParseError`; the message is its Error(). */
export class TimeParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TimeParseError";
    }
}

/** fromDate returns d as a GoTime shown at offset (default: d's local zone). */
export function fromDate(
    d: Date,
    offset: number = -d.getTimezoneOffset() * 60,
): GoTime {
    const ms = d.getTime();
    const unix = Math.floor(ms / 1000);
    return { unix, nsec: (ms - unix * 1000) * 1_000_000, offset };
}

/** formatRFC3339 formats t like Go `t.Format(time.RFC3339)`. */
export function formatRFC3339(t: GoTime): string {
    return appendRFC3339(t, false);
}

/** formatRFC3339Nano formats t like Go `t.Format(time.RFC3339Nano)`. */
export function formatRFC3339Nano(t: GoTime): string {
    return appendRFC3339(t, true);
}

/**
 * marshalTimeJSON returns Go's `t.MarshalJSON()` bytes (quotes included), or
 * throws Go's error when t has no strict RFC 3339 form.
 */
export function marshalTimeJSON(t: GoTime): string {
    const s = appendRFC3339(t, true);
    if (s[4] !== "-") {
        throw new Error("Time.MarshalJSON: year outside of range [0,9999]");
    }
    if (!s.endsWith("Z")) {
        const c = s[s.length - 6] as string;
        const hh = Number(s.slice(-5, -3));
        if ((c >= "0" && c <= "9") || hh >= 24) {
            throw new Error(
                "Time.MarshalJSON: timezone hour outside of range [0,23]",
            );
        }
    }
    return `"${s}"`;
}

/** formatDateOnly formats t like Go `t.Format(time.DateOnly)`. */
export function formatDateOnly(t: GoTime): string {
    const { year, month, day } = civil(t);
    return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * parseTime parses value like Go `time.Parse` with the named layout; it
 * throws a {@link TimeParseError} carrying Go's message. A value without a
 * zone (DateOnly) is UTC.
 */
export function parseTime(layout: TimeLayout, input: string): GoTime {
    // Go indexes strings by byte; work on the UTF-8 bytes so slicing and the
    // quoted error values match.
    const value = byteString(input);
    const alayout = LAYOUTS[layout];
    const chunks = layout === "RFC3339" ? RFC3339_CHUNKS : DATE_ONLY_CHUNKS;
    let rest = value;
    let year = 0;
    let month = -1;
    let day = -1;
    let hour = 0;
    let min = 0;
    let sec = 0;
    let nsec = 0;
    let offset = 0;

    for (const [prefix, std] of chunks) {
        const skipped = skip(rest, prefix);
        if (skipped === undefined) {
            throw parseError(alayout, value, prefix, rest);
        }
        rest = skipped;
        const hold = rest;
        let bad = false;
        let rangeErr = "";

        switch (std) {
            case "2006": {
                if (rest.length < 4 || !isDigit(rest, 0)) {
                    bad = true;
                    break;
                }
                const n = atoi(rest.slice(0, 4));
                rest = rest.slice(4);
                if (n === undefined) bad = true;
                else year = n;
                break;
            }
            case "01": {
                const r = getnum(rest, true);
                if (!r) {
                    bad = true;
                    break;
                }
                [month, rest] = r;
                if (month <= 0 || month > 12) rangeErr = "month";
                break;
            }
            case "02": {
                const r = getnum(rest, true);
                if (!r) bad = true;
                else [day, rest] = r;
                break;
            }
            case "15": {
                const r = getnum(rest, false);
                if (!r) {
                    bad = true;
                    break;
                }
                [hour, rest] = r;
                if (hour >= 24) rangeErr = "hour";
                break;
            }
            case "04": {
                const r = getnum(rest, true);
                if (!r) {
                    bad = true;
                    break;
                }
                [min, rest] = r;
                if (min >= 60) rangeErr = "minute";
                break;
            }
            case "05": {
                const r = getnum(rest, true);
                if (!r) {
                    bad = true;
                    break;
                }
                [sec, rest] = r;
                if (sec >= 60) {
                    rangeErr = "second";
                    break;
                }
                // A fractional second the layout does not name.
                if (
                    rest.length >= 2 &&
                    (rest[0] === "." || rest[0] === ",") &&
                    isDigit(rest, 1)
                ) {
                    let n = 2;
                    while (n < rest.length && isDigit(rest, n)) n++;
                    const ns = parseNanoseconds(rest, n);
                    if (ns === undefined) bad = true;
                    else nsec = ns;
                    rest = rest.slice(n);
                }
                break;
            }
            case "Z07:00": {
                if (rest.length >= 1 && rest[0] === "Z") {
                    rest = rest.slice(1);
                    offset = 0;
                    break;
                }
                if (rest.length < 6 || rest[3] !== ":") {
                    bad = true;
                    break;
                }
                const sign = rest[0];
                const hh = getnum(rest.slice(1, 3), true);
                const mm = getnum(rest.slice(4, 6), true);
                rest = rest.slice(6);
                if (!hh || !mm) {
                    bad = true;
                    break;
                }
                if (hh[0] > 24) rangeErr = "time zone offset hour";
                if (mm[0] > 60) rangeErr = "time zone offset minute";
                offset = (hh[0] * 60 + mm[0]) * 60;
                if (sign === "-")
                    offset = 0 - offset; // "-00:00" is 0, not -0
                else if (sign !== "+") bad = true;
                break;
            }
        }
        if (rangeErr !== "") {
            throw new TimeParseError(
                `parsing time ${quoteBytes(value)}: ${rangeErr} out of range`,
            );
        }
        if (bad) throw parseError(alayout, value, std, hold);
    }
    if (rest.length !== 0) {
        throw new TimeParseError(
            `parsing time ${quoteBytes(value)}: extra text: ${quoteBytes(rest)}`,
        );
    }
    if (month < 0) month = 1;
    if (day < 0) day = 1;
    if (day < 1 || day > daysIn(month, year)) {
        throw new TimeParseError(
            `parsing time ${quoteBytes(value)}: day out of range`,
        );
    }
    const days = daysFromCivil(year, month, day);
    const unix = days * 86400 + hour * 3600 + min * 60 + sec - offset;
    return { unix, nsec, offset };
}

/**
 * timeQuote quotes s as Go's time package does in its error texts: `"` and
 * `\` escaped, every byte of a control or non-ASCII character as `\xNN`.
 */
export function timeQuote(s: string): string {
    return quoteBytes(byteString(s));
}

/** Layout chunks as Go's nextStdChunk splits them: [literal prefix, std]. */
type Std = "2006" | "01" | "02" | "15" | "04" | "05" | "Z07:00";
const RFC3339_CHUNKS: [string, Std][] = [
    ["", "2006"],
    ["-", "01"],
    ["-", "02"],
    ["T", "15"],
    [":", "04"],
    [":", "05"],
    ["", "Z07:00"],
];
const DATE_ONLY_CHUNKS: [string, Std][] = [
    ["", "2006"],
    ["-", "01"],
    ["-", "02"],
];

function parseError(
    layout: string,
    value: string,
    layoutElem: string,
    valueElem: string,
): TimeParseError {
    return new TimeParseError(
        `parsing time ${quoteBytes(value)} as ${quoteBytes(layout)}: ` +
            `cannot parse ${quoteBytes(valueElem)} as ${quoteBytes(layoutElem)}`,
    );
}

/** skip removes the literal prefix from value; undefined when absent. */
function skip(value: string, prefix: string): string | undefined {
    return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function isDigit(s: string, i: number): boolean {
    const c = s[i];
    return c !== undefined && c >= "0" && c <= "9";
}

/** getnum is Go's getnum: one or two digits (fixed forces two). */
function getnum(s: string, fixed: boolean): [number, string] | undefined {
    if (!isDigit(s, 0)) return undefined;
    if (!isDigit(s, 1)) {
        if (fixed) return undefined;
        return [Number(s[0]), s.slice(1)];
    }
    return [Number(s.slice(0, 2)), s.slice(2)];
}

/** atoi is Go time's atoi over an all-digit string; undefined otherwise. */
function atoi(s: string): number | undefined {
    return /^[0-9]+$/.test(s) ? Number(s) : undefined;
}

/**
 * parseNanoseconds is Go's parseNanoseconds: value[0] is the separator and
 * value[1:n] the digits, truncated to nanosecond precision.
 */
function parseNanoseconds(value: string, n: number): number | undefined {
    const digits = value.slice(1, Math.min(n, 10));
    const ns = atoi(digits);
    if (ns === undefined) return undefined;
    return ns * 10 ** (9 - digits.length);
}

function isLeap(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysIn(month: number, year: number): number {
    if (month === 2 && isLeap(year)) return 29;
    return DAYS_IN[month - 1] as number;
}

/** daysFromCivil returns days since 1970-01-01 (proleptic Gregorian). */
function daysFromCivil(y: number, m: number, d: number): number {
    const yy = m <= 2 ? y - 1 : y;
    const era = Math.floor(yy / 400);
    const yoe = yy - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}

interface Civil {
    year: number;
    month: number;
    day: number;
    hour: number;
    min: number;
    sec: number;
}

/** civil returns t's wall-clock fields in its offset. */
function civil(t: GoTime): Civil {
    const local = t.unix + t.offset;
    const z = Math.floor(local / 86400);
    const sod = local - z * 86400;
    const zz = z + 719468;
    const era = Math.floor(zz / 146097);
    const doe = zz - era * 146097;
    const yoe = Math.floor(
        (doe -
            Math.floor(doe / 1460) +
            Math.floor(doe / 36524) -
            Math.floor(doe / 146096)) /
            365,
    );
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp < 10 ? mp + 3 : mp - 9;
    const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
    return {
        year,
        month,
        day,
        hour: Math.floor(sod / 3600),
        min: Math.floor((sod % 3600) / 60),
        sec: sod % 60,
    };
}

/** pad is Go's appendInt: a sign, then digits zero-padded to width. */
function pad(x: number, width: number): string {
    const digits = String(Math.abs(x)).padStart(width, "0");
    return x < 0 ? `-${digits}` : digits;
}

function appendRFC3339(t: GoTime, nanos: boolean): string {
    const c = civil(t);
    let s =
        `${pad(c.year, 4)}-${pad(c.month, 2)}-${pad(c.day, 2)}` +
        `T${pad(c.hour, 2)}:${pad(c.min, 2)}:${pad(c.sec, 2)}`;
    if (nanos && t.nsec !== 0) {
        s += `.${String(t.nsec).padStart(9, "0").replace(/0+$/, "")}`;
    }
    if (t.offset === 0) return `${s}Z`;
    let zone = Math.trunc(t.offset / 60);
    if (zone < 0) {
        s += "-";
        zone = -zone;
    } else {
        s += "+";
    }
    return `${s}${pad(Math.floor(zone / 60), 2)}:${pad(zone % 60, 2)}`;
}
