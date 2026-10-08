// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The gaps differential check: each script of the oracle's `gapops` golden
// runs against the TS FileStore on an in-memory folder, and every result,
// error, and file byte must equal what the Go FileStore produced.

import { describe, expect, it } from "vitest";

import { FileStore, TidyError } from "../../src/gaps/file-store.ts";
import {
    EC_INVALID,
    emptyGap,
    type Filter,
    type Gap,
    gapError,
    hash,
    type Patch,
    type ResolvedRef,
    type Resolver,
    ZERO_TIME,
} from "../../src/gaps/gaps.ts";
import { goQuote } from "../../src/gocompat/strconv.ts";
import { parseTime } from "../../src/gocompat/time.ts";
import { readGolden } from "../support/golden.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";
import { DIR, TEST_EPOCH } from "./fixtures.ts";

interface Step {
    op: string;
    id?: string;
    gap?: Record<string, unknown>;
    patch?: Record<string, unknown>;
    refs?: string[];
    complete?: boolean;
    remaining?: string;
    reason?: string;
    filter?: Record<string, unknown>;
}

interface Script {
    name: string;
    files: Record<string, string>;
    refs?: Record<string, string>;
    hashes?: Record<string, string>;
    no_resolver?: boolean;
    ops: Step[];
}

interface Row {
    name: string;
    results: Record<string, unknown>[];
    files: Record<string, string | null>;
}

/** ScriptResolver is the oracle's map resolver. */
class ScriptResolver implements Resolver {
    constructor(
        readonly refs: Readonly<Record<string, string>>,
        readonly hashes: Readonly<Record<string, string>>,
    ) {}

    private hashOf(norm: string): string {
        const h = this.hashes[norm];
        if (h === undefined) return hash(norm);
        if (h === "") throw gapError(EC_INVALID, `${goQuote(norm)} vanished`);
        return h;
    }

    private normOf(ref: string): string {
        const norm = this.refs[ref];
        if (norm === undefined)
            throw gapError(EC_INVALID, `unknown reference ${goQuote(ref)}`);
        return norm;
    }

    async resolve(ref: string): Promise<ResolvedRef> {
        const norm = this.normOf(ref);
        return { norm, hash: this.hashOf(norm) };
    }

    async resolveFill(ref: string): Promise<ResolvedRef> {
        const res = await this.resolve(ref);
        if (res.norm.startsWith("initiatives/")) {
            const why = `${goQuote(ref)} is under the initiatives folder`;
            throw gapError(EC_INVALID, why);
        }
        return res;
    }

    async current(ref: string): Promise<string> {
        return this.hashOf(this.normOf(ref));
    }
}

/** toGap converts the oracle's Go-JSON gap. */
function toGap(raw: Record<string, unknown>): Gap {
    const str = (k: string) => (raw[k] as string | undefined) ?? "";
    const list = (k: string) => (raw[k] as string[] | null | undefined) ?? [];
    const created = raw["created"] as string | undefined;
    return {
        ...emptyGap(),
        id: str("id"),
        status: str("status"),
        kind: str("kind"),
        answer: str("answer"),
        ask: list("ask"),
        asked: str("asked"),
        srdRef: str("srd_ref"),
        docID: str("doc_id"),
        headingPath: list("heading_path"),
        searchTerms: list("search_terms"),
        hits: (raw["hits"] as number | undefined) ?? 0,
        created:
            created === undefined ? ZERO_TIME : parseTime("RFC3339", created),
        filledBy: (
            (raw["filled_by"] as { ref: string; hash?: string }[] | null) ?? []
        ).map((f) => ({ ref: f.ref, hash: f.hash ?? "" })),
        topic: str("topic"),
        demand: str("demand"),
        detail: str("detail"),
        targetClaim: str("target_claim"),
    };
}

/** toPatch converts the oracle's patch. */
function toPatch(raw: Record<string, unknown> = {}): Patch {
    const keys: [string, keyof Patch][] = [
        ["kind", "kind"],
        ["answer", "answer"],
        ["ask", "ask"],
        ["asked", "asked"],
        ["srd_ref", "srdRef"],
        ["doc_id", "docID"],
        ["heading_path", "headingPath"],
        ["search_terms", "searchTerms"],
        ["topic", "topic"],
        ["demand", "demand"],
        ["detail", "detail"],
        ["target_claim", "targetClaim"],
    ];
    const out: Record<string, unknown> = {};
    for (const [from, to] of keys) {
        if (raw[from] !== undefined && raw[from] !== null) out[to] = raw[from];
    }
    if (raw["add_hit"] === true) out["addHit"] = true;
    return out as Patch;
}

/** toFilter converts the oracle's filter. */
function toFilter(raw: Record<string, unknown> = {}): Filter {
    const out: Filter = {};
    if (raw["status"]) out.status = raw["status"] as string;
    if (raw["srd_ref"]) out.srdRef = raw["srd_ref"] as string;
    if (raw["query"]) out.query = raw["query"] as string;
    if (raw["stale"]) out.stale = true;
    if (raw["ask"]) out.ask = raw["ask"] as string;
    if (typeof raw["asked"] === "boolean") out.asked = raw["asked"];
    return out;
}

/** goMoves formats moves as Go's %v of [][2]string. */
function goMoves(moves: { from: string; to: string }[]): string {
    return `[${moves.map((m) => `[${m.from} ${m.to}]`).join(" ")}]`;
}

/** runOp runs one step as the oracle does, returning its JSON result. */
async function runOp(fst: FileStore, step: Step): Promise<unknown> {
    const id = step.id ?? "";
    switch (step.op) {
        case "report":
            return fst.append(toGap(step.gap ?? {}));
        case "draft":
            return fst.appendDraft(toGap(step.gap ?? {}));
        case "import":
            return (await fst.import(toGap(step.gap ?? {}))).file;
        case "update":
            await fst.update(id, toPatch(step.patch));
            return null;
        case "add_hit":
            await fst.update(id, { addHit: true });
            return null;
        case "submit":
            await fst.submit(id);
            return null;
        case "discard":
            await fst.discard(id);
            return null;
        case "fill":
            await fst.fill(id, {
                refs: step.refs ?? [],
                complete: step.complete ?? false,
                ...(step.remaining === undefined
                    ? {}
                    : { remaining: step.remaining }),
            });
            return null;
        case "reopen":
            await fst.reopen(id, step.reason ?? "");
            return null;
        case "wontfix":
            await fst.wontfix(id, step.reason ?? "");
            return null;
        case "tidy":
            try {
                return (await fst.tidy()).map((m) => [m.from, m.to]);
            } catch (err) {
                if (!(err instanceof TidyError)) throw err;
                throw new Error(`${err.message} (moves ${goMoves(err.moves)})`);
            }
        case "reindex":
            return fst.reindex();
        case "bad_files":
            return fst.badFiles();
        case "list":
            return (await fst.list(toFilter(step.filter))).map((gap) => ({
                id: gap.id,
                status: gap.status,
                file: gap.file,
                hits: gap.hits,
                score: gap.score,
                stale: gap.stale,
                stale_refs: gap.staleRefs,
                filled_by: gap.filledBy.map((f) =>
                    f.hash === "" ? { ref: f.ref } : f,
                ),
                topic: gap.topic,
                ask: gap.ask,
                asked: gap.asked,
            }));
    }
    throw new Error(`unknown op ${step.op}`);
}

/** run replays script on an in-memory folder. */
async function run(script: Script): Promise<Row> {
    const mfs = new MemDocFs().mkdirp(DIR);
    for (const [name, src] of Object.entries(script.files)) {
        mfs.writeFile(`${DIR}/${name}`, src);
    }
    const res = script.no_resolver
        ? undefined
        : new ScriptResolver(script.refs ?? {}, script.hashes ?? {});
    const fst = new FileStore(mfs, DIR, () => TEST_EPOCH, res);
    const results: Record<string, unknown>[] = [];
    for (const step of script.ops) {
        try {
            results.push({ op: step.op, ok: await runOp(fst, step) });
        } catch (err) {
            const msg = (err as Error).message.replaceAll(DIR, "<dir>");
            results.push({ op: step.op, err: msg });
        }
    }
    const files: Record<string, string | null> = {};
    for (const path of mfs.paths()) {
        if (!path.startsWith(`${DIR}/`)) continue;
        const rel = path.slice(DIR.length + 1);
        try {
            files[rel] = mfs.readFile(path);
        } catch {
            files[`${rel}/`] = null;
        }
    }
    return { name: script.name, results, files };
}

const scripts = readGolden<Script[]>(
    new URL("testdata/gapops.cases.json", import.meta.url),
);
const golden = readGolden<Row[]>(
    new URL("testdata/gapops.golden.json", import.meta.url),
);

describe("gapops differential", () => {
    it("holds at least ten scripts", () => {
        expect(scripts.length).toBeGreaterThanOrEqual(10);
        expect(golden.map((r) => r.name)).toEqual(scripts.map((s) => s.name));
    });

    it.each(scripts.map((s, i) => [s.name, s, golden[i] as Row] as const))(
        "%s matches the Go FileStore",
        async (_name, script, want) => {
            // --- When ---
            const have = await run(script);

            // --- Then ---
            expect(JSON.parse(JSON.stringify(have.results))).toEqual(
                want.results,
            );
            expect(have.files).toEqual(want.files);
        },
    );
});
