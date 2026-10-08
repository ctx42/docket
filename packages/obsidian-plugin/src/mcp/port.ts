// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin picks the doc server's port itself, so several vaults can each
// run a server on one machine. Before a run it keeps a project's configured
// `mcp-port` when that port is free, else it takes the first free port above
// it and writes it back: into the note's front matter, which the srd skills
// read, and into `.mcp.json`, which MCP clients read and the server checks
// against the note. A free configured port writes nothing, so a vault synced
// between devices keeps one port. Probing and file access are injected, so
// the logic is unit-tested.

import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { posix } from "node:path";

import { MCP_JSON } from "@docket/docserver";

/** BASE_PORT is where the search starts when a note sets no usable port. */
export const BASE_PORT = 7777;

/** SCAN_PORTS bounds the search before the system picks a port. */
export const SCAN_PORTS = 100;

/** PortDeps is the outside world {@link assignPort} works on. */
export interface PortDeps {
    readText(path: string): Promise<string>;
    /** readOptional returns undefined for a file that does not exist. */
    readOptional(path: string): Promise<string | undefined>;
    writeText(path: string, text: string): Promise<void>;
    /** isFree reports whether a server could listen on port now. */
    isFree(port: number): Promise<boolean>;
    /** anyPort returns a port the system reports free. */
    anyPort(): Promise<number>;
}

/** Assigned is the port a run uses, and the one it replaced, if any. */
export interface Assigned {
    port: number;
    /** moved is the configured port given up (undefined when none was). */
    moved?: number;
    /** written is set when the note and .mcp.json were rewritten. */
    written: boolean;
}

/** FRONT_RE matches a note's leading front matter block. */
const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** PORT_LINE_RE matches the front matter's `mcp-port` line. */
const PORT_LINE_RE = /^mcp-port:[^\r\n]*$/m;

/** SERVER_LINE_RE matches the front matter's `mcp-server` line. */
const SERVER_LINE_RE = /^mcp-server:[ \t]*(.*?)[ \t]*$/m;

/**
 * notePort returns the `mcp-port` a project note sets, or undefined when
 * it sets none in 1..65535.
 */
export function notePort(text: string): number | undefined {
    const front = FRONT_RE.exec(text)?.[1];
    const line = front === undefined ? undefined : PORT_LINE_RE.exec(front);
    if (line === undefined || line === null) return undefined;
    const raw = unquote(line[0].slice("mcp-port:".length).trim());
    if (!/^[0-9]+$/.test(raw)) return undefined;
    const port = Number(raw);
    return port >= 1 && port <= 65535 ? port : undefined;
}

/** noteServer returns the `mcp-server` name a project note sets, or "". */
export function noteServer(text: string): string {
    const front = FRONT_RE.exec(text)?.[1] ?? "";
    return unquote(SERVER_LINE_RE.exec(front)?.[1] ?? "");
}

/**
 * setNotePort returns text with its front matter's `mcp-port` set to port,
 * the line replaced in place or added at the end of the block; every other
 * byte is kept. It throws for a note without front matter.
 */
export function setNotePort(text: string, port: number): string {
    const m = FRONT_RE.exec(text);
    if (m === null) throw new Error("the config note has no front matter");
    const front = m[1] as string;
    const line = `mcp-port: ${port}`;
    const next = PORT_LINE_RE.test(front)
        ? front.replace(PORT_LINE_RE, line)
        : `${front}${text.includes("\r\n") ? "\r\n" : "\n"}${line}`;
    const start = m[0].indexOf(front);
    return text.slice(0, start) + next + text.slice(start + front.length);
}

/**
 * setMcpJsonPort returns `.mcp.json` text (raw, or a new file when
 * undefined) with server's URL on port: an existing URL keeps its host and
 * path, a missing entry becomes an HTTP entry at localhost. Other servers
 * and keys are kept. It throws for a file that does not parse.
 */
export function setMcpJsonPort(
    raw: string | undefined,
    server: string,
    port: number,
): string {
    let top: Record<string, unknown> = {};
    if (raw !== undefined) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            throw new Error(`parse ${MCP_JSON}: ${(err as Error).message}`);
        }
        if (!isRecord(parsed)) {
            throw new Error(`parse ${MCP_JSON}: not a JSON object`);
        }
        top = parsed;
    }
    const key =
        Object.keys(top).find((k) => k.toLowerCase() === "mcpservers") ??
        "mcpServers";
    const servers = isRecord(top[key]) ? { ...top[key] } : {};
    const entry = isRecord(servers[server]) ? { ...servers[server] } : {};
    entry["type"] ??= "http";
    entry["url"] = withPort(entry["url"], port);
    servers[server] = entry;
    top[key] = servers;
    return `${JSON.stringify(top, null, 2)}\n`;
}

/** withPort returns url on port, or the localhost endpoint when unusable. */
function withPort(url: unknown, port: number): string {
    if (typeof url === "string") {
        try {
            const u = new URL(url);
            u.port = String(port);
            if (u.port === String(port)) return u.toString();
        } catch {
            // Not a URL: replaced below.
        }
    }
    return `http://localhost:${port}/mcp`;
}

/**
 * pickPort returns from in 1..65535 when it is free, else the first free
 * port above it within {@link SCAN_PORTS}, else one the system picks.
 */
export async function pickPort(
    deps: Pick<PortDeps, "isFree" | "anyPort">,
    from: number,
): Promise<number> {
    for (let p = from; p < from + SCAN_PORTS && p <= 65535; p++) {
        if (await deps.isFree(p)) return p;
    }
    return deps.anyPort();
}

/**
 * assignPort settles the port of the project note at the disk path
 * config: its own `mcp-port` when free, else a free one written into the
 * note and its `.mcp.json`. A config that is not a project note (YAML) is
 * left alone and reports undefined.
 */
export async function assignPort(
    deps: PortDeps,
    config: string,
): Promise<Assigned | undefined> {
    if (!config.endsWith(".md")) return undefined;
    const note = await deps.readText(config);
    const configured = notePort(note);
    if (configured !== undefined && (await deps.isFree(configured))) {
        return { port: configured, written: false };
    }
    const port = await pickPort(deps, configured ?? BASE_PORT);
    const mcpJson = posix.join(posix.dirname(config), MCP_JSON);
    const registry = setMcpJsonPort(
        await deps.readOptional(mcpJson),
        noteServer(note),
        port,
    );
    await deps.writeText(config, setNotePort(note, port));
    await deps.writeText(mcpJson, registry);
    return {
        port,
        ...(configured === undefined ? {} : { moved: configured }),
        written: true,
    };
}

/**
 * isFreePort reports whether a server could listen on port on every
 * interface, as the doc server does, by binding it briefly.
 */
export function isFreePort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const srv = createServer();
        srv.unref();
        srv.once("error", () => resolve(false));
        srv.listen(port, () => srv.close(() => resolve(true)));
    });
}

/** systemPort returns a port the system reports free. */
export function systemPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.unref();
        srv.once("error", reject);
        srv.listen(0, () => {
            const addr = srv.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

/** NODE_PORT_DEPS is {@link PortDeps} over the local filesystem and network. */
export const NODE_PORT_DEPS: PortDeps = {
    readText: (path) => readFile(path, "utf8"),
    readOptional: async (path) => {
        try {
            return await readFile(path, "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                return undefined;
            }
            throw err;
        }
    },
    writeText: (path, text) => writeFile(path, text),
    isFree: isFreePort,
    anyPort: systemPort,
};

function unquote(s: string): string {
    const q = s[0];
    return (q === '"' || q === "'") && s.endsWith(q) && s.length >= 2
        ? s.slice(1, -1)
        : s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
