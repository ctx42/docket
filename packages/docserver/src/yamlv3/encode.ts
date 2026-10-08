// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A port of yaml.v3's node encoder (encode.go `node`) and of the libyaml
// emitter it drives (emitterc.go), as `yaml.NewEncoder` with `SetIndent`
// runs them: Unicode output, no line-width limit, LF line breaks, one
// implicit document. The emitter works on UTF-8 bytes like the Go code, so
// its quirks carry over (a four-byte character is not "printable" and forces
// a double-quoted `\U` escape). Comments are not modelled.

import { utf8Decode, utf8Encode } from "../gocompat/utf8.ts";
import { resolve, TAG, type YamlNode } from "./node.ts";

/** YamlEncodeError is an encoder failure; message reads like yaml.v3's. */
export class YamlEncodeError extends Error {
    constructor(problem: string) {
        super(`yaml: ${problem}`);
        this.name = "YamlEncodeError";
    }
}

/**
 * encodeNode returns the YAML encoding of node with the given indentation,
 * as yaml.v3's `Encoder.Encode(node)` followed by `Close` writes it.
 */
export function encodeNode(node: YamlNode, indent = 2): string {
    const emt = new Emitter(indent === 0 ? 4 : indent);
    emt.emitDocument(toEvent(node));
    return emt.output();
}

/** LONG_TAG_PREFIX is the expansion of the `!!` tag handle. */
const LONG_TAG_PREFIX = "tag:yaml.org,2002:";

/** ScalarStyle is a libyaml scalar style. */
type ScalarStyle = "plain" | "single" | "double" | "literal" | "folded";

/** Ev is one node as the encoder hands it to the emitter. */
type Ev =
    | {
          kind: "scalar";
          anchor: string;
          tag: string;
          value: Uint8Array;
          style: ScalarStyle;
      }
    | {
          kind: "sequence" | "mapping";
          anchor: string;
          tag: string;
          flow: boolean;
          content: Ev[];
      }
    | { kind: "alias"; anchor: string };

/**
 * toEvent turns node into the emitter's input as encode.go `node` does:
 * a tag that the value would resolve to anyway is dropped, and a `!!str`
 * whose plain form would resolve to another type is double-quoted.
 */
function toEvent(node: YamlNode): Ev {
    let tag = node.tagged !== true && node.tag === "!" ? "" : node.tag;
    let forceQuoting = false;
    if (tag !== "" && node.tagged !== true) {
        if (node.kind === "scalar") {
            const quoted = node.style !== "plain";
            if (tag === TAG.str && quoted) {
                tag = "";
            } else if (resolve(node.value).tag === tag) {
                tag = "";
            } else if (tag === TAG.str) {
                tag = "";
                forceQuoting = true;
            }
        } else if (
            (node.kind === "mapping" && tag === TAG.map) ||
            (node.kind === "sequence" && tag === TAG.seq)
        ) {
            tag = "";
        }
    }
    const anchor = node.anchor ?? "";
    switch (node.kind) {
        case "alias":
            return { kind: "alias", anchor: node.value };
        case "sequence":
        case "mapping":
            return {
                kind: node.kind,
                anchor,
                tag: longTag(tag),
                flow: node.style === "flow",
                content: node.content.map(toEvent),
            };
    }
    let style: ScalarStyle = "plain";
    if (node.style === "double") style = "double";
    else if (node.style === "single") style = "single";
    else if (node.style === "literal") style = "literal";
    else if (node.style === "folded") style = "folded";
    else if (node.value.includes("\n")) style = "literal";
    else if (forceQuoting) style = "double";
    return {
        kind: "scalar",
        anchor,
        tag: longTag(tag),
        value: utf8Encode(node.value),
        style,
    };
}

/** longTag expands a `!!` short tag. */
function longTag(tag: string): string {
    return tag.startsWith("!!") ? LONG_TAG_PREFIX + tag.slice(2) : tag;
}

/** TAG_DIRECTIVES are libyaml's default tag directives, in match order. */
const TAG_DIRECTIVES: readonly { handle: string; prefix: string }[] = [
    { handle: "!", prefix: "!" },
    { handle: "!!", prefix: LONG_TAG_PREFIX },
];

/** Analysis is libyaml's per-scalar analysis. */
interface Analysis {
    multiline: boolean;
    flowPlainAllowed: boolean;
    blockPlainAllowed: boolean;
    singleQuotedAllowed: boolean;
    blockAllowed: boolean;
}

/** Context is the emit_node context the emitter acts on. */
interface Context {
    simpleKey: boolean;
    /** inSeqItem is whether the state stack top is a block sequence item. */
    inSeqItem: boolean;
}

/**
 * Emitter is the libyaml emitter state machine, run recursively over the
 * event tree instead of a queued event stream; the observable state (column,
 * whitespace, indention, indent stack, flow level) follows the Go code.
 */
class Emitter {
    private readonly out: number[] = [];
    private readonly bestIndent: number;
    private column = 0;
    private whitespace = true;
    private indention = true;
    private indent = -1;
    private readonly indents: number[] = [];
    private flowLevel = 0;
    private footIndent = -1;

    // Per-event analysis (analyze_event).
    private anchor = "";
    private alias = false;
    private tagHandle = "";
    private tagSuffix = "";
    private scalar: Analysis = {
        multiline: false,
        flowPlainAllowed: false,
        blockPlainAllowed: true,
        singleQuotedAllowed: true,
        blockAllowed: false,
    };
    private scalarStyle: ScalarStyle = "plain";

    constructor(indent: number) {
        this.bestIndent = indent < 2 || indent > 9 ? 2 : indent;
    }

    output(): string {
        return utf8Decode(new Uint8Array(this.out));
    }

    /** emitDocument emits an implicit document holding root. */
    emitDocument(root: Ev): void {
        this.analyze(root);
        this.emitNode(root, {
            simpleKey: false,
            inSeqItem: false,
        });
        this.footIndent = -1;
        this.writeIndent();
    }

    // --- Analysis --------------------------------------------------------

    /** analyze is yaml_emitter_analyze_event. */
    private analyze(ev: Ev | undefined): void {
        this.anchor = "";
        this.alias = false;
        this.tagHandle = "";
        this.tagSuffix = "";
        if (ev === undefined) return;
        if (ev.kind === "alias") {
            this.analyzeAnchor(ev.anchor, true);
            return;
        }
        if (ev.anchor !== "") this.analyzeAnchor(ev.anchor, false);
        if (ev.tag !== "") this.analyzeTag(ev.tag);
        if (ev.kind === "scalar") this.scalar = analyzeScalar(ev.value);
    }

    private analyzeAnchor(anchor: string, alias: boolean): void {
        const what = alias ? "alias" : "anchor";
        if (anchor === "")
            throw new YamlEncodeError(`${what} value must not be empty`);
        const b = utf8Encode(anchor);
        for (let i = 0; i < b.length; i += width(b[i] as number)) {
            if (!isAlpha(b, i)) {
                throw new YamlEncodeError(
                    `${what} value must contain alphanumerical characters only`,
                );
            }
        }
        this.anchor = anchor;
        this.alias = alias;
    }

    private analyzeTag(tag: string): void {
        for (const dir of TAG_DIRECTIVES) {
            if (tag.startsWith(dir.prefix)) {
                this.tagHandle = dir.handle;
                this.tagSuffix = tag.slice(dir.prefix.length);
                return;
            }
        }
        this.tagSuffix = tag;
    }

    // --- Nodes -----------------------------------------------------------

    /** emitNode is yaml_emitter_emit_node; ev is already analyzed. */
    private emitNode(ev: Ev, ctx: Context): void {
        switch (ev.kind) {
            case "alias":
                this.processAnchor();
                return;
            case "scalar":
                this.emitScalar(ev, ctx);
                return;
        }
        this.processAnchor();
        this.processTag();
        const flow = this.flowLevel > 0 || ev.flow || ev.content.length === 0;
        if (ev.kind === "sequence") {
            if (flow) this.flowSequence(ev.content, ctx);
            else this.blockSequence(ev.content, ctx);
        } else if (flow) {
            this.flowMapping(ev.content, ctx);
        } else {
            this.blockMapping(ev.content, ctx);
        }
    }

    private emitScalar(
        ev: Extract<Ev, { kind: "scalar" }>,
        ctx: Context,
    ): void {
        this.selectScalarStyle(ev, ctx);
        this.processAnchor();
        this.processTag();
        this.increaseIndent(true, ctx.inSeqItem);
        const value = ev.value;
        switch (this.scalarStyle) {
            case "plain":
                this.writePlain(value);
                break;
            case "single":
                this.writeSingleQuoted(value);
                break;
            case "double":
                this.writeDoubleQuoted(value);
                break;
            case "literal":
                this.writeLiteral(value);
                break;
            case "folded":
                this.writeFolded(value);
                break;
        }
        this.popIndent();
    }

    private flowSequence(items: Ev[], ctx: Context): void {
        this.writeIndicator("[", true, true, false);
        this.increaseIndent(true, ctx.inSeqItem);
        this.flowLevel++;
        items.forEach((item, i) => {
            this.analyze(item);
            if (i > 0) this.writeIndicator(",", false, false, false);
            if (this.column === 0) this.writeIndent();
            this.emitNode(item, {
                simpleKey: false,
                inSeqItem: false,
            });
        });
        this.analyze(undefined);
        this.flowLevel--;
        this.popIndent();
        if (this.column === 0) this.writeIndent();
        this.writeIndicator("]", false, false, false);
    }

    private flowMapping(content: Ev[], ctx: Context): void {
        this.writeIndicator("{", true, true, false);
        this.increaseIndent(true, ctx.inSeqItem);
        this.flowLevel++;
        for (let i = 0; i + 1 < content.length; i += 2) {
            const key = content[i] as Ev;
            const val = content[i + 1] as Ev;
            this.analyze(key);
            if (i > 0) this.writeIndicator(",", false, false, false);
            if (this.column === 0) this.writeIndent();
            const simple = this.checkSimpleKey(key);
            if (!simple) this.writeIndicator("?", true, false, false);
            this.emitNode(key, {
                simpleKey: simple,
                inSeqItem: false,
            });
            this.analyze(val);
            if (simple) this.writeIndicator(":", false, false, false);
            else this.writeIndicator(":", true, false, false);
            this.emitNode(val, {
                simpleKey: false,
                inSeqItem: false,
            });
        }
        this.analyze(undefined);
        this.flowLevel--;
        this.popIndent();
        this.writeIndicator("}", false, false, false);
    }

    private blockSequence(items: Ev[], ctx: Context): void {
        this.increaseIndent(false, ctx.inSeqItem);
        for (const item of items) {
            this.analyze(item);
            this.writeIndent();
            this.writeIndicator("-", true, false, true);
            this.emitNode(item, {
                simpleKey: false,
                inSeqItem: true,
            });
        }
        this.analyze(undefined);
        this.popIndent();
    }

    private blockMapping(content: Ev[], ctx: Context): void {
        this.increaseIndent(false, ctx.inSeqItem);
        for (let i = 0; i + 1 < content.length; i += 2) {
            const key = content[i] as Ev;
            const val = content[i + 1] as Ev;
            this.analyze(key);
            this.writeIndent();
            const simple = this.checkSimpleKey(key);
            if (!simple) this.writeIndicator("?", true, false, true);
            this.emitNode(key, {
                simpleKey: simple,
                inSeqItem: false,
            });
            this.analyze(val);
            if (simple) {
                this.writeIndicator(":", false, false, false);
            } else {
                this.writeIndent();
                this.writeIndicator(":", true, false, true);
            }
            this.emitNode(val, {
                simpleKey: false,
                inSeqItem: false,
            });
        }
        this.analyze(undefined);
        this.popIndent();
    }

    /** checkSimpleKey is yaml_emitter_check_simple_key for analyzed ev. */
    private checkSimpleKey(ev: Ev): boolean {
        let length = byteLength(this.anchor);
        switch (ev.kind) {
            case "alias":
                break;
            case "scalar":
                if (this.scalar.multiline) return false;
                length +=
                    this.tagHandle.length +
                    byteLength(this.tagSuffix) +
                    ev.value.length;
                break;
            default:
                if (ev.content.length > 0) return false;
                length += this.tagHandle.length + byteLength(this.tagSuffix);
        }
        return length <= 128;
    }

    /** selectScalarStyle is yaml_emitter_select_scalar_style. */
    private selectScalarStyle(
        ev: Extract<Ev, { kind: "scalar" }>,
        ctx: Context,
    ): void {
        const sc = this.scalar;
        let style = ev.style;
        if (ctx.simpleKey && sc.multiline) style = "double";
        if (style === "plain") {
            if (
                (this.flowLevel > 0 && !sc.flowPlainAllowed) ||
                (this.flowLevel === 0 && !sc.blockPlainAllowed)
            ) {
                style = "single";
            }
            if (
                ev.value.length === 0 &&
                (this.flowLevel > 0 || ctx.simpleKey)
            ) {
                style = "single";
            }
        }
        if (style === "single" && !sc.singleQuotedAllowed) style = "double";
        if (
            (style === "literal" || style === "folded") &&
            (!sc.blockAllowed || this.flowLevel > 0 || ctx.simpleKey)
        ) {
            style = "double";
        }
        this.scalarStyle = style;
    }

    private processAnchor(): void {
        if (this.anchor === "") return;
        this.writeIndicator(this.alias ? "*" : "&", true, false, false);
        this.writeRaw(utf8Encode(this.anchor));
        this.whitespace = false;
        this.indention = false;
    }

    private processTag(): void {
        if (this.tagHandle === "" && this.tagSuffix === "") return;
        if (this.tagHandle !== "") {
            if (!this.whitespace) this.put(0x20);
            this.writeRaw(utf8Encode(this.tagHandle));
            this.whitespace = false;
            this.indention = false;
            if (this.tagSuffix !== "") this.writeTagContent(this.tagSuffix);
            return;
        }
        this.writeIndicator("!<", true, false, false);
        this.writeTagContent(this.tagSuffix);
        this.writeIndicator(">", false, false, false);
    }

    private writeTagContent(tag: string): void {
        const b = utf8Encode(tag);
        for (let i = 0; i < b.length; ) {
            const c = b[i] as number;
            if (TAG_SAFE.has(c) || isAlpha(b, i)) {
                i = this.write(b, i);
                continue;
            }
            const w = width(c);
            for (let k = 0; k < w; k++) {
                const octet = b[i] as number;
                i++;
                this.put(0x25); // '%'
                this.put(hexDigit(octet >> 4));
                this.put(hexDigit(octet & 0x0f));
            }
        }
        this.whitespace = false;
        this.indention = false;
    }

    // --- Indentation -----------------------------------------------------

    /** increaseIndent is yaml_emitter_increase_indent (never indentless). */
    private increaseIndent(flow: boolean, inSeqItem: boolean): void {
        this.indents.push(this.indent);
        if (this.indent < 0) {
            this.indent = flow ? this.bestIndent : 0;
        } else if (inSeqItem) {
            this.indent += 2;
        } else {
            const best = this.bestIndent;
            this.indent = best * Math.trunc((this.indent + best) / best);
        }
    }

    private popIndent(): void {
        this.indent = this.indents.pop() as number;
    }

    private writeIndent(): void {
        const indent = Math.max(this.indent, 0);
        if (
            !this.indention ||
            this.column > indent ||
            (this.column === indent && !this.whitespace)
        ) {
            this.putBreak();
        }
        if (this.footIndent === indent) this.putBreak();
        while (this.column < indent) this.put(0x20);
        this.whitespace = true;
        this.footIndent = -1;
    }

    private writeIndicator(
        indicator: string,
        needWhitespace: boolean,
        isWhitespace: boolean,
        isIndention: boolean,
    ): void {
        if (needWhitespace && !this.whitespace) this.put(0x20);
        this.writeRaw(utf8Encode(indicator));
        this.whitespace = isWhitespace;
        this.indention = this.indention && isIndention;
    }

    // --- Scalars ---------------------------------------------------------

    private writePlain(value: Uint8Array): void {
        if (value.length > 0 && !this.whitespace) this.put(0x20);
        let breaks = false;
        for (let i = 0; i < value.length; ) {
            if (isSpace(value, i)) {
                i = this.write(value, i);
            } else if (isBreak(value, i)) {
                if (!breaks && value[i] === 0x0a) this.putBreak();
                i = this.writeBreak(value, i);
                breaks = true;
            } else {
                if (breaks) this.writeIndent();
                i = this.write(value, i);
                this.indention = false;
                breaks = false;
            }
        }
        if (value.length > 0) this.whitespace = false;
        this.indention = false;
    }

    private writeSingleQuoted(value: Uint8Array): void {
        this.writeIndicator("'", true, false, false);
        let breaks = false;
        for (let i = 0; i < value.length; ) {
            if (isSpace(value, i)) {
                i = this.write(value, i);
            } else if (isBreak(value, i)) {
                if (!breaks && value[i] === 0x0a) this.putBreak();
                i = this.writeBreak(value, i);
                breaks = true;
            } else {
                if (breaks) this.writeIndent();
                if (value[i] === 0x27) this.put(0x27);
                i = this.write(value, i);
                this.indention = false;
                breaks = false;
            }
        }
        this.writeIndicator("'", false, false, false);
        this.whitespace = false;
        this.indention = false;
    }

    private writeDoubleQuoted(value: Uint8Array): void {
        this.writeIndicator('"', true, false, false);
        for (let i = 0; i < value.length; ) {
            const octet = value[i] as number;
            if (
                !isPrintable(value, i) ||
                isBom(value) ||
                isBreak(value, i) ||
                octet === 0x22 ||
                octet === 0x5c
            ) {
                const w = width(octet);
                let v =
                    w === 1
                        ? octet & 0x7f
                        : w === 2
                          ? octet & 0x1f
                          : w === 3
                            ? octet & 0x0f
                            : octet & 0x07;
                for (let k = 1; k < w; k++) {
                    v = (v << 6) + ((value[i + k] as number) & 0x3f);
                }
                i += w;
                this.put(0x5c);
                const esc = ESCAPES.get(v);
                if (esc !== undefined) {
                    this.put(esc.charCodeAt(0));
                    continue;
                }
                let digits: number;
                if (v <= 0xff) {
                    this.put(0x78); // 'x'
                    digits = 2;
                } else if (v <= 0xffff) {
                    this.put(0x75); // 'u'
                    digits = 4;
                } else {
                    this.put(0x55); // 'U'
                    digits = 8;
                }
                for (let k = (digits - 1) * 4; k >= 0; k -= 4) {
                    this.put(hexDigit((v >> k) & 0x0f));
                }
            } else {
                i = this.write(value, i);
            }
        }
        this.writeIndicator('"', false, false, false);
        this.whitespace = false;
        this.indention = false;
    }

    private writeBlockScalarHints(value: Uint8Array): void {
        if (isSpace(value, 0) || isBreak(value, 0)) {
            this.writeIndicator(String(this.bestIndent), false, false, false);
        }
        let chomp = "";
        if (value.length === 0) {
            chomp = "-";
        } else {
            let i = value.length - 1;
            while (((value[i] as number) & 0xc0) === 0x80) i--;
            if (!isBreak(value, i)) {
                chomp = "-";
            } else if (i === 0) {
                chomp = "+";
            } else {
                i--;
                while (((value[i] as number) & 0xc0) === 0x80) i--;
                if (isBreak(value, i)) {
                    chomp = "+";
                }
            }
        }
        if (chomp !== "") this.writeIndicator(chomp, false, false, false);
    }

    private writeLiteral(value: Uint8Array): void {
        this.writeIndicator("|", true, false, false);
        this.writeBlockScalarHints(value);
        this.whitespace = true;
        let breaks = true;
        for (let i = 0; i < value.length; ) {
            if (isBreak(value, i)) {
                i = this.writeBreak(value, i);
                breaks = true;
            } else {
                if (breaks) this.writeIndent();
                i = this.write(value, i);
                this.indention = false;
                breaks = false;
            }
        }
    }

    private writeFolded(value: Uint8Array): void {
        this.writeIndicator(">", true, false, false);
        this.writeBlockScalarHints(value);
        this.whitespace = true;
        let breaks = true;
        let leadingSpaces = true;
        for (let i = 0; i < value.length; ) {
            if (isBreak(value, i)) {
                if (!breaks && !leadingSpaces && value[i] === 0x0a) {
                    // libyaml scans from the start of the value here, not
                    // from i; kept as is.
                    let k = 0;
                    while (isBreak(value, k)) k += width(value[k] as number);
                    if (!isBlankz(value, k)) this.putBreak();
                }
                i = this.writeBreak(value, i);
                breaks = true;
            } else {
                if (breaks) {
                    this.writeIndent();
                    leadingSpaces = isBlank(value, i);
                }
                i = this.write(value, i);
                this.indention = false;
                breaks = false;
            }
        }
    }

    // --- Output ----------------------------------------------------------

    private put(byte: number): void {
        this.out.push(byte);
        this.column++;
    }

    private putBreak(): void {
        this.out.push(0x0a);
        this.column = 0;
        this.indention = true;
    }

    /** write copies the character at i and returns the next index. */
    private write(b: Uint8Array, i: number): number {
        const w = width(b[i] as number);
        for (let k = 0; k < w; k++) this.out.push(b[i + k] as number);
        this.column++;
        return i + w;
    }

    private writeRaw(b: Uint8Array): void {
        for (let i = 0; i < b.length; ) i = this.write(b, i);
    }

    /** writeBreak copies the line break at i and returns the next index. */
    private writeBreak(b: Uint8Array, i: number): number {
        if (b[i] === 0x0a) {
            this.putBreak();
            return i + 1;
        }
        const next = this.write(b, i);
        this.column = 0;
        this.indention = true;
        return next;
    }
}

/** analyzeScalar is yaml_emitter_analyze_scalar (Unicode output). */
function analyzeScalar(value: Uint8Array): Analysis {
    if (value.length === 0) {
        return {
            multiline: false,
            flowPlainAllowed: false,
            blockPlainAllowed: true,
            singleQuotedAllowed: true,
            blockAllowed: false,
        };
    }
    let blockIndicators = false;
    let flowIndicators = false;
    let lineBreaks = false;
    let specialCharacters = false;
    let tabCharacters = false;
    let leadingSpace = false;
    let leadingBreak = false;
    let trailingSpace = false;
    let trailingBreak = false;
    let breakSpace = false;
    let spaceBreak = false;
    let previousSpace = false;
    let previousBreak = false;

    const startsWith3 = (c: number): boolean =>
        value.length >= 3 && value[0] === c && value[1] === c && value[2] === c;
    if (startsWith3(0x2d) || startsWith3(0x2e)) {
        blockIndicators = true;
        flowIndicators = true;
    }

    let precededByWhitespace = true;
    for (let i = 0, w = 0; i < value.length; i += w) {
        const c = value[i] as number;
        w = width(c);
        const followedByWhitespace =
            i + w >= value.length || isBlank(value, i + w);
        const ch = String.fromCharCode(c);
        if (i === 0) {
            if (FIRST_INDICATORS.includes(ch)) {
                flowIndicators = true;
                blockIndicators = true;
            } else if (ch === "?" || ch === ":") {
                flowIndicators = true;
                if (followedByWhitespace) blockIndicators = true;
            } else if (ch === "-" && followedByWhitespace) {
                flowIndicators = true;
                blockIndicators = true;
            }
        } else if (",?[]{}".includes(ch)) {
            flowIndicators = true;
        } else if (ch === ":") {
            flowIndicators = true;
            if (followedByWhitespace) blockIndicators = true;
        } else if (ch === "#" && precededByWhitespace) {
            flowIndicators = true;
            blockIndicators = true;
        }

        if (c === 0x09) tabCharacters = true;
        else if (!isPrintable(value, i)) specialCharacters = true;

        if (isSpace(value, i)) {
            if (i === 0) leadingSpace = true;
            if (i + w === value.length) trailingSpace = true;
            if (previousBreak) breakSpace = true;
            previousSpace = true;
            previousBreak = false;
        } else if (isBreak(value, i)) {
            lineBreaks = true;
            if (i === 0) leadingBreak = true;
            if (i + w === value.length) trailingBreak = true;
            if (previousSpace) spaceBreak = true;
            previousSpace = false;
            previousBreak = true;
        } else {
            previousSpace = false;
            previousBreak = false;
        }
        precededByWhitespace = isBlankz(value, i);
    }

    const out: Analysis = {
        multiline: lineBreaks,
        flowPlainAllowed: true,
        blockPlainAllowed: true,
        singleQuotedAllowed: true,
        blockAllowed: true,
    };
    if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) {
        out.flowPlainAllowed = false;
        out.blockPlainAllowed = false;
    }
    if (trailingSpace) out.blockAllowed = false;
    if (breakSpace || spaceBreak || tabCharacters || specialCharacters) {
        out.flowPlainAllowed = false;
        out.blockPlainAllowed = false;
        out.singleQuotedAllowed = false;
    }
    if (spaceBreak || specialCharacters) out.blockAllowed = false;
    if (lineBreaks) {
        out.flowPlainAllowed = false;
        out.blockPlainAllowed = false;
    }
    if (flowIndicators) out.flowPlainAllowed = false;
    if (blockIndicators) out.blockPlainAllowed = false;
    return out;
}

/** FIRST_INDICATORS make a plain scalar impossible as the first byte. */
const FIRST_INDICATORS = "#,[]{}&*!|>'\"%@`";

/** TAG_SAFE are the bytes a tag is written with unescaped, besides alpha. */
const TAG_SAFE: ReadonlySet<number> = new Set(
    Array.from(";/?:@&=+$,_.~*'()[]", (c) => c.charCodeAt(0)),
);

/** ESCAPES are the double-quoted short escapes by code point. */
const ESCAPES: ReadonlyMap<number, string> = new Map([
    [0x00, "0"],
    [0x07, "a"],
    [0x08, "b"],
    [0x09, "t"],
    [0x0a, "n"],
    [0x0b, "v"],
    [0x0c, "f"],
    [0x0d, "r"],
    [0x1b, "e"],
    [0x22, '"'],
    [0x5c, "\\"],
    [0x85, "N"],
    [0xa0, "_"],
    [0x2028, "L"],
    [0x2029, "P"],
]);

function hexDigit(d: number): number {
    return d < 10 ? d + 0x30 : d + 0x41 - 10;
}

function byteLength(s: string): number {
    return utf8Encode(s).length;
}

// Byte classes of yamlprivateh.go; a read past the end is 0.

function at(b: Uint8Array, i: number): number {
    return b[i] ?? 0;
}

function width(c: number): number {
    if ((c & 0x80) === 0x00) return 1;
    if ((c & 0xe0) === 0xc0) return 2;
    if ((c & 0xf0) === 0xe0) return 3;
    if ((c & 0xf8) === 0xf0) return 4;
    return 0;
}

function isAlpha(b: Uint8Array, i: number): boolean {
    const c = at(b, i);
    return (
        (c >= 0x30 && c <= 0x39) ||
        (c >= 0x41 && c <= 0x5a) ||
        (c >= 0x61 && c <= 0x7a) ||
        c === 0x5f ||
        c === 0x2d
    );
}

function isPrintable(b: Uint8Array, i: number): boolean {
    const c = at(b, i);
    const c1 = at(b, i + 1);
    const c2 = at(b, i + 2);
    return (
        c === 0x0a ||
        (c >= 0x20 && c <= 0x7e) ||
        (c === 0xc2 && c1 >= 0xa0) ||
        (c > 0xc2 && c < 0xed) ||
        (c === 0xed && c1 < 0xa0) ||
        c === 0xee ||
        (c === 0xef &&
            !(c1 === 0xbb && c2 === 0xbf) &&
            !(c1 === 0xbf && (c2 === 0xbe || c2 === 0xbf)))
    );
}

/** isBom checks the start of b whatever the index, as libyaml does. */
function isBom(b: Uint8Array): boolean {
    return at(b, 0) === 0xef && at(b, 1) === 0xbb && at(b, 2) === 0xbf;
}

function isSpace(b: Uint8Array, i: number): boolean {
    return at(b, i) === 0x20;
}

function isBlank(b: Uint8Array, i: number): boolean {
    const c = at(b, i);
    return c === 0x20 || c === 0x09;
}

function isBreak(b: Uint8Array, i: number): boolean {
    const c = at(b, i);
    const c1 = at(b, i + 1);
    const c2 = at(b, i + 2);
    return (
        c === 0x0d ||
        c === 0x0a ||
        (c === 0xc2 && c1 === 0x85) ||
        (c === 0xe2 && c1 === 0x80 && (c2 === 0xa8 || c2 === 0xa9))
    );
}

function isBlankz(b: Uint8Array, i: number): boolean {
    return isBlank(b, i) || isBreak(b, i) || at(b, i) === 0;
}
