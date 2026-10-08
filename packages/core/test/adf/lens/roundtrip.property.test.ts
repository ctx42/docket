// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The lens round-trip property on arbitrary documents: render a generated ADF
// document to Markdown and push the unedited body back. The push must yield the
// original document — less only the deliberate heal of a frozen-macro code
// block — or refuse with a `push:` error; never a different document. It runs twice: as an ordinary push (only edited blocks are touched)
// and under force, which re-parses every editable block from its Markdown and
// so exercises render → parse → reconstruct for each of them.
//
// A forced re-parse is held to equality up to the two things the Markdown does
// not carry and Confluence does not display differently: the order of a text
// node's marks (real pages store no canonical order), and whitespace layout —
// runs of whitespace, whitespace at a leaf's edges or beside a hard break, and
// the marks on whitespace. Everything else, attributes included, must match.
//
// The case count and first seed come from DOCKET_LENS_RUNS and DOCKET_LENS_SEED,
// so a deeper soak is `DOCKET_LENS_RUNS=20000 bunx vitest run <this file>` and
// a failure is replayed with the seed its message names and DOCKET_LENS_RUNS=1.

import { describe, expect, it } from "vitest";
import { healAdfCodeBlock } from "../../../src/adf/lens/build.ts";
import { putLinks } from "../../../src/adf/lens/reconstruct.ts";
import { marshallMarkdownMapped } from "../../../src/index.ts";
import { type ADF, type Node, newADF } from "../../../src/models/adf.ts";
import { genDoc } from "../../support/adfgen.ts";

/** envInt reads a non-negative integer environment variable, or def. */
function envInt(name: string, def: number): number {
    const v = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isNaN(v) || v < 0 ? def : v;
}

const RUNS = envInt("DOCKET_LENS_RUNS", 300);
const SEED = envInt("DOCKET_LENS_SEED", 0);
/** TIMEOUT scales the per-mode time budget with the case count. */
const TIMEOUT = Math.max(5_000, RUNS * 5);

/** renderBody renders adf and returns its body without frontmatter. */
function renderBody(adf: ADF): string {
    const [md, sm] = marshallMarkdownMapped(adf, {});
    return md.slice(sm.bodyStart).replace(/\n$/, "");
}

/**
 * mentionsOf builds the name → account-id map a pull writes to frontmatter, so
 * a re-parsed mention resolves back to its account.
 */
function mentionsOf(node: Node, out: Record<string, string> = {}) {
    if (node.type === "mention") {
        const name = String(node.attrs?.["text"] ?? "").replace(/^@/, "");
        out[name] = String(node.attrs?.["id"] ?? "");
    }
    for (const kid of node.content ?? []) {
        mentionsOf(kid, out);
    }
    return out;
}

/** sorted returns a JSON string of v with object keys in sorted order. */
function sorted(v: unknown): string {
    return JSON.stringify(v, (_, x: unknown) =>
        x !== null && typeof x === "object" && !Array.isArray(x)
            ? Object.fromEntries(
                  Object.entries(x as Record<string, unknown>).sort(),
              )
            : x,
    );
}

/**
 * inlineTokens flattens a leaf's inline content into one token per
 * non-whitespace character (with its sorted mark set), one per non-text inline
 * node, `br` per hard break and `_` per whitespace run, then drops the
 * whitespace at the edges and beside each hard break.
 */
function inlineTokens(content: Node[]): string[] {
    const out: string[] = [];
    for (const n of content) {
        if (n.type === "hardBreak") {
            out.push("br");
        } else if (n.type !== "text") {
            out.push(`node:${sorted(n)}`);
        } else {
            const marks = (n.marks ?? []).map(sorted).sort().join(",");
            for (const ch of n.text ?? "") {
                if (/\s/.test(ch)) {
                    if (out[out.length - 1] !== "_") out.push("_");
                } else {
                    out.push(`${ch}|${marks}`);
                }
            }
        }
    }
    return out.filter(
        (t, i) =>
            t !== "_" ||
            (i > 0 &&
                i < out.length - 1 &&
                out[i - 1] !== "br" &&
                out[i + 1] !== "br"),
    );
}

/**
 * canon maps a node to its comparison form: inline content becomes its
 * {@link inlineTokens}; everything else, code blocks included, is kept as is.
 */
function canon(node: Node): unknown {
    const kids = node.content;
    if (
        node.type !== "codeBlock" &&
        kids?.some((k) => k.type === "text" || k.type === "hardBreak")
    ) {
        return { ...node, content: inlineTokens(kids) };
    }
    return kids === undefined ? node : { ...node, content: kids.map(canon) };
}

/**
 * healed is the document a push of doc may return: doc with each top-level
 * frozen-macro code block upgraded to its live macro, the one change a push
 * makes on purpose (see {@link healAdfCodeBlock}).
 */
function healed(doc: Node): Node {
    return {
        ...doc,
        content: (doc.content ?? []).map((n) => healAdfCodeBlock(n) ?? n),
    };
}

/** Outcome is how one generated document fared. */
type Outcome = "same" | "refused";

/**
 * check pushes the unedited render of the document generated from seed and
 * returns its outcome, failing the test on a changed document or a non-refusal
 * throw.
 */
function check(seed: number, force: boolean): Outcome {
    const adf = newADF(JSON.stringify({ adf: genDoc(seed) }));
    const body = renderBody(adf);
    const replay =
        `seed ${seed}: replay with DOCKET_LENS_SEED=${seed} ` +
        `DOCKET_LENS_RUNS=1\n--- body ---\n${body}\n---`;
    let out: ADF;
    try {
        out = putLinks(adf, body, mentionsOf(adf.doc), {}, null, null, force);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg.startsWith("push: "), `${replay}\n${msg}`).toBe(true);
        return "refused";
    }
    const want = healed(adf.doc);
    if (force) {
        expect(canon(out.doc), replay).toEqual(canon(want));
    } else {
        expect(out.doc, replay).toEqual(want);
    }
    return "same";
}

describe("lens round trip on generated documents", () => {
    // A lens that refused every push would satisfy the property vacuously, so
    // each mode also holds a floor on how many documents it accepts.
    const modes: Array<{ name: string; force: boolean; floor: number }> = [
        { name: "an unedited push", force: false, floor: 0.95 },
        { name: "a forced re-parse", force: true, floor: 0.5 },
    ];

    for (const mode of modes) {
        it(
            `${mode.name} returns the document or refuses`,
            () => {
                let same = 0;
                for (let seed = SEED; seed < SEED + RUNS; seed++) {
                    if (check(seed, mode.force) === "same") same++;
                }

                expect(same).toBeGreaterThanOrEqual(
                    Math.floor(RUNS * mode.floor),
                );
            },
            TIMEOUT,
        );
    }
});
