// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The REST mirror of the doc server, for humans, scripts and health probes,
// answering as the Go server's restapi package on Go 1.22's ServeMux:
// GET /healthz, /search, /docs, /docs/{id...}, /openapi.yaml, with a
// glossary GET /glossary, and with a gap store the gap write endpoints
// (POST/GET /gaps, PUT/DELETE /gaps/{id}, POST /gaps/{id}/submit, /fill,
// /reopen, /wontfix) whose JSON mirrors the MCP gap tools. Routing follows ServeMux: an unclean path
// redirects (307) to its clean form, a path matched under another method
// answers 405 with Allow, anything else 404, and a GET route also serves
// HEAD. JSON bodies are Go's json.Encoder output (HTML-safe, struct field
// order, trailing newline). The router is framework-free: the Node host
// adapts its requests to {@link RestRequest}.

import { isDocNotFound } from "../engine/engine.ts";
import {
    type BadFile,
    EC_BAD_FILE,
    EC_INVALID,
    EC_NOT_FOUND,
    EC_STATUS,
    type Fill,
    type Filter,
    type Gap,
    isGapError,
} from "../gaps/gaps.ts";
import { encodeJSONLine, type GoJSON } from "../gocompat/json.ts";
import { utf8DecodeEscaped, utf8Encode } from "../gocompat/utf8.ts";
import {
    type GapStore,
    gapJSON,
    reportGap,
    type ToolDeps,
    updatePatch,
} from "../mcp/tools.ts";
import { MAX_K } from "../search/retrieval.ts";
import {
    BodyError,
    type DecodedBody,
    decodeBody,
    type RequestSchema,
} from "./decode.ts";
import { OPENAPI_YAML } from "./openapi.ts";

/** MAX_BODY_BYTES caps a request body (Go's http.MaxBytesReader limit). */
export const MAX_BODY_BYTES = 1 << 20;

/** RestRequest is one HTTP request as the router needs it. */
export interface RestRequest {
    method: string;
    /** path is the escaped request path, e.g. "/docs/a%20b.md". */
    path: string;
    /** query is the raw query string, without "?". */
    query: string;
    /** body is the request body, possibly truncated past the limit. */
    body?: Uint8Array;
}

/** RestResponse is the router's answer. */
export interface RestResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}

/** Handler answers one matched route. */
type Handler = (req: Matched) => Promise<RestResponse> | RestResponse;

/** Matched is a request with its route's wildcard values. */
export interface Matched extends RestRequest {
    params: Record<string, string>;
    /** values are the parsed query values, first value per key. */
    values: URLValues;
}

/** Route is one method and path pattern with its handler. */
interface Route {
    method: string;
    /** segments are the pattern's path segments; "{x}" and "{x...}" bind. */
    segments: string[];
    handler: Handler;
}

/**
 * Rest serves the REST routes over deps; build one per server. Absent
 * glossary and store leave their routes out, as with the MCP tools.
 */
export class Rest {
    private readonly routes: Route[] = [];
    private readonly logErr: (err: unknown) => void;

    constructor(readonly deps: ToolDeps) {
        this.logErr = deps.logErr ?? (() => {});
        this.add("GET", "/healthz", () => this.healthz());
        this.add("GET", "/search", (r) => this.search(r));
        this.add("GET", "/docs", () => this.docs());
        this.add("GET", "/docs/{id...}", (r) => this.doc(r));
        this.add("GET", "/openapi.yaml", () => ({
            status: 200,
            headers: { "Content-Type": "application/yaml" },
            body: OPENAPI_YAML,
        }));
        if (deps.store !== undefined) this.gapRoutes(deps.store);
        if (deps.glossary !== undefined) {
            const gls = deps.glossary;
            this.add("GET", "/glossary", async (r) => {
                try {
                    const terms = await gls.terms(r.values.get("term"));
                    return json(200, {
                        terms: terms.map((t) => ({
                            term: t.term,
                            name: t.name,
                            abbreviation: t.abbreviation,
                            id: t.id,
                            path: t.path,
                            anchor: t.anchor,
                            definition: t.definition,
                        })),
                    });
                } catch (err) {
                    return this.internal(err);
                }
            });
        }
    }

    /** add registers handler for method and pattern (Go mux syntax). */
    add(method: string, pattern: string, handler: Handler): void {
        this.routes.push({
            method,
            segments: pattern.split("/").slice(1),
            handler,
        });
    }

    /** handle answers req as Go's ServeMux with the registered routes. */
    async handle(req: RestRequest): Promise<RestResponse> {
        const clean = cleanPath(req.path);
        const reqSegs = clean.split("/").slice(1);
        const allowed = new Set<string>();
        let hit: { route: Route; params: Record<string, string> } | undefined;
        for (const route of this.routes) {
            const params = match(route.segments, reqSegs);
            if (params === undefined) continue;
            const methods =
                route.method === "GET" ? ["GET", "HEAD"] : [route.method];
            for (const m of methods) allowed.add(m);
            if (hit === undefined && methods.includes(req.method))
                hit = { route, params };
        }
        if (clean !== req.path) {
            const target = req.query === "" ? clean : `${clean}?${req.query}`;
            return redirect(target, req.method);
        }
        if (hit === undefined) {
            if (allowed.size > 0) {
                return {
                    status: 405,
                    headers: {
                        Allow: [...allowed].sort().join(", "),
                        ...TEXT,
                    },
                    body: "Method Not Allowed\n",
                };
            }
            return {
                status: 404,
                headers: { ...TEXT },
                body: "404 page not found\n",
            };
        }
        const res = await hit.route.handler({
            ...req,
            params: hit.params,
            values: parseQuery(req.query),
        });
        return req.method === "HEAD" ? { ...res, body: "" } : res;
    }

    private healthz(): RestResponse {
        return json(200, {
            status: "ok",
            docs: this.deps.engine.listDocs().length,
        });
    }

    private async search(r: Matched): Promise<RestResponse> {
        const query = r.values.get("q");
        if (query === "")
            return errorJSON(400, "q query parameter is required");
        let k = 0;
        const raw = r.values.get("k");
        if (raw !== "") {
            const n = atoi(raw);
            if (n === undefined || n < 1)
                return errorJSON(400, "k must be a positive integer");
            if (n > MAX_K) return errorJSON(400, `k must be at most ${MAX_K}`);
            k = n;
        }
        let hits: Awaited<ReturnType<ToolDeps["engine"]["search"]>>;
        try {
            hits = await this.deps.engine.search({ text: query, k });
        } catch (err) {
            return this.internal(err);
        }
        return json(200, {
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
        });
    }

    private docs(): RestResponse {
        return json(200, {
            docs: this.deps.engine.listDocs().map((doc) => ({
                id: doc.id,
                path: doc.path,
                rank: omitZero(doc.rank),
                title: doc.title,
            })),
        });
    }

    private async doc(r: Matched): Promise<RestResponse> {
        let doc: Awaited<ReturnType<ToolDeps["engine"]["getDoc"]>>;
        try {
            doc = await this.deps.engine.getDoc(r.params["id"] ?? "");
        } catch (err) {
            if (isDocNotFound(err))
                return errorJSON(404, (err as Error).message);
            return this.internal(err);
        }
        return json(200, {
            id: doc.id,
            path: doc.path,
            rank: omitZero(doc.rank),
            title: doc.title,
            source_url: omitEmpty(doc.sourceURL),
            text: doc.text,
        });
    }

    /**
     * gapRoutes mounts the gap write endpoints: POST/GET /gaps, PUT/DELETE
     * /gaps/{id}, and POST /gaps/{id}/submit, /fill, /reopen, /wontfix.
     */
    private gapRoutes(store: GapStore): void {
        this.add("POST", "/gaps", (r) =>
            this.body(r, REPORT, async (b) => {
                const gap = reportGap(b);
                try {
                    const id = await (b["draft"] === true
                        ? store.appendDraft(gap)
                        : store.append(gap));
                    return json(201, { gap_id: id });
                } catch (err) {
                    if (isGapError(err, EC_INVALID))
                        return errorJSON(400, (err as Error).message);
                    return this.internal(err);
                }
            }),
        );
        this.add("GET", "/gaps", (r) => this.listGaps(r, store));
        this.add("PUT", "/gaps/{id}", (r) =>
            this.body(r, UPDATE, (b) =>
                this.transition(store.update(id(r), updatePatch(b))),
            ),
        );
        this.add("DELETE", "/gaps/{id}", (r) =>
            this.transition(store.discard(id(r))),
        );
        this.add("POST", "/gaps/{id}/submit", (r) =>
            this.transition(store.submit(id(r))),
        );
        this.add("POST", "/gaps/{id}/fill", (r) =>
            this.body(r, FILL, (b) => {
                const fll: Fill = {
                    refs: (b["filled_by"] as string[] | undefined) ?? [],
                    complete: b["complete"] === true,
                };
                if (typeof b["remaining"] === "string")
                    fll.remaining = b["remaining"];
                return this.transition(store.fill(id(r), fll));
            }),
        );
        for (const op of ["reopen", "wontfix"] as const) {
            this.add("POST", `/gaps/{id}/${op}`, (r) =>
                this.body(r, REASON, (b) =>
                    this.transition(
                        store[op](
                            id(r),
                            (b["reason"] as string | undefined) ?? "",
                        ),
                    ),
                ),
            );
        }
    }

    private async listGaps(r: Matched, store: GapStore): Promise<RestResponse> {
        const flt: Filter = {
            status: r.values.get("status"),
            srdRef: r.values.get("srd_ref"),
            query: r.values.get("query"),
            ask: r.values.get("ask"),
        };
        for (const key of ["stale", "asked"] as const) {
            const raw = r.values.get(key);
            if (raw === "") continue;
            const v = parseBool(raw);
            if (v === undefined)
                return errorJSON(400, `${key} must be true or false`);
            flt[key] = v;
        }
        let list: Gap[];
        let bad: BadFile[];
        try {
            list = await store.list(flt);
        } catch (err) {
            if (isGapError(err, EC_INVALID))
                return errorJSON(400, (err as Error).message);
            return this.internal(err);
        }
        try {
            bad = await store.badFiles();
        } catch (err) {
            return this.internal(err);
        }
        return json(200, {
            gaps: list.map(gapJSON),
            invalid: bad.map((b) => ({ file: b.file, reason: b.reason })),
        });
    }

    /** body decodes r's body as schema and passes it to then. */
    private async body(
        r: Matched,
        schema: RequestSchema,
        then: (b: DecodedBody) => Promise<RestResponse>,
    ): Promise<RestResponse> {
        let b: DecodedBody;
        try {
            b = decodeBody(r.body ?? new Uint8Array(), schema, MAX_BODY_BYTES);
        } catch (err) {
            if (err instanceof BodyError)
                return errorJSON(err.status, err.message);
            throw err;
        }
        return then(b);
    }

    /**
     * transition answers a gap operation: 400 for invalid input, 404 for
     * an unknown gap, 409 for a status conflict or an invalid gap file, 500
     * otherwise, and {"ok": true} on success.
     */
    private async transition(done: Promise<void>): Promise<RestResponse> {
        try {
            await done;
        } catch (err) {
            const msg = (err as Error).message;
            if (isGapError(err, EC_INVALID)) return errorJSON(400, msg);
            if (isGapError(err, EC_NOT_FOUND)) return errorJSON(404, msg);
            if (isGapError(err, EC_STATUS) || isGapError(err, EC_BAD_FILE))
                return errorJSON(409, msg);
            return this.internal(err);
        }
        return json(200, { ok: true });
    }

    /** internal logs err and answers a generic 500. */
    internal(err: unknown): RestResponse {
        this.logErr(err);
        return errorJSON(500, "internal error");
    }
}

/** The request structs of the gap endpoints, as the Go server types them. */
export const REPORT: RequestSchema = {
    name: "reportRequest",
    fields: {
        kind: "string",
        topic: "string",
        doc_id: "string",
        heading_path: "[]string",
        demand: "string",
        detail: "string",
        target_claim: "string",
        search_terms: "[]string",
        srd_ref: "string",
        answer: "string",
        ask: "[]string",
        asked: "string",
        draft: "bool",
    },
};
export const UPDATE: RequestSchema = {
    name: "updateRequest",
    fields: {
        kind: "*string",
        topic: "*string",
        doc_id: "*string",
        heading_path: "*[]string",
        demand: "*string",
        detail: "*string",
        target_claim: "*string",
        search_terms: "*[]string",
        srd_ref: "*string",
        answer: "*string",
        ask: "*[]string",
        asked: "*string",
        add_hit: "bool",
    },
};
export const FILL: RequestSchema = {
    name: "fillRequest",
    fields: { filled_by: "[]string", complete: "bool", remaining: "*string" },
};
export const REASON: RequestSchema = {
    name: "reasonRequest",
    fields: { reason: "string" },
};

/** id returns the {id} path value. */
function id(r: Matched): string {
    return r.params["id"] ?? "";
}

/** parseBool is Go's strconv.ParseBool; undefined when it fails. */
export function parseBool(s: string): boolean | undefined {
    if (["1", "t", "T", "TRUE", "true", "True"].includes(s)) return true;
    if (["0", "f", "F", "FALSE", "false", "False"].includes(s)) return false;
    return undefined;
}

/** TEXT is the header set of Go's http.Error. */
const TEXT: Readonly<Record<string, string>> = {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
};

/** json answers v as Go's json.Encoder writes it. */
export function json(
    status: number,
    v: { [key: string]: GoJSON | undefined },
): RestResponse {
    return {
        status,
        headers: { "Content-Type": "application/json" },
        body: encodeJSONLine(v),
    };
}

/** errorJSON answers {"error": message} with status. */
export function errorJSON(status: number, message: string): RestResponse {
    return json(status, { error: message });
}

/**
 * redirect is Go's http.Redirect with 307: a short HTML body only for GET
 * and HEAD, non-ASCII bytes of the location hex-escaped.
 */
function redirect(target: string, method: string): RestResponse {
    const location = hexEscapeNonASCII(target);
    if (method !== "GET" && method !== "HEAD") {
        return { status: 307, headers: { Location: location }, body: "" };
    }
    return {
        status: 307,
        headers: {
            Location: location,
            "Content-Type": "text/html; charset=utf-8",
        },
        body: `<a href="${htmlEscape(location)}">Temporary Redirect</a>.\n\n`,
    };
}

/** hexEscapeNonASCII is Go's net/http hexEscapeNonASCII. */
function hexEscapeNonASCII(s: string): string {
    let out = "";
    for (const b of utf8Encode(s)) {
        out +=
            b >= 0x80
                ? `%${b.toString(16).toUpperCase().padStart(2, "0")}`
                : String.fromCharCode(b);
    }
    return out;
}

/** htmlEscape is Go's net/http htmlEscape. */
function htmlEscape(s: string): string {
    return s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&#34;")
        .replaceAll("'", "&#39;");
}

/**
 * match binds the request segments to the pattern's, returning the
 * wildcard values (unescaped) or undefined when they do not match.
 */
function match(
    pattern: readonly string[],
    segs: readonly string[],
): Record<string, string> | undefined {
    const params: Record<string, string> = {};
    for (const [i, pat] of pattern.entries()) {
        if (pat.startsWith("{") && pat.endsWith("...}")) {
            const rest = segs.slice(i).join("/");
            const value = pathUnescape(rest);
            if (value === undefined) return undefined;
            params[pat.slice(1, -4)] = value;
            return params;
        }
        const seg = segs[i];
        if (seg === undefined) return undefined;
        if (pat.startsWith("{") && pat.endsWith("}")) {
            const value = pathUnescape(seg);
            if (value === undefined || seg === "") return undefined;
            params[pat.slice(1, -1)] = value;
        } else if (pat !== seg) {
            return undefined;
        }
    }
    return segs.length === pattern.length ? params : undefined;
}

/** cleanPath is Go's net/http cleanPath. */
export function cleanPath(p: string): string {
    if (p === "") return "/";
    const abs = p.startsWith("/") ? p : `/${p}`;
    const out: string[] = [];
    for (const part of abs.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") out.pop();
        else out.push(part);
    }
    let np = `/${out.join("/")}`;
    if (abs.endsWith("/") && np !== "/") np += "/";
    return np;
}

/** pathUnescape is Go's url.PathUnescape; undefined on a bad escape. */
function pathUnescape(s: string): string | undefined {
    return goUnescape(s, false);
}

/**
 * goUnescape decodes s's %XX escapes to bytes as Go's url unescaping does,
 * '+' a space in a query; bytes that are not UTF-8 stay as Go keeps them
 * (see utf8DecodeEscaped). Undefined on a malformed escape.
 */
function goUnescape(s: string, query: boolean): string | undefined {
    const bytes: number[] = [];
    let lit = 0;
    const flush = (end: number): void => {
        if (end > lit) bytes.push(...utf8Encode(s.slice(lit, end)));
    };
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "%") {
            const hex = s.slice(i + 1, i + 3);
            if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
            flush(i);
            bytes.push(Number.parseInt(hex, 16));
            i += 2;
            lit = i + 1;
        } else if (query && c === "+") {
            flush(i);
            bytes.push(0x20);
            lit = i + 1;
        }
    }
    flush(s.length);
    return utf8DecodeEscaped(new Uint8Array(bytes));
}

/** URLValues are parsed query values: first value per key, "" if none. */
export interface URLValues {
    get(key: string): string;
}

/**
 * parseQuery parses a raw query as Go's url.Query does, dropping a pair
 * whose escape is malformed or that holds a semicolon.
 */
export function parseQuery(raw: string): URLValues {
    const values = new Map<string, string>();
    for (const pair of raw.split("&")) {
        if (pair === "" || pair.includes(";")) continue;
        const eq = pair.indexOf("=");
        const key = queryUnescape(eq < 0 ? pair : pair.slice(0, eq));
        const value = queryUnescape(eq < 0 ? "" : pair.slice(eq + 1));
        if (key === undefined || value === undefined) continue;
        if (!values.has(key)) values.set(key, value);
    }
    return { get: (key) => values.get(key) ?? "" };
}

/** queryUnescape is Go's url.QueryUnescape; undefined on a bad escape. */
function queryUnescape(s: string): string | undefined {
    return goUnescape(s, true);
}

/** atoi is Go's strconv.Atoi; undefined when it fails. */
export function atoi(s: string): number | undefined {
    if (!/^[+-]?[0-9]+$/.test(s)) return undefined;
    const n = BigInt(s);
    if (n > 2n ** 63n - 1n || n < -(2n ** 63n)) return undefined;
    return Number(n);
}

function omitZero(n: number): number | undefined {
    return n === 0 ? undefined : n;
}

function omitEmpty(s: string): string | undefined {
    return s === "" ? undefined : s;
}
