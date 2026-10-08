// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Request-body decoding as the Go server's decodeBody does it: a
// json.Decoder with DisallowUnknownFields over http.MaxBytesReader. Only
// the first JSON value is read (trailing bytes are ignored); object keys
// match struct fields case-insensitively, the exact name first; a null
// leaves a field unset; the first type or unknown-field error in document
// order wins, as Go's decoder saves the first and keeps going; a body whose
// first value does not end within the limit is too large.

import { goJSONFirstValue } from "../gocompat/jsonscan.ts";
import { utf8Decode } from "../gocompat/utf8.ts";

/**
 * FieldType is a request field's Go type. A null clears a pointer or a
 * slice and leaves a string or a bool as it was.
 */
export type FieldType =
    | "string"
    | "bool"
    | "[]string"
    | "*string"
    | "*[]string";

/** RequestSchema is a Go request struct: its name and fields by JSON name. */
export interface RequestSchema {
    /** name is the struct type, e.g. "reportRequest" (package restapi). */
    name: string;
    fields: Readonly<Record<string, FieldType>>;
}

/** BodyError is a body the decoder refuses; status is 400 or 413. */
export class BodyError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "BodyError";
    }
}

/** DecodedBody is a decoded request: each set field's value. */
export type DecodedBody = Record<string, string | boolean | string[]>;

/**
 * decodeBody decodes body (at most limit+1 bytes of the request) as a
 * value of schema. It throws a {@link BodyError} with Go's message:
 * "request body too large: limit N bytes" (413) or "decode request body:
 * <err>" (400).
 */
export function decodeBody(
    body: Uint8Array,
    schema: RequestSchema,
    limit: number,
): DecodedBody {
    const over = body.length > limit;
    const data = over ? body.subarray(0, limit) : body;
    const first = goJSONFirstValue(data, !over);
    if (first.kind === "more") {
        throw new BodyError(
            413,
            `request body too large: limit ${limit} bytes`,
        );
    }
    if (first.kind === "error")
        throw new BodyError(400, `decode request body: ${first.message}`);
    const value: unknown = JSON.parse(
        utf8Decode(data.subarray(first.start, first.end)),
    );
    const err = typeError(value, schema);
    if (err !== undefined)
        throw new BodyError(400, `decode request body: json: ${err}`);
    return assign(value, schema);
}

/** kindOf names a JSON value's kind as Go's UnmarshalTypeError does. */
function kindOf(v: unknown): string {
    if (Array.isArray(v)) return "array";
    if (v === null) return "null";
    if (typeof v === "boolean") return "bool";
    return typeof v === "object" ? "object" : typeof v;
}

/**
 * field finds the schema field a JSON key sets: the exact name, else one
 * equal ignoring case.
 */
function field(schema: RequestSchema, key: string): string | undefined {
    if (Object.hasOwn(schema.fields, key)) return key;
    const lower = key.toLowerCase();
    return Object.keys(schema.fields).find((f) => f.toLowerCase() === lower);
}

/** typeError returns the first error Go's decoder saves for value. */
function typeError(value: unknown, schema: RequestSchema): string | undefined {
    if (value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        return `cannot unmarshal ${kindOf(value)} into Go value of type restapi.${schema.name}`;
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        const name = field(schema, key);
        if (name === undefined) return `unknown field ${JSON.stringify(key)}`;
        const at = `Go struct field ${schema.name}.${name}`;
        const type = (schema.fields[name] as FieldType).replace("*", "");
        if (v === null) continue;
        if (type === "[]string") {
            if (!Array.isArray(v))
                return `cannot unmarshal ${kindOf(v)} into ${at} of type []string`;
            for (const item of v) {
                if (item !== null && typeof item !== "string")
                    return `cannot unmarshal ${kindOf(item)} into ${at} of type string`;
            }
        } else if (typeof v !== (type === "bool" ? "boolean" : "string")) {
            return `cannot unmarshal ${kindOf(v)} into ${at} of type ${type}`;
        }
    }
    return undefined;
}

/** assign collects the set fields of a valid value, last key winning. */
function assign(value: unknown, schema: RequestSchema): DecodedBody {
    const out: DecodedBody = {};
    if (value === null) return out;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        const name = field(schema, key) as string;
        if (v === null) {
            const type = schema.fields[name] as FieldType;
            if (type.startsWith("*") || type === "[]string") delete out[name];
            continue;
        }
        out[name] = Array.isArray(v)
            ? v.map((item) => (item === null ? "" : (item as string)))
            : (v as string | boolean);
    }
    return out;
}
