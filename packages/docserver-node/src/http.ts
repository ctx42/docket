// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The MCP server as Streamable HTTP for a shared deployment many clients
// connect to: each client session gets its own MCP server instance sharing
// the engine, gap store and glossary; a session idle for an hour is closed,
// and a client returning later gets "session not found" (HTTP 404) and
// starts a new session, as with the Go server.
//
// Requests reach the SDK's web-standard transport through this file's own
// adapter, not the SDK's Node transport: that one (via @hono/node-server)
// hands the global Request a Node stream as the body and replaces the global
// Request and Response. Inside Obsidian those globals are Chromium's, which
// reads a Node stream as the text "[object ReadableStream]", so every POST
// failed with "Parse error" (HTTP 400). Here the body is read first and
// passed as a string, which every runtime's Request accepts. Likewise timers
// may be the browser's, which return a number with no unref.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
    MAX_BODY_BYTES,
    newMcpServer,
    type Rest,
    type ToolDeps,
} from "@docket/docserver";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** MCP_PATH is where the server mounts the MCP endpoint. */
export const MCP_PATH = "/mcp";

/** SESSION_TIMEOUT_MS closes a session that sent no request for an hour. */
export const SESSION_TIMEOUT_MS = 60 * 60 * 1000;

/** Session is one client session: its transport and idle timer. */
interface Session {
    transport: WebStandardStreamableHTTPServerTransport;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * McpHttpHandler serves MCP over Streamable HTTP for every request it is
 * given, whatever the method, minting a new MCP server per session.
 */
export class McpHttpHandler {
    private readonly sessions = new Map<string, Session>();

    /**
     * @param deps are shared by every session's server.
     * @param timeoutMs closes a session idle for this long.
     */
    constructor(
        private readonly deps: ToolDeps,
        private readonly timeoutMs = SESSION_TIMEOUT_MS,
    ) {}

    /** handle serves one HTTP request. */
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const sid = req.headers["mcp-session-id"];
        if (typeof sid === "string") {
            const ses = this.sessions.get(sid);
            if (ses === undefined) {
                res.writeHead(404, {
                    "content-type": "text/plain; charset=utf-8",
                    "x-content-type-options": "nosniff",
                });
                res.end("session not found\n");
                return;
            }
            this.touch(sid, ses);
            await serveWeb(ses.transport, req, res);
            return;
        }
        const transport: WebStandardStreamableHTTPServerTransport =
            new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => {
                    const timer = setTimeout(() => {}, 0);
                    const ses = { transport, timer };
                    this.sessions.set(id, ses);
                    this.touch(id, ses);
                },
            });
        transport.onclose = () => {
            const id = transport.sessionId;
            if (id === undefined) return;
            const ses = this.sessions.get(id);
            if (ses !== undefined) clearTimeout(ses.timer);
            this.sessions.delete(id);
        };
        // The SDK's transport classes declare optional callbacks without
        // `| undefined`, which exactOptionalPropertyTypes rejects.
        await newMcpServer(this.deps).connect(transport as Transport);
        await serveWeb(transport, req, res);
    }

    /** size returns the number of open sessions. */
    get size(): number {
        return this.sessions.size;
    }

    /** close ends every session. */
    async close(): Promise<void> {
        const all = [...this.sessions.values()];
        this.sessions.clear();
        for (const ses of all) {
            clearTimeout(ses.timer);
            await ses.transport.close();
        }
    }

    /** touch restarts the session's idle timer. */
    private touch(id: string, ses: Session): void {
        clearTimeout(ses.timer);
        ses.timer = setTimeout(() => {
            this.sessions.delete(id);
            void ses.transport.close();
        }, this.timeoutMs);
        // Inside Obsidian setTimeout is the browser's, returning a number.
        (ses.timer as { unref?: () => void }).unref?.();
    }
}

/**
 * restRoute adapts the runtime-neutral REST router to Node's HTTP server:
 * it reads at most one byte past {@link MAX_BODY_BYTES} of the body (the
 * router answers 413 beyond the limit) and writes the router's answer, the
 * body left out for a HEAD request.
 */
export function restRoute(
    rest: Rest,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    return async (req, res) => {
        const url = req.url ?? "/";
        const q = url.indexOf("?");
        const method = req.method ?? "GET";
        const body = await readBody(req, MAX_BODY_BYTES + 1);
        const out = await rest.handle({
            method,
            path: q < 0 ? url : url.slice(0, q),
            query: q < 0 ? "" : url.slice(q + 1),
            body,
        });
        res.writeHead(out.status, out.headers);
        res.end(method === "HEAD" ? undefined : out.body);
    };
}

/**
 * serveWeb passes req to the web-standard transport and writes its answer
 * to res, streaming an SSE body as it comes; a client that goes away
 * cancels the stream.
 */
async function serveWeb(
    transport: WebStandardStreamableHTTPServerTransport,
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    const out = await transport.handleRequest(await toWebRequest(req));
    const headers: Record<string, string> = {};
    out.headers.forEach((value, key) => {
        headers[key] = value;
    });
    res.writeHead(out.status, headers);
    if (out.body === null) {
        res.end();
        return;
    }
    // Node sends the headers with the first chunk; an SSE stream may stay
    // quiet, so they go out now and the client sees the stream open.
    res.flushHeaders();
    const reader = out.body.getReader();
    res.on("close", () => {
        void reader.cancel().catch(() => {});
    });
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
        }
    } catch {
        // The client went away or the transport closed the stream.
    } finally {
        res.end();
    }
}

/** FRAMING are the headers of the wire framing, not of the body passed on. */
const FRAMING = new Set(["content-length", "transfer-encoding", "connection"]);

/**
 * toWebRequest builds the web Request for req with its body read in full
 * and passed as a string, the one body type every runtime's Request takes.
 */
export async function toWebRequest(req: IncomingMessage): Promise<Request> {
    const method = req.method ?? "GET";
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || FRAMING.has(key)) continue;
        for (const v of Array.isArray(value) ? value : [value]) {
            headers.append(key, v);
        }
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const init: RequestInit = { method, headers };
    if (method !== "GET" && method !== "HEAD") {
        init.body = new TextDecoder().decode(await readBody(req, Infinity));
    }
    return new Request(url, init);
}

/** readBody reads req's body, keeping at most limit bytes. */
async function readBody(
    req: IncomingMessage,
    limit: number,
): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = chunk as Buffer;
        if (size < limit) chunks.push(buf.subarray(0, limit - size));
        size += buf.length;
    }
    return new Uint8Array(Buffer.concat(chunks));
}
