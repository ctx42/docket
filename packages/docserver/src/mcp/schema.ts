// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Tool-argument validation as go-sdk runs it with google/jsonschema-go:
// the subset of JSON Schema the tool schemas use (type, properties,
// additionalProperties false, required, items) with jsonschema-go's error
// texts, and Go's `%v` rendering of the offending value. Where Go iterates a
// map (several invalid properties at once) its choice is random; this port
// reports the first in schema order.

import type { JSONSchema } from "./tool-defs.ts";

/** SchemaError is a failed validation; message reads like jsonschema-go's. */
export class SchemaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SchemaError";
    }
}

/**
 * validateArgs validates the tool arguments args against schema and returns
 * go-sdk's tool error text, or undefined when they are valid. Absent
 * arguments validate as an empty object.
 */
export function validateArgs(
    args: Readonly<Record<string, unknown>> | undefined,
    schema: JSONSchema,
): string | undefined {
    try {
        validate(args ?? {}, schema, "root");
    } catch (err) {
        if (err instanceof SchemaError)
            return `validating "arguments": ${err.message}`;
        throw err;
    }
    return undefined;
}

/** validate is jsonschema-go's state.validate for the supported subset. */
function validate(inst: unknown, schema: JSONSchema, path: string): void {
    try {
        check(inst, schema, path);
    } catch (err) {
        if (err instanceof SchemaError)
            throw new SchemaError(`validating ${path}: ${err.message}`);
        throw err;
    }
}

function check(inst: unknown, schema: JSONSchema, path: string): void {
    if (schema.type !== undefined) {
        const got = jsonType(inst);
        const want = schema.type;
        const ok = (t: string) =>
            got === t || (got === "integer" && t === "number");
        if (typeof want === "string") {
            if (!ok(want)) {
                throw new SchemaError(
                    `type: ${goV(inst)} has type "${got}", want "${want}"`,
                );
            }
        } else if (!want.some(ok)) {
            throw new SchemaError(
                `type: ${goV(inst)} has type "${got}", want one of "${want.join(", ")}"`,
            );
        }
    }
    if (Array.isArray(inst) && schema.items !== undefined) {
        for (const item of inst) {
            validate(item, schema.items, `${path}/items`);
        }
    }
    if (!isObject(inst)) return;
    const props = schema.properties ?? {};
    const base = path === "root" ? "" : path;
    for (const [name, sub] of Object.entries(props)) {
        if (!Object.hasOwn(inst, name)) continue;
        validate(inst[name], sub, `${base}/properties/${name}`);
    }
    if (schema.additionalProperties === false) {
        const extra = Object.keys(inst).filter((k) => !Object.hasOwn(props, k));
        if (extra.length > 0) {
            throw new SchemaError(
                `unexpected additional properties ${goQuoteList(extra)}`,
            );
        }
    }
    const missing = (schema.required ?? []).filter(
        (k) => !Object.hasOwn(inst, k),
    );
    if (missing.length > 0) {
        throw new SchemaError(
            `required: missing properties: ${goQuoteList(missing)}`,
        );
    }
}

/** jsonType is jsonschema-go's jsonType: an integral number is "integer". */
export function jsonType(v: unknown): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return "boolean";
    if (typeof v === "number")
        return Number.isInteger(v) ? "integer" : "number";
    if (typeof v === "string") return "string";
    if (Array.isArray(v)) return "array";
    return "object";
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** goQuoteList formats ss like Go's `%q` of a []string. */
function goQuoteList(ss: readonly string[]): string {
    return `[${ss.map((s) => JSON.stringify(s)).join(" ")}]`;
}

/**
 * goV formats a decoded JSON value like Go's `%v` of the reflect.Value
 * jsonschema-go holds: a null instance is an invalid Value, a null inside an
 * array or map is `<nil>`, numbers are float64s, maps print sorted.
 */
export function goV(v: unknown, top = true): string {
    if (v === null || v === undefined)
        return top ? "<invalid reflect.Value>" : "<nil>";
    if (typeof v === "boolean") return String(v);
    if (typeof v === "number") return goFloatV(v);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return `[${v.map((x) => goV(x, false)).join(" ")}]`;
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `map[${keys.map((k) => `${k}:${goV(obj[k], false)}`).join(" ")}]`;
}

/**
 * goFloatV formats f like Go's `%v` of a float64 (strconv 'g', shortest
 * digits): exponent form when the decimal exponent is below -4 or at least
 * 6, the precision shortest 'g' decides with.
 */
export function goFloatV(f: number): string {
    if (Object.is(f, -0)) return "-0";
    if (f === 0) return "0";
    const [mant, expStr] = f.toExponential().split("e") as [string, string];
    const exp = Number(expStr);
    if (exp < -4 || exp >= 6) {
        const sign = exp < 0 ? "-" : "+";
        const abs = Math.abs(exp);
        return `${mant}e${sign}${abs < 10 ? `0${abs}` : abs}`;
    }
    const neg = mant.startsWith("-");
    const digits = mant.replace("-", "").replace(".", "");
    let out: string;
    if (exp >= 0) {
        const intLen = exp + 1;
        out =
            digits.length <= intLen
                ? digits.padEnd(intLen, "0")
                : `${digits.slice(0, intLen)}.${digits.slice(intLen)}`;
    } else {
        out = `0.${"0".repeat(-exp - 1)}${digits}`;
    }
    return neg ? `-${out}` : out;
}
