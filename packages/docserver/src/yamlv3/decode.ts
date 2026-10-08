// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Typed decoding with yaml.v3's rules, for the Go structs the server reads
// from YAML (the plain config, project-config.md front matter). A schema
// names each Go type; decoding collects yaml.v3's "cannot unmarshal" and
// "field not found" type errors and reports them together, as
// `yaml.Unmarshal` does.
//
// yaml.v3 rules reproduced:
//   - null leaves a scalar or struct field unchanged and sets a list, map or
//     pointer to nil; a null map value becomes the element's zero value and a
//     null list item is dropped;
//   - any scalar decodes into a string as its text;
//   - a bool takes !!bool values and the YAML 1.1 words y/yes/on, n/no/off;
//   - an int takes an !!int, or an !!float truncated; a time.Duration takes a
//     Go duration string only;
//   - a mapping with a duplicate key fails before any of it is decoded;
//   - a struct with knownFields refuses keys it does not declare.

import { type Duration, parseDuration } from "../gocompat/duration.ts";
import { goQuote } from "../gocompat/strconv.ts";
import { resolve, scalarText, shortTag, TAG, type YamlNode } from "./node.ts";

/** Schema describes the Go type a node decodes into. */
export type Schema =
    | { kind: "string" }
    | { kind: "bool" }
    | { kind: "int" }
    | { kind: "duration" }
    | { kind: "ptr"; of: Schema }
    | { kind: "list"; of: Schema; type: string }
    | { kind: "map"; of: Schema; type: string; zero: () => unknown }
    | {
          kind: "struct";
          type: string;
          fields: Readonly<Record<string, Schema>>;
      };

/** Decoded is what a struct schema decodes into: field name → value. */
export type Decoded = Record<string, unknown>;

/** YamlDecodeError is yaml.v3's `*yaml.TypeError` ("yaml: unmarshal errors"). */
export class YamlDecodeError extends Error {
    constructor(readonly errors: readonly string[]) {
        super(`yaml: unmarshal errors:\n  ${errors.join("\n  ")}`);
        this.name = "YamlDecodeError";
    }
}

/** DecodeOptions mirror `yaml.Decoder.KnownFields`. */
export interface DecodeOptions {
    knownFields?: boolean;
}

/**
 * decodeInto decodes node into target, a struct value, as
 * `yaml.Unmarshal(text, &target)` does: fields absent or null keep their
 * values. It throws a {@link YamlDecodeError} listing every type error.
 */
export function decodeInto(
    node: YamlNode,
    schema: Extract<Schema, { kind: "struct" }>,
    target: Decoded,
    opts: DecodeOptions = {},
): void {
    const d = new Decoder(opts.knownFields ?? false);
    d.into(node, schema, target);
    if (d.terrors.length > 0) throw new YamlDecodeError(d.terrors);
}

/**
 * decodeValue decodes one node as schema, as `node.Decode(&v)` does into a
 * fresh v: undefined when the node leaves v unset (null). It throws a
 * {@link YamlDecodeError} on a type error.
 */
export function decodeValue(node: YamlNode, schema: Schema): unknown {
    const d = new Decoder(false);
    const v = d.value(node, schema);
    if (d.terrors.length > 0) throw new YamlDecodeError(d.terrors);
    return v === NOT_SET ? undefined : v;
}

/** NOT_SET marks a decode that left its target unchanged. */
const NOT_SET = Symbol("not set");

const TRUE_WORDS = new Set(["y", "Y", "yes", "Yes", "YES", "on", "On", "ON"]);
const FALSE_WORDS = new Set(["n", "N", "no", "No", "NO", "off", "Off", "OFF"]);
const MAX_INT64 = (1n << 63n) - 1n;

class Decoder {
    readonly terrors: string[] = [];

    constructor(private readonly knownFields: boolean) {}

    /** into decodes a mapping node into the struct value target. */
    into(
        node: YamlNode,
        schema: Extract<Schema, { kind: "struct" }>,
        target: Decoded,
    ): void {
        const n = deref(node);
        if (isNull(n)) return;
        if (n.kind !== "mapping") {
            this.terror(n, schema.type);
            return;
        }
        if (this.duplicates(n)) return;
        for (let i = 0; i < n.content.length; i += 2) {
            const key = deref(n.content[i] as YamlNode);
            const name = this.value(key, { kind: "string" });
            if (name === NOT_SET) continue;
            const field = schema.fields[name as string];
            if (field === undefined) {
                if (this.knownFields) {
                    this.terrors.push(
                        `line ${key.line}: field ${name as string} not found in type ${schema.type}`,
                    );
                }
                continue;
            }
            const v = this.value(
                n.content[i + 1] as YamlNode,
                field,
                target[name as string],
            );
            if (v !== NOT_SET) target[name as string] = v;
        }
    }

    /**
     * value decodes node as schema; NOT_SET leaves the target unchanged.
     * current is the target's value, which a struct decodes into.
     */
    value(node: YamlNode, schema: Schema, current?: unknown): unknown {
        const n = deref(node);
        if (isNull(n)) {
            return schema.kind === "ptr" ||
                schema.kind === "list" ||
                schema.kind === "map"
                ? null
                : NOT_SET;
        }
        switch (schema.kind) {
            case "string":
                if (n.kind === "scalar") return scalarText(n);
                return this.terror(n, "string");
            case "bool":
                return this.bool(n);
            case "int":
                return this.int(n);
            case "duration":
                return this.duration(n);
            case "ptr":
                return this.value(n, schema.of);
            case "list": {
                if (n.kind !== "sequence") return this.terror(n, schema.type);
                const out: unknown[] = [];
                for (const item of n.content) {
                    const v = this.value(item, schema.of);
                    if (v !== NOT_SET && v !== null) out.push(v);
                }
                return out;
            }
            case "map": {
                if (n.kind !== "mapping") return this.terror(n, schema.type);
                if (this.duplicates(n)) return NOT_SET;
                const out = new Map<string, unknown>();
                for (let i = 0; i < n.content.length; i += 2) {
                    const name = this.value(n.content[i] as YamlNode, {
                        kind: "string",
                    });
                    if (name === NOT_SET) continue;
                    let v = this.value(
                        n.content[i + 1] as YamlNode,
                        schema.of,
                        schema.zero(),
                    );
                    if (v === NOT_SET) v = schema.zero();
                    out.set(name as string, v);
                }
                return out;
            }
            case "struct": {
                const target = (current as Decoded | undefined) ?? {};
                const before = this.terrors.length;
                this.into(n, schema, target);
                return this.terrors.length > before && n.kind !== "mapping"
                    ? NOT_SET
                    : target;
            }
        }
    }

    private bool(n: YamlNode): unknown {
        if (n.kind === "scalar") {
            const tag = shortTag(n);
            if (tag === TAG.bool) return /^(true|True|TRUE)$/.test(n.value);
            if (tag === TAG.str) {
                if (TRUE_WORDS.has(n.value)) return true;
                if (FALSE_WORDS.has(n.value)) return false;
            }
        }
        return this.terror(n, "bool");
    }

    private int(n: YamlNode): unknown {
        if (n.kind === "scalar") {
            const r = resolveScalar(n);
            if (
                r.int !== undefined &&
                r.int <= MAX_INT64 &&
                r.int >= -MAX_INT64 - 1n
            ) {
                return Number(r.int);
            }
            if (r.tag === TAG.float) {
                const f = Number(n.value.replaceAll("_", ""));
                if (Number.isFinite(f) && f <= 2 ** 63) return Math.trunc(f);
            }
        }
        return this.terror(n, "int");
    }

    private duration(n: YamlNode): unknown {
        if (n.kind === "scalar" && shortTag(n) === TAG.str) {
            try {
                return parseDuration(n.value) as Duration;
            } catch {
                // reported below, as yaml.v3 does
            }
        }
        return this.terror(n, "time.Duration");
    }

    /** duplicates reports a mapping's repeated keys as yaml.v3 does. */
    private duplicates(n: YamlNode): boolean {
        const before = this.terrors.length;
        for (let i = 0; i < n.content.length; i += 2) {
            const ni = n.content[i] as YamlNode;
            for (let j = i + 2; j < n.content.length; j += 2) {
                const nj = n.content[j] as YamlNode;
                if (ni.kind === nj.kind && ni.value === nj.value) {
                    this.terrors.push(
                        `line ${nj.line}: mapping key ${goQuote(nj.value)} already defined at line ${ni.line}`,
                    );
                }
            }
        }
        return this.terrors.length > before;
    }

    /** terror records yaml.v3's "cannot unmarshal" and leaves the target. */
    private terror(n: YamlNode, type: string): typeof NOT_SET {
        const tag = shortTag(n);
        let value = "";
        if (tag !== TAG.seq && tag !== TAG.map) {
            value =
                n.value.length > 10
                    ? ` \`${n.value.slice(0, 7)}...\``
                    : ` \`${n.value}\``;
        }
        this.terrors.push(
            `line ${n.line}: cannot unmarshal ${tag}${value} into ${type}`,
        );
        return NOT_SET;
    }
}

/** resolveScalar resolves a scalar's tag and int value, explicit tags included. */
function resolveScalar(n: YamlNode): { tag: string; int?: bigint } {
    const tag = shortTag(n);
    if (n.style !== "plain" && tag !== TAG.int) return { tag };
    const r = resolve(n.value);
    return tag === TAG.int || tag === r.tag ? r : { tag };
}

function isNull(n: YamlNode): boolean {
    return shortTag(n) === TAG.null;
}

function deref(n: YamlNode): YamlNode {
    let cur = n;
    while (cur.kind === "alias" && cur.alias !== undefined) cur = cur.alias;
    return cur;
}
