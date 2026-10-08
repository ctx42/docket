// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The MCP server exposing the retrieval engine to agents, answering exactly
// as the Go server's go-sdk server does: tools/list from the frozen tool
// definitions, filtered by what the server holds; tool arguments validated
// with jsonschema-go's texts; a tool's output returned as structured content
// plus a text block holding it as Go's `json.Marshal` of a map writes it
// (sorted keys, HTML escaped); a failing tool as an error result whose text
// is the error, or "internal error" for an unexpected one.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    type CallToolResult,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { type Engine, isDocNotFound } from "../engine/engine.ts";
import {
    type BadFile,
    EC_BAD_FILE,
    EC_INVALID,
    EC_NOT_FOUND,
    EC_STATUS,
    emptyGap,
    type Fill,
    type Filter,
    type Gap,
    isGapError,
    type Patch,
} from "../gaps/gaps.ts";
import type { Glossary } from "../glossary/glossary.ts";
import { encodeJSON, type GoJSON } from "../gocompat/json.ts";
import { goQuote } from "../gocompat/strconv.ts";
import { trimSpace } from "../gocompat/strings.ts";
import { formatRFC3339Nano } from "../gocompat/time.ts";
import { utf8Decode, utf8Encode } from "../gocompat/utf8.ts";
import { MAX_K } from "../search/retrieval.ts";
import { CanceledError, type Signal } from "../util/cancel.ts";
import { validateArgs } from "./schema.ts";
import { TOOL_DEFS, type ToolDef } from "./tool-defs.ts";

/** SERVER_NAME is the MCP implementation name reported to clients. */
export const SERVER_NAME = "docket";

/** The tools registered only with a glossary, and only with a gap store. */
const GLOSSARY_TOOLS: ReadonlySet<string> = new Set(["glossary_terms"]);
const GAP_TOOLS: ReadonlySet<string> = new Set([
    "report_gap",
    "list_gaps",
    "update_gap",
    "submit_gap",
    "discard_gap",
    "fill_gap",
    "reopen_gap",
    "wontfix_gap",
]);

/**
 * GapStore is the gap store the gap tools record to ({@link FileStore}
 * satisfies it).
 */
export interface GapStore {
    append(gap: Gap, signal?: Signal): Promise<string>;
    appendDraft(gap: Gap, signal?: Signal): Promise<string>;
    update(id: string, pch: Patch, signal?: Signal): Promise<void>;
    submit(id: string, signal?: Signal): Promise<void>;
    discard(id: string, signal?: Signal): Promise<void>;
    fill(id: string, fll: Fill, signal?: Signal): Promise<void>;
    reopen(id: string, reason: string, signal?: Signal): Promise<void>;
    wontfix(id: string, reason: string, signal?: Signal): Promise<void>;
    list(filter: Filter, signal?: Signal): Promise<Gap[]>;
    badFiles(signal?: Signal): Promise<BadFile[]>;
}

/** ToolDeps are what the tools serve from; absent ones drop their tools. */
export interface ToolDeps {
    engine: Engine;
    /** version is the server version reported to clients. */
    version: string;
    store?: GapStore;
    glossary?: Glossary;
    /** logErr receives an unexpected tool failure; clients see none. */
    logErr?: (err: unknown) => void;
}

/** Args are a tool call's decoded arguments. */
type Args = Readonly<Record<string, unknown>>;

/** Handler runs one tool, returning its output as a Go-JSON object. */
type Handler = (
    args: Args,
    signal: Signal | undefined,
) => Promise<{ [key: string]: GoJSON | undefined }>;

/** ToolError is a tool failure the client sees as the result text. */
export class ToolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ToolError";
    }
}

/** RPCError is a JSON-RPC error answer; the SDK sends code and message. */
export class RPCError extends Error {
    constructor(
        readonly code: number,
        message: string,
    ) {
        super(message);
        this.name = "RPCError";
    }
}

/** INVALID_PARAMS is the JSON-RPC code of an unknown tool. */
const INVALID_PARAMS = -32602;

/**
 * Tools answers tools/list and tools/call for one server; it shares the
 * engine, store and glossary with every other server instance.
 */
export class Tools {
    readonly defs: readonly ToolDef[];
    private readonly handlers = new Map<string, Handler>();
    private readonly logErr: (err: unknown) => void;

    constructor(readonly deps: ToolDeps) {
        this.logErr = deps.logErr ?? (() => {});
        this.defs = TOOL_DEFS.filter(
            (def) =>
                (!GLOSSARY_TOOLS.has(def.name) ||
                    deps.glossary !== undefined) &&
                (!GAP_TOOLS.has(def.name) || deps.store !== undefined),
        );
        this.handlers.set("search", (a) => this.search(a));
        this.handlers.set("get_doc", (a) => this.getDoc(a));
        this.handlers.set("list_docs", async () => this.listDocs());
        if (deps.glossary !== undefined) {
            const gls = deps.glossary;
            this.handlers.set("glossary_terms", async (a) => ({
                terms: (await gls.terms(str(a, "term"))).map((t) => ({
                    term: t.term,
                    name: t.name,
                    abbreviation: t.abbreviation,
                    id: t.id,
                    path: t.path,
                    anchor: t.anchor,
                    definition: t.definition,
                })),
            }));
        }
        if (deps.store !== undefined) this.gapTools(deps.store);
    }

    /** gapTools registers the gap write tools over store. */
    private gapTools(store: GapStore): void {
        const ok = async (done: Promise<void>) => {
            await done;
            return { ok: true };
        };
        this.handlers.set("report_gap", async (a, sig) => {
            const gap = reportGap(a);
            const id = await (a["draft"] === true
                ? store.appendDraft(gap, sig)
                : store.append(gap, sig));
            return { gap_id: id };
        });
        this.handlers.set("list_gaps", async (a, sig) => {
            const flt: Filter = {
                status: str(a, "status"),
                srdRef: str(a, "srd_ref"),
                query: str(a, "query"),
                stale: a["stale"] === true,
                ask: str(a, "ask"),
            };
            if (typeof a["asked"] === "boolean") flt.asked = a["asked"];
            const list = await store.list(flt, sig);
            const bad = await store.badFiles(sig);
            return {
                gaps: list.map(gapJSON),
                invalid: bad.map((b) => ({ file: b.file, reason: b.reason })),
            };
        });
        this.handlers.set("update_gap", (a, sig) =>
            ok(store.update(str(a, "gap_id"), updatePatch(a), sig)),
        );
        this.handlers.set("submit_gap", (a, sig) =>
            ok(store.submit(str(a, "gap_id"), sig)),
        );
        this.handlers.set("discard_gap", (a, sig) =>
            ok(store.discard(str(a, "gap_id"), sig)),
        );
        this.handlers.set("fill_gap", (a, sig) => {
            const fll: Fill = {
                refs: (a["filled_by"] as string[] | null | undefined) ?? [],
                complete: a["complete"] === true,
            };
            const remaining = a["remaining"];
            if (typeof remaining === "string") fll.remaining = remaining;
            return ok(store.fill(str(a, "gap_id"), fll, sig));
        });
        this.handlers.set("reopen_gap", (a, sig) =>
            ok(store.reopen(str(a, "gap_id"), str(a, "reason"), sig)),
        );
        this.handlers.set("wontfix_gap", (a, sig) =>
            ok(store.wontfix(str(a, "gap_id"), str(a, "reason"), sig)),
        );
    }

    /** call runs tool name with args as go-sdk's typed tool wrapper does. */
    async call(
        name: string,
        args: Args | undefined,
        signal?: Signal,
    ): Promise<CallToolResult> {
        const def = this.defs.find((d) => d.name === name);
        const handler = this.handlers.get(name);
        if (def === undefined || handler === undefined) {
            throw new RPCError(INVALID_PARAMS, `unknown tool ${goQuote(name)}`);
        }
        const invalid = validateArgs(args, def.inputSchema);
        if (invalid !== undefined) return errorResult(invalid);
        const overflow = intOverflow(name, args ?? {});
        if (overflow !== undefined) return errorResult(overflow);
        let out: { [key: string]: GoJSON | undefined };
        try {
            out = await handler(args ?? {}, signal);
        } catch (err) {
            return errorResult(clientError(this.logErr, err).message);
        }
        const text = encodeJSON(sortKeys(out) as GoJSON);
        return {
            content: [{ type: "text", text }],
            structuredContent: JSON.parse(text) as Record<string, unknown>,
        };
    }

    private async search(a: Args) {
        const query = str(a, "query");
        if (trimSpace(query) === "") throw new ToolError("query is required");
        const k = (a["k"] as number | undefined) ?? 0;
        if (k < 0 || k > MAX_K)
            throw new ToolError(`k must be between 1 and ${MAX_K}`);
        const hits = await this.deps.engine.search({ text: query, k });
        return {
            results: hits.map((hit) => ({
                title: hit.title,
                id: hit.docID,
                path: hit.docPath,
                rank: omitZero(hit.rank),
                heading_path:
                    hit.headingPath.length > 0 ? hit.headingPath : undefined,
                text: hit.text,
                score: hit.score,
                source_url: omitEmpty(hit.sourceURL),
            })),
        };
    }

    private async getDoc(a: Args) {
        const doc = await this.deps.engine.getDoc(str(a, "id"));
        return {
            id: doc.id,
            path: doc.path,
            rank: omitZero(doc.rank),
            title: doc.title,
            source_url: omitEmpty(doc.sourceURL),
            text: doc.text,
        };
    }

    private listDocs() {
        return {
            docs: this.deps.engine.listDocs().map((doc) => ({
                id: doc.id,
                path: doc.path,
                rank: omitZero(doc.rank),
                title: doc.title,
            })),
        };
    }
}

/**
 * newMcpServer returns an MCP server answering tools/list and tools/call
 * with tools over deps, reporting {@link SERVER_NAME} and deps.version.
 */
export function newMcpServer(deps: ToolDeps): Server {
    const tools = new Tools(deps);
    const srv = new Server(
        { name: SERVER_NAME, version: deps.version },
        { capabilities: { logging: {}, tools: { listChanged: true } } },
    );
    srv.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: tools.defs.map((d) => ({ ...d })),
    }));
    srv.setRequestHandler(CallToolRequestSchema, (req, extra) =>
        tools.call(req.params.name, req.params.arguments, extra.signal),
    );
    return srv;
}

/**
 * clientError returns err when the client can act on it: an unknown
 * document or gap, invalid input, a status conflict, an invalid gap file,
 * or a canceled call. Any other error goes to logErr and the client gets
 * "internal error", keeping server paths from it.
 */
export function clientError(
    logErr: (err: unknown) => void,
    err: unknown,
): Error {
    if (
        err instanceof ToolError ||
        err instanceof CanceledError ||
        isDocNotFound(err) ||
        isGapError(err, EC_NOT_FOUND) ||
        isGapError(err, EC_INVALID) ||
        isGapError(err, EC_STATUS) ||
        isGapError(err, EC_BAD_FILE)
    ) {
        return err as Error;
    }
    logErr(err);
    return new Error("internal error");
}

/** errorResult is go-sdk's error result: the text, isError set. */
export function errorResult(text: string): CallToolResult {
    return { content: [{ type: "text", text }], isError: true };
}

/**
 * INT_FIELDS names each tool's integer arguments and the Go struct they
 * decode into, for the decoder's errors.
 */
const INT_FIELDS: Readonly<Record<string, [string, string]>> = {
    search: ["mcpserver.searchInput", "k"],
};

/**
 * intOverflow returns the error go-sdk's JSON decoder (segmentio) gives for
 * an integer argument that passed the schema but does not fit Go's int: it
 * decodes the arguments as Go re-marshalled them (sorted keys, Go number
 * spelling), so an exponent spelling is refused as a quoted string and an
 * out-of-range literal quotes the next 32 bytes of that JSON.
 */
function intOverflow(name: string, args: Args): string | undefined {
    const field = INT_FIELDS[name];
    if (field === undefined) return undefined;
    const [struct, key] = field;
    const v = args[key];
    if (typeof v !== "number") return undefined;
    const text = encodeJSON(v);
    const into = `into Go struct field ${struct}.${key} of type int`;
    if (/[eE]/.test(text)) return `json: cannot unmarshal "${text}" ${into}`;
    const n = BigInt(text);
    if (n <= 2n ** 63n - 1n && n >= -(2n ** 63n)) return undefined;
    let json = "{";
    let at = 0;
    for (const [i, k] of Object.keys(args).sort().entries()) {
        json += `${i > 0 ? "," : ""}${encodeJSON(k)}:`;
        if (k === key) at = json.length;
        json += encodeJSON(sortKeys(args[k]) as GoJSON);
    }
    json += "}";
    const rest = utf8Encode(json.slice(at));
    const window =
        rest.length < 32
            ? json.slice(at)
            : `${utf8Decode(rest.slice(0, 32))}...`;
    return `json: cannot unmarshal number ${window} overflows ${into}`;
}

/** reportGap returns the gap report_gap's arguments describe. */
export function reportGap(a: Args): Gap {
    return {
        ...emptyGap(),
        kind: str(a, "kind"),
        answer: str(a, "answer"),
        ask: list(a, "ask"),
        asked: str(a, "asked"),
        srdRef: str(a, "srd_ref"),
        docID: str(a, "doc_id"),
        headingPath: list(a, "heading_path"),
        searchTerms: list(a, "search_terms"),
        topic: str(a, "topic"),
        demand: str(a, "demand"),
        detail: str(a, "detail"),
        targetClaim: str(a, "target_claim"),
    };
}

/**
 * UPDATE_FIELDS map update_gap's optional arguments onto the patch; an
 * omitted or null argument leaves its field unchanged.
 */
const UPDATE_FIELDS: readonly [string, keyof Patch][] = [
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

/** updatePatch returns the patch update_gap's arguments describe. */
export function updatePatch(a: Args): Patch {
    const out: Record<string, unknown> = {};
    for (const [arg, field] of UPDATE_FIELDS) {
        if (a[arg] !== undefined && a[arg] !== null) out[field] = a[arg];
    }
    if (a["add_hit"] === true) out["addHit"] = true;
    return out as Patch;
}

/** gapJSON is a gap as Go's json tags marshal it. */
export function gapJSON(gap: Gap): { [key: string]: GoJSON | undefined } {
    return {
        id: gap.id,
        status: gap.status,
        kind: gap.kind,
        answer: gap.answer,
        ask: gap.ask,
        asked: gap.asked,
        srd_ref: gap.srdRef,
        doc_id: gap.docID,
        heading_path: gap.headingPath,
        search_terms: gap.searchTerms,
        hits: gap.hits,
        created: formatRFC3339Nano(gap.created),
        filled_by: gap.filledBy.map((f) => ({
            ref: f.ref,
            hash: omitEmpty(f.hash),
        })),
        topic: gap.topic,
        demand: gap.demand,
        detail: gap.detail,
        target_claim: gap.targetClaim,
        file: gap.file,
        score: omitZero(gap.score),
        stale: gap.stale ? true : undefined,
        stale_refs:
            gap.staleRefs.length > 0
                ? gap.staleRefs.map((r) => ({ ref: r.ref, reason: r.reason }))
                : undefined,
    };
}

/** list returns the string-list argument key, [] when absent or null. */
function list(a: Args, key: string): string[] {
    return (a[key] as string[] | null | undefined) ?? [];
}

/** str returns the string argument key, "" when absent. */
function str(a: Args, key: string): string {
    return (a[key] as string | undefined) ?? "";
}

function omitZero(n: number): number | undefined {
    return n === 0 ? undefined : n;
}

function omitEmpty(s: string): string | undefined {
    return s === "" ? undefined : s;
}

/**
 * sortKeys returns v with every object's keys sorted, as Go marshals the
 * map go-sdk round-trips a tool's output through; undefined is dropped.
 */
export function sortKeys(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v === null || typeof v !== "object") return v;
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
        if (obj[key] !== undefined) out[key] = sortKeys(obj[key]);
    }
    return out;
}
