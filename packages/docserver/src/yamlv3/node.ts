// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A `gopkg.in/yaml.v3` compatibility layer over the `yaml` package. The Go
// server decodes YAML with yaml.v3, whose scalar resolution differs from YAML
// 1.2 (`017` is octal, `0b101` binary, underscores ignored in numbers, a
// number decodes into a string field as its literal text). This module turns
// the `yaml` AST into yaml.v3-shaped nodes and resolves tags exactly as
// yaml.v3 does, so decoders written against it behave like the Go code.
// Syntax errors come from the `yaml` parser; their text is mapped onto
// yaml.v3's wording but is not byte-identical.

import {
    type Alias,
    type Node as AstNode,
    type Document,
    isAlias,
    isMap,
    isPair,
    isScalar,
    isSeq,
    parseAllDocuments,
} from "yaml";

import { goBase64Decode } from "../gocompat/base64.ts";
import { utf8Decode } from "../gocompat/utf8.ts";

/** NodeKind mirrors yaml.v3's node kinds (documents are unwrapped). */
export type NodeKind = "scalar" | "sequence" | "mapping" | "alias";

/** NodeStyle mirrors the yaml.v3 styles the decoders care about. */
export type NodeStyle =
    | "plain"
    | "double"
    | "single"
    | "literal"
    | "folded"
    | "flow"
    | "block";

/** YamlNode is a yaml.v3 `*yaml.Node`. */
export interface YamlNode {
    kind: NodeKind;
    style: NodeStyle;
    /**
     * tag is the explicit tag in short form ("!!int", "!x"), `!!merge` for
     * a plain `<<` (yaml.v3's default), or "".
     */
    tag: string;
    /**
     * value is a scalar's text (a `!!binary` scalar's base64 text as
     * written), or an alias's anchor name.
     */
    value: string;
    /** line is 1-based within the parsed text. */
    line: number;
    /** content holds sequence items, or mapping keys and values alternated. */
    content: YamlNode[];
    /** alias is the node an alias refers to. */
    alias?: YamlNode;
    /** offset is the node's start offset in the parsed text. */
    offset: number;
    /** anchor is the anchor name the node defines. */
    anchor?: string;
    /**
     * tagged marks a tag written in the source (yaml.v3's `TaggedStyle`);
     * the encoder keeps it even when the value resolves to it anyway.
     */
    tagged?: boolean;
}

/** Short tags of the YAML core types. */
export const TAG = {
    null: "!!null",
    bool: "!!bool",
    str: "!!str",
    int: "!!int",
    float: "!!float",
    timestamp: "!!timestamp",
    seq: "!!seq",
    map: "!!map",
    binary: "!!binary",
    merge: "!!merge",
} as const;

/** YamlSyntaxError is a parse failure; message reads like yaml.v3's. */
export class YamlSyntaxError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "YamlSyntaxError";
    }
}

/**
 * YamlValueError is a scalar yaml.v3 cannot decode at all (a failure that
 * aborts the whole decode rather than adding a type error).
 */
export class YamlValueError extends Error {
    constructor(problem: string) {
        super(`yaml: ${problem}`);
        this.name = "YamlValueError";
    }
}

/**
 * scalarText returns the string a scalar decodes into: its value, or the
 * base64-decoded bytes of a `!!binary` scalar. It throws a
 * {@link YamlValueError} on malformed base64.
 */
export function scalarText(n: YamlNode): string {
    if (shortTag(n) !== TAG.binary) return n.value;
    const bin = goBase64Decode(n.value);
    if (bin === undefined)
        throw new YamlValueError("!!binary value contains invalid base64 data");
    return utf8Decode(bin);
}

/**
 * parseYaml parses the first YAML document of text as yaml.v3's
 * `yaml.Unmarshal(text, &node)` does, returning the document's root node, or
 * undefined for an empty document. Later documents are ignored, as yaml.v3
 * never reads them.
 */
export function parseYaml(text: string): YamlNode | undefined {
    return parseYamlStream(text).root;
}

/**
 * parseYamlStream parses text like {@link parseYaml} and also reports how
 * many documents the stream holds (yaml.v3's `Decoder` reads them one by
 * one; the plain config refuses a second).
 */
export function parseYamlStream(input: string): {
    root: YamlNode | undefined;
    documents: number;
} {
    // yaml.v3 reads CR and CRLF as line breaks like LF; the `yaml` parser
    // keeps a lone CR as text, so normalize first (line numbers stay the
    // same, as each break is still one line).
    const text = input.replace(/\r\n?/g, "\n");
    const docs = parseAllDocuments(text, {
        schema: "failsafe",
        uniqueKeys: false,
        merge: false,
    });
    const list = (Array.isArray(docs) ? docs : []) as Document[];
    const doc = list[0];
    if (doc === undefined) return { root: undefined, documents: 0 };
    const err = doc.errors.find((e) => e.code !== "MULTIPLE_DOCS");
    if (err !== undefined)
        throw syntaxError(err.code, err.message, err.linePos);
    if (doc.contents === null)
        return { root: undefined, documents: list.length };
    const lines = lineStarts(text);
    return {
        root: convert(doc.contents as AstNode, doc, lines, new Map()),
        documents: list.length,
    };
}

/**
 * shortTag returns the node's tag as yaml.v3's `Node.ShortTag` does: an
 * explicit tag, else the resolved tag of a plain scalar, `!!str` for a quoted
 * or block scalar, and the collection tag otherwise.
 */
export function shortTag(n: YamlNode): string {
    if (n.kind === "alias") return n.alias ? shortTag(n.alias) : "";
    if (n.tag !== "" && n.tag !== "!") return n.tag;
    if (n.kind === "mapping") return TAG.map;
    if (n.kind === "sequence") return TAG.seq;
    if (n.style !== "plain") return TAG.str;
    return resolve(n.value).tag;
}

/** Resolved is a resolved scalar: its tag and, for ints, its value. */
export interface Resolved {
    tag: string;
    /** int is set for an `!!int`: the int64 or uint64 value. */
    int?: bigint;
}

/** RESOLVE_MAP holds yaml.v3's fixed plain-scalar spellings. */
const RESOLVE_MAP: ReadonlyMap<string, string> = new Map([
    ["", TAG.null],
    ["~", TAG.null],
    ["null", TAG.null],
    ["Null", TAG.null],
    ["NULL", TAG.null],
    ["true", TAG.bool],
    ["True", TAG.bool],
    ["TRUE", TAG.bool],
    ["false", TAG.bool],
    ["False", TAG.bool],
    ["FALSE", TAG.bool],
    [".nan", TAG.float],
    [".NaN", TAG.float],
    [".NAN", TAG.float],
    [".inf", TAG.float],
    [".Inf", TAG.float],
    [".INF", TAG.float],
    ["+.inf", TAG.float],
    ["+.Inf", TAG.float],
    ["+.INF", TAG.float],
    ["-.inf", TAG.float],
    ["-.Inf", TAG.float],
    ["-.INF", TAG.float],
]);

const YAML_STYLE_FLOAT =
    /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;
const MAX_INT64 = (1n << 63n) - 1n;
const MIN_INT64 = -(1n << 63n);
const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * resolve is yaml.v3's resolve("", value) for a plain scalar. Like yaml.v3
 * it never yields `!!merge`: `<` is no resolve hint, so `<<` is a string.
 */
export function resolve(value: string): Resolved {
    const fixed = RESOLVE_MAP.get(value);
    if (fixed !== undefined) return { tag: fixed };
    const c = value[0] as string;
    if (c === ".") {
        return goParseFloat(value) ? { tag: TAG.float } : { tag: TAG.str };
    }
    if (!((c >= "0" && c <= "9") || c === "+" || c === "-")) {
        return { tag: TAG.str };
    }
    if (isTimestamp(value)) return { tag: TAG.timestamp };
    const plain = value.replaceAll("_", "");
    const int = goParseInt(plain);
    if (int !== undefined && int >= MIN_INT64 && int <= MAX_INT64) {
        return { tag: TAG.int, int };
    }
    const uint = goParseUint(plain);
    if (uint !== undefined) return { tag: TAG.int, int: uint };
    if (YAML_STYLE_FLOAT.test(plain) && goParseFloat(plain)) {
        return { tag: TAG.float };
    }
    for (const [prefix, base, sign] of [
        ["0b", 2, 1n],
        ["-0b", 2, -1n],
        ["0o", 8, 1n],
        ["-0o", 8, -1n],
    ] as const) {
        if (plain.startsWith(prefix)) {
            const digits = plain.slice(prefix.length);
            const v = digitsValue(digits, base);
            if (v !== undefined) {
                const n = sign * v;
                if (n >= MIN_INT64 && n <= MAX_INT64)
                    return { tag: TAG.int, int: n };
                if (sign > 0n && n <= MAX_UINT64)
                    return { tag: TAG.int, int: n };
            }
            break;
        }
    }
    return { tag: TAG.str };
}

/**
 * goParseInt is Go's `strconv.ParseInt(s, 0, 64)` without the range check:
 * an optional sign, then a 0x/0o/0b prefix, a leading-0 octal, or decimal.
 */
function goParseInt(s: string): bigint | undefined {
    let rest = s;
    let neg = false;
    if (rest[0] === "+" || rest[0] === "-") {
        neg = rest[0] === "-";
        rest = rest.slice(1);
    }
    const v = goParseUintBody(rest);
    if (v === undefined) return undefined;
    return neg ? -v : v;
}

/** goParseUint is Go's `strconv.ParseUint(s, 0, 64)` (no sign). */
function goParseUint(s: string): bigint | undefined {
    const v = goParseUintBody(s);
    return v !== undefined && v <= MAX_UINT64 ? v : undefined;
}

function goParseUintBody(s: string): bigint | undefined {
    if (s === "") return undefined;
    let base = 10;
    let digits = s;
    if (s[0] === "0" && s.length > 1) {
        const p = (s[1] as string).toLowerCase();
        if (p === "x") {
            base = 16;
            digits = s.slice(2);
        } else if (p === "o") {
            base = 8;
            digits = s.slice(2);
        } else if (p === "b") {
            base = 2;
            digits = s.slice(2);
        } else {
            base = 8;
            digits = s.slice(1);
        }
    }
    return digitsValue(digits, base);
}

/** digitsValue parses a non-empty digit string in base; undefined if bad. */
function digitsValue(digits: string, base: number): bigint | undefined {
    if (digits === "") return undefined;
    let v = 0n;
    for (const ch of digits) {
        const d = Number.parseInt(ch, 36);
        if (Number.isNaN(d) || d >= base) return undefined;
        v = v * BigInt(base) + BigInt(d);
    }
    return v;
}

/** goParseFloat reports whether Go's strconv.ParseFloat accepts s. */
function goParseFloat(s: string): boolean {
    return (
        /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s) ||
        /^[-+]?(inf|infinity|nan)$/i.test(s)
    );
}

/** isTimestamp approximates yaml.v3's parseTimestamp acceptance. */
function isTimestamp(s: string): boolean {
    return /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(([Tt]|[ \t]+)[0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(\.[0-9]*)?([ \t]*(Z|[-+][0-9]{1,2}(:[0-9]{2})?))?)?$/.test(
        s,
    );
}

/** lineStarts returns the offset at which each line of text starts. */
function lineStarts(text: string): number[] {
    const out = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") out.push(i + 1);
    }
    return out;
}

/** lineOf returns the 1-based line holding offset. */
function lineOf(lines: number[], offset: number): number {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((lines[mid] as number) <= offset) lo = mid;
        else hi = mid - 1;
    }
    return lo + 1;
}

/** TAG_PREFIX is the YAML core tag namespace `!!` abbreviates. */
const TAG_PREFIX = "tag:yaml.org,2002:";

function short(raw: string | undefined): string {
    if (raw === undefined) return "";
    const tag = unescapeTag(raw);
    return tag.startsWith(TAG_PREFIX)
        ? `!!${tag.slice(TAG_PREFIX.length)}`
        : tag;
}

/**
 * unescapeTag decodes the %XX URI escapes of a tag, as yaml.v3's scanner
 * does; runs that are not valid UTF-8 stay as written.
 */
function unescapeTag(tag: string): string {
    return tag.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
        try {
            return decodeURIComponent(run);
        } catch {
            return run;
        }
    });
}

function convert(
    node: AstNode | Alias,
    doc: Document,
    lines: number[],
    seen: Map<AstNode | Alias, YamlNode>,
): YamlNode {
    const done = seen.get(node);
    if (done !== undefined) return done;
    const offset = node.range?.[0] ?? 0;
    const base = {
        tag: "",
        value: "",
        line: lineOf(lines, offset),
        content: [] as YamlNode[],
        offset,
    };
    if (isAlias(node)) {
        const out: YamlNode = {
            ...base,
            kind: "alias",
            style: "plain",
            value: node.source,
        };
        seen.set(node, out);
        const target = node.resolve(doc);
        if (target === undefined) {
            throw new YamlSyntaxError(
                `unknown anchor '${node.source}' referenced`,
            );
        }
        out.alias = convert(target as AstNode, doc, lines, seen);
        return out;
    }
    if (isScalar(node)) {
        const raw = node.value;
        const value =
            raw instanceof Uint8Array
                ? (node.source ?? "")
                : raw === null || raw === undefined
                  ? ""
                  : String(raw);
        const out: YamlNode = {
            ...base,
            kind: "scalar",
            style: SCALAR_STYLES[node.type ?? "PLAIN"] ?? "plain",
            tag: short(node.tag),
            value,
        };
        mark(out, node);
        // yaml.v3's parser gives an untagged plain `<<` the merge tag.
        if (out.style === "plain" && value === "<<" && out.tagged !== true)
            out.tag = TAG.merge;
        seen.set(node, out);
        return out;
    }
    if (isSeq(node)) {
        const out: YamlNode = {
            ...base,
            kind: "sequence",
            style: node.flow ? "flow" : "block",
            tag: short(node.tag),
        };
        mark(out, node);
        seen.set(node, out);
        for (const item of node.items) {
            out.content.push(
                convertOrNull(item as AstNode | null, doc, lines, seen, out),
            );
        }
        return out;
    }
    if (isMap(node)) {
        const out: YamlNode = {
            ...base,
            kind: "mapping",
            style: node.flow ? "flow" : "block",
            tag: short(node.tag),
        };
        mark(out, node);
        seen.set(node, out);
        for (const pair of node.items) {
            if (!isPair(pair)) continue;
            out.content.push(
                convertOrNull(
                    pair.key as AstNode | null,
                    doc,
                    lines,
                    seen,
                    out,
                ),
                convertOrNull(
                    pair.value as AstNode | null,
                    doc,
                    lines,
                    seen,
                    out,
                ),
            );
        }
        return out;
    }
    throw new YamlSyntaxError("unsupported YAML node");
}

/** mark records node's anchor and whether its tag was written. */
function mark(out: YamlNode, node: AstNode): void {
    if (node.anchor) out.anchor = node.anchor;
    if (out.tag !== "" && out.tag !== "!") out.tagged = true;
}

/** convertOrNull converts node, or makes an empty plain scalar for a gap. */
function convertOrNull(
    node: AstNode | null,
    doc: Document,
    lines: number[],
    seen: Map<AstNode | Alias, YamlNode>,
    parent: YamlNode,
): YamlNode {
    if (node !== null && node !== undefined)
        return convert(node, doc, lines, seen);
    return {
        kind: "scalar",
        style: "plain",
        tag: "",
        value: "",
        line: parent.line,
        content: [],
        offset: parent.offset,
    };
}

const SCALAR_STYLES: Readonly<Record<string, NodeStyle>> = {
    PLAIN: "plain",
    QUOTE_DOUBLE: "double",
    QUOTE_SINGLE: "single",
    BLOCK_LITERAL: "literal",
    BLOCK_FOLDED: "folded",
};

/** SYNTAX_PHRASES maps `yaml` error codes to yaml.v3's wording. */
const SYNTAX_PHRASES: Readonly<Record<string, string>> = {
    BAD_DQ_ESCAPE: "found unknown escape character",
    BAD_SCALAR_START: "found character that cannot start any token",
    BLOCK_AS_IMPLICIT_KEY: "mapping values are not allowed in this context",
    TAB_AS_INDENT: "found a tab character that violates indentation",
};

/** PARSER_PHRASES are yaml.v3 parser (not scanner) errors. */
const PARSER_PHRASES: ReadonlySet<string> = new Set([
    "did not find expected ',' or ']'",
    "did not find expected ',' or '}'",
]);

/**
 * syntaxError words a `yaml` parse error like yaml.v3. yaml.v3 prefixes
 * "line N: " from a 0-based problem line: a scanner error adds one and drops
 * the prefix on the first line; a parser error prints the 0-based number.
 */
function syntaxError(
    code: string,
    message: string,
    linePos: readonly { line: number; col: number }[] | undefined,
): YamlSyntaxError {
    const first = (message.split("\n")[0] as string).replace(
        / at line \d+, column \d+:?$/,
        "",
    );
    let phrase = SYNTAX_PHRASES[code];
    if (/^Flow (sequence|map)/.test(first)) {
        phrase = first.startsWith("Flow map")
            ? "did not find expected ',' or '}'"
            : "did not find expected ',' or ']'";
    } else if (phrase === undefined && code === "MISSING_CHAR") {
        phrase = /closing .*quote/.test(first)
            ? "found unexpected end of stream"
            : "could not find expected ':'";
    }
    const text = phrase ?? first;
    const idx = (linePos?.[0]?.line ?? 1) - 1;
    const line = PARSER_PHRASES.has(text) ? idx : idx === 0 ? 0 : idx + 1;
    return new YamlSyntaxError(line > 0 ? `line ${line}: ${text}` : text);
}
