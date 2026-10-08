// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Document front matter: the leading YAML block of a corpus document, of
// which the corpus indexes `id`, `title`, `aliases`, and `url`. Ported from
// Go `pkg/corpus/frontmatter.go`; decoding follows yaml.v3's struct decoding
// (unknown keys ignored, duplicate keys refused, a scalar of any type read as
// its text into a string field, type mismatches collected into one
// "unmarshal errors" report).

import { goQuote } from "../gocompat/strconv.ts";
import {
    parseYaml,
    resolve,
    scalarText,
    shortTag,
    TAG,
    type YamlNode,
} from "../yamlv3/node.ts";

/** EC_FRONT_MATTER is the stable code of a malformed front-matter error. */
export const EC_FRONT_MATTER = "ECFrontMatter";

/** FrontMatter holds the front-matter fields the corpus indexes. */
export interface FrontMatter {
    /** id is the document's stable identity; empty when unset. */
    id: string;
    title: string;
    /** aliases are alternate names; null when the key is absent or null. */
    aliases: string[] | null;
    /** url is the document's canonical URL; it wins over a body URL. */
    url: string;
}

/** FrontMatterError is a present but malformed front-matter block. */
export class FrontMatterError extends Error {
    readonly code = EC_FRONT_MATTER;

    constructor(cause: string) {
        super(`front-matter: ${cause}`);
        this.name = "FrontMatterError";
    }
}

/** emptyFrontMatter returns the zero front matter. */
export function emptyFrontMatter(): FrontMatter {
    return { id: "", title: "", aliases: null, url: "" };
}

/**
 * parseFrontMatter splits leading YAML front matter from the Markdown body.
 * A document with no front-matter fence yields the zero front matter and the
 * unmodified source, as does a fenced block that is not a YAML mapping (a
 * Markdown thematic break opening the body). A present but malformed block
 * throws a {@link FrontMatterError}. A leading byte order mark is dropped.
 */
export function parseFrontMatter(input: string): {
    fm: FrontMatter;
    body: string;
} {
    const src = input.startsWith("﻿") ? input.slice(1) : input;
    const nl = src.indexOf("\n");
    if (nl < 0 || trimCR(src.slice(0, nl)) !== "---") {
        return { fm: emptyFrontMatter(), body: src };
    }
    const rest = src.slice(nl + 1);
    const [yamlEnd, bodyStart] = closingFence(rest);
    if (yamlEnd < 0) return { fm: emptyFrontMatter(), body: src };

    let root: YamlNode | undefined;
    try {
        root = parseYaml(rest.slice(0, yamlEnd));
    } catch (err) {
        throw new FrontMatterError(`yaml: ${(err as Error).message}`);
    }
    if (root === undefined) {
        return { fm: emptyFrontMatter(), body: rest.slice(bodyStart) };
    }
    if (root.kind !== "mapping") return { fm: emptyFrontMatter(), body: src };
    return { fm: decodeFrontMatter(root), body: rest.slice(bodyStart) };
}

/**
 * closingFence locates the "---" line closing a front-matter block within
 * rest, returning where the YAML ends and where the body begins, or
 * [-1, -1] when no closing fence is present.
 */
export function closingFence(rest: string): [number, number] {
    for (let off = 0; off <= rest.length; ) {
        const nl = rest.indexOf("\n", off);
        const line = nl < 0 ? rest.slice(off) : rest.slice(off, nl);
        if (trimCR(line) === "---") {
            return nl < 0 ? [off, rest.length] : [off, nl + 1];
        }
        if (nl < 0) break;
        off = nl + 1;
    }
    return [-1, -1];
}

/**
 * unmarshalDocID reads node as a document identity (Go `docID.UnmarshalYAML`):
 * a non-empty scalar holding no "#" or whitespace; a YAML integer reads as
 * its decimal string. It throws an Error with Go's message otherwise.
 */
export function unmarshalDocID(node: YamlNode): string {
    if (node.kind !== "scalar") throw new Error("id must be a scalar");
    let val = node.value;
    if (shortTag(node) === TAG.int) {
        // An explicit `!!int "12"` resolves its text like a plain scalar.
        const int = resolve(node.value).int;
        if (int !== undefined) val = int.toString();
    }
    if (val === "") throw new Error("id must not be empty");
    if (GO_SPACE_OR_HASH.test(val)) {
        throw new Error('id must not contain "#" or whitespace');
    }
    return val;
}

/** GO_SPACE_OR_HASH matches "#" or a rune Go's `unicode.IsSpace` accepts. */
const GO_SPACE_OR_HASH =
    /[#\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

/** FIELDS are the front-matter keys the corpus reads. */
type Field = "id" | "title" | "aliases" | "url";
const FIELDS: ReadonlySet<string> = new Set<Field>([
    "id",
    "title",
    "aliases",
    "url",
]);

/**
 * decodeFrontMatter decodes a mapping node into front matter as yaml.v3
 * decodes it into the Go struct.
 */
function decodeFrontMatter(root: YamlNode): FrontMatter {
    const fm = emptyFrontMatter();
    const terrors: string[] = [];
    decodeStruct(root, fm, terrors, undefined);
    if (terrors.length > 0) {
        throw new FrontMatterError(
            `yaml: unmarshal errors:\n  ${terrors.join("\n  ")}`,
        );
    }
    return fm;
}

/**
 * decodeStruct decodes mapping n into fm, appending type errors to terrors.
 * skip holds the keys of a parent mapping whose merge this is; those keys
 * were set explicitly and win over merged values.
 */
function decodeStruct(
    n: YamlNode,
    fm: FrontMatter,
    terrors: string[],
    skip: ReadonlySet<string> | undefined,
): void {
    const before = terrors.length;
    for (let i = 0; i < n.content.length; i += 2) {
        const ni = n.content[i] as YamlNode;
        for (let j = i + 2; j < n.content.length; j += 2) {
            const nj = n.content[j] as YamlNode;
            if (ni.kind === nj.kind && ni.value === nj.value) {
                terrors.push(
                    `line ${nj.line}: mapping key ${goQuote(nj.value)} already defined at line ${ni.line}`,
                );
            }
        }
    }
    if (terrors.length > before) return;

    for (let i = 0; i < n.content.length; i += 2) {
        const key = n.content[i] as YamlNode;
        const val = n.content[i + 1] as YamlNode;
        if (isMerge(key)) {
            merge(n, val, fm, terrors);
            continue;
        }
        // yaml.v3 decodes every key into a string, so a collection key is a
        // type error.
        const name = decodeString(deref(key), terrors);
        if (name === undefined || !FIELDS.has(name) || skip?.has(name)) {
            continue;
        }
        decodeField(name as Field, val, fm, terrors);
    }
}

function decodeField(
    name: Field,
    val: YamlNode,
    fm: FrontMatter,
    terrors: string[],
): void {
    const node = deref(val);
    if (shortTag(node) === TAG.null) return;
    switch (name) {
        case "id":
            try {
                fm.id = unmarshalDocID(node);
            } catch (err) {
                throw new FrontMatterError((err as Error).message);
            }
            return;
        case "title":
        case "url": {
            const s = decodeString(node, terrors);
            if (s !== undefined) fm[name] = s;
            return;
        }
        case "aliases":
            fm.aliases = decodeStrings(node, terrors) ?? fm.aliases;
            return;
    }
}

/** decodeString decodes a non-null node into a Go string field. */
function decodeString(node: YamlNode, terrors: string[]): string | undefined {
    if (node.kind === "scalar") {
        try {
            return scalarText(node);
        } catch (err) {
            throw new FrontMatterError((err as Error).message);
        }
    }
    terrors.push(
        `line ${node.line}: cannot unmarshal ${shortTag(node)} into string`,
    );
    return undefined;
}

/** decodeStrings decodes a non-null node into a Go []string field. */
function decodeStrings(
    node: YamlNode,
    terrors: string[],
): string[] | undefined {
    if (node.kind !== "sequence") {
        terror(node, "[]string", terrors);
        return undefined;
    }
    const out: string[] = [];
    for (const item of node.content) {
        const el = deref(item);
        if (shortTag(el) === TAG.null) continue;
        const s = decodeString(el, terrors);
        if (s !== undefined) out.push(s);
    }
    return out;
}

/** terror appends yaml.v3's "cannot unmarshal" type error. */
function terror(node: YamlNode, type: string, terrors: string[]): void {
    const tag = shortTag(node);
    let value = "";
    if (tag !== TAG.seq && tag !== TAG.map) {
        value =
            node.value.length > 10
                ? ` \`${node.value.slice(0, 7)}...\``
                : ` \`${node.value}\``;
    }
    terrors.push(
        `line ${node.line}: cannot unmarshal ${tag}${value} into ${type}`,
    );
}

/** isMerge reports a `<<` merge key (yaml.v3 isMerge). */
function isMerge(n: YamlNode): boolean {
    return (
        n.kind === "scalar" &&
        n.value === "<<" &&
        (n.tag === "" || n.tag === "!" || n.tag === TAG.merge)
    );
}

/** merge applies a `<<` value to fm; parent keys stay as set. */
function merge(
    parent: YamlNode,
    val: YamlNode,
    fm: FrontMatter,
    terrors: string[],
): void {
    const keys = new Set<string>();
    for (let i = 0; i < parent.content.length; i += 2) {
        keys.add(deref(parent.content[i] as YamlNode).value);
    }
    const node = deref(val);
    const maps =
        node.kind === "mapping"
            ? [node]
            : node.kind === "sequence"
              ? node.content.map(deref).reverse()
              : [];
    if (maps.length === 0 || maps.some((m) => m.kind !== "mapping")) {
        throw new FrontMatterError(
            "yaml: map merge requires map or sequence of maps as the value",
        );
    }
    for (const m of maps) decodeStruct(m, fm, terrors, keys);
}

/** deref follows aliases to the anchored node. */
function deref(n: YamlNode): YamlNode {
    let cur = n;
    while (cur.kind === "alias" && cur.alias !== undefined) cur = cur.alias;
    return cur;
}

function trimCR(s: string): string {
    return s.replace(/\r+$/, "");
}
