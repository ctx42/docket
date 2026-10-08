// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The server's startup and shutdown sequence, as the earlier Go server runs
// it: load the config (a plain YAML file or a project's project-config.md),
// confirm the project's .mcp.json and the gap folder, start the watchers
// before the first ingest so no change is missed, index the sources, tidy
// and index the gap folder, start the debounced rebuild loops, then serve
// one stdio client or any number of Streamable HTTP clients at /mcp until
// the abort signal fires — a clean shutdown, not an error. Every step logs
// the Go server's lines to the injected stderr.

import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
    CLOSED_DIR,
    CloseReplacedError,
    type Config,
    checkMCPJSON,
    type DocFs,
    DocResolver,
    Engine,
    FileStore,
    formatDuration,
    fromDate,
    type Gap,
    Glossary,
    loadConfig,
    MILLISECOND,
    type Move,
    type Notifier,
    type Project,
    Rest,
    runLoop,
    type Source,
    TidyError,
    type ToolDeps,
} from "@docket/docserver";

import { NodeDocFs, slashPath } from "./fs.ts";
import { MCP_PATH, McpHttpHandler, restRoute } from "./http.ts";
import { serveStdio } from "./stdio.ts";
import { FsNotifier } from "./watch.ts";

/** READ_HEADER_TIMEOUT_MS bounds how long a client may take to send headers. */
export const READ_HEADER_TIMEOUT_MS = 10_000;

/**
 * SHUTDOWN_TIMEOUT_MS bounds how long a shutdown waits for in-flight
 * requests before closing the connections still open.
 */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

/** LogWriter is the part of a stream the log lines need. */
export interface LogWriter {
    write(text: string): unknown;
}

/** Watcher is a running source watcher, released with close. */
export interface Watcher extends Notifier {
    close(): void;
}

/**
 * WatcherFactory starts watching directory sources dirs and files; it may
 * finish asynchronously, so a host can inspect the sources without
 * blocking.
 */
export type WatcherFactory = (
    dirs: string[],
    files: string[],
) => Watcher | Promise<Watcher>;

/** Route serves the HTTP requests under one path (REST mounts this way). */
export type Route = (
    req: IncomingMessage,
    res: ServerResponse,
) => void | Promise<void>;

/** RunOptions drive one run of the server. */
export interface RunOptions {
    /**
     * config is the config path: YAML, or a project-config.md note; a
     * relative path is resolved against the working directory.
     */
    config: string;
    /** stdio serves a single client over stdin/stdout instead of HTTP. */
    stdio?: boolean;
    /** version is the server version reported to clients. */
    version: string;
    /** stderr receives the log lines. */
    stderr: LogWriter;
    stdin?: Readable;
    stdout?: Writable;
    /** signal stops the server; an abort is a clean shutdown. */
    signal?: AbortSignal;
    /** fs defaults to the local filesystem. */
    fs?: DocFs;
    /** newWatcher defaults to {@link FsNotifier}. */
    newWatcher?: WatcherFactory;
    /** now returns the time in ms, for durations and gap timestamps. */
    now?: () => number;
    /** routes adds HTTP handlers beside /mcp, keyed by path prefix. */
    routes?: (deps: ToolDeps) => Map<string, Route>;
}

/**
 * run is the whole server: it resolves on a clean shutdown and throws the
 * error that stopped it. Every resource it opened is released first.
 */
export async function run(opts: RunOptions): Promise<void> {
    const fs = opts.fs ?? new NodeDocFs();
    const log = (line: string) => opts.stderr.write(`${line}\n`);
    const now = opts.now ?? (() => performance.now());
    const clock = opts.now === undefined ? () => Date.now() : opts.now;
    const cleanup: (() => void | Promise<void>)[] = [];
    try {
        // The loaders take an absolute path, as Go's resolve theirs with
        // filepath.Abs: a relative one is the working directory's.
        const cfg = await loadConfig(fs, slashPath(resolve(opts.config)));
        await checkProject(fs, log, cfg.project);
        await checkGapDir(fs, cfg.gaps);

        // The watchers start before the first ingest, so a change landing
        // while it runs is not missed.
        let ntf: Watcher | undefined;
        let gapNtf: Watcher | undefined;
        if (cfg.watch.enabled) {
            const newWatcher =
                opts.newWatcher ?? ((d, f) => new FsNotifier(d, f));
            const [dirs, files] = watchPaths(cfg);
            try {
                ntf = await newWatcher(dirs, files);
            } catch (err) {
                throw wrap("watch sources", err);
            }
            cleanup.push(() => ntf?.close());
            if (cfg.gaps !== "") {
                try {
                    gapNtf = await newWatcher([cfg.gaps], []);
                } catch (err) {
                    throw wrap("watch gaps folder", err);
                }
                cleanup.push(() => gapNtf?.close());
            }
        }

        logConfig(log, cfg);
        let start = now();
        const eng = await newEngine(fs, cfg);
        cleanup.push(() => eng.close());
        log(
            `indexed ${eng.listDocs().length} documents in ${since(now, start)}`,
        );

        let store: FileStore | undefined;
        if (cfg.gaps !== "") {
            const gst = new FileStore(
                fs,
                cfg.gaps,
                () => fromDate(new Date(clock())),
                new DocResolver(eng),
                { warn: (err) => log(err.message) },
            );
            cleanup.push(() => gst.close());
            await tidyGaps(log, gst);
            start = now();
            let cnt: number;
            try {
                cnt = await gst.reindex();
            } catch (err) {
                throw wrap("index gaps", err);
            }
            log(`indexed ${cnt} gaps in ${since(now, start)}`);
            await logStale(log, gst);
            store = gst;
            if (gapNtf !== undefined) {
                const stop = startWatch(log, gapNtf, cfg, async () => {
                    await reindexGaps(log, now, gst);
                    await logStale(log, gst);
                });
                cleanup.push(stop);
                log("watching gaps folder for changes");
            }
        }
        const glossary =
            cfg.glossary !== "" ? new Glossary(eng, cfg.glossary) : undefined;

        if (ntf !== undefined) {
            const stop = startWatch(log, ntf, cfg, async () => {
                await reload(log, now, eng);
                if (store !== undefined) await logStale(log, store);
            });
            cleanup.push(stop);
            log(
                `watching sources for changes (debounce ${formatDuration(cfg.watch.debounce)})`,
            );
        }

        const deps: ToolDeps = {
            engine: eng,
            version: opts.version,
            logErr: (err) => log(`request failed: ${errorText(err)}`),
        };
        if (store !== undefined) deps.store = store;
        if (glossary !== undefined) deps.glossary = glossary;
        if (opts.stdio === true) {
            await serveStdio(deps, {
                ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
                ...(opts.stdout === undefined ? {} : { stdout: opts.stdout }),
                ...(opts.signal === undefined ? {} : { signal: opts.signal }),
            });
            return;
        }
        if (cfg.listen === "") {
            throw new Error("listen address is required in HTTP mode");
        }
        const mcp = new McpHttpHandler(deps);
        cleanup.push(() => mcp.close());
        // An open MCP stream keeps its connection busy, so the graceful
        // shutdown would wait out its timeout (or, under Bun, for good):
        // the sessions close as soon as the stop is asked for.
        const closeSessions = () => void mcp.close();
        opts.signal?.addEventListener("abort", closeSessions, { once: true });
        cleanup.push(() =>
            opts.signal?.removeEventListener("abort", closeSessions),
        );
        const routes = new Map<string, Route>([
            [MCP_PATH, (req, res) => mcp.handle(req, res)],
            ...(opts.routes?.(deps) ?? []),
        ]);
        const rest = restRoute(new Rest(deps));
        await serveHTTP(
            cfg.listen,
            router(routes, log, rest),
            log,
            opts.signal,
        );
    } finally {
        for (const close of cleanup.reverse()) {
            try {
                await close();
            } catch {
                // Releasing is best effort; the run's own outcome stands.
            }
        }
    }
}

/**
 * router dispatches a request to the route registered for its exact path
 * or, for a prefix ending in "/", the longest such prefix; anything else
 * goes to fallback (the REST router), or is Go's mux 404 without one.
 */
export function router(
    routes: ReadonlyMap<string, Route>,
    log: (line: string) => void,
    fallback?: Route,
): Route {
    return async (req, res) => {
        // The raw request path, as Go's mux sees it: URL parsing would read
        // "//mcp" as a host and drop "/./" segments. An unclean path matches
        // no route and reaches the fallback, which redirects it like Go.
        const url = req.url ?? "/";
        const q = url.indexOf("?");
        const path = q < 0 ? url : url.slice(0, q);
        let route = routes.get(path);
        if (route === undefined) {
            let best = "";
            for (const key of routes.keys()) {
                if (
                    key.endsWith("/") &&
                    path.startsWith(key) &&
                    key.length > best.length
                )
                    best = key;
            }
            route = best === "" ? fallback : routes.get(best);
        }
        if (route === undefined) {
            res.writeHead(404, {
                "content-type": "text/plain; charset=utf-8",
                "x-content-type-options": "nosniff",
            });
            res.end("404 page not found\n");
            return;
        }
        try {
            await route(req, res);
        } catch (err) {
            log(`request failed: ${errorText(err)}`);
            if (!res.headersSent) res.writeHead(500);
            res.end();
        }
    };
}

/**
 * serveHTTP listens on addr, logs "listening on <addr>" per bound address,
 * and serves handler until signal aborts, then shuts down: it waits for
 * in-flight requests, closing the connections still open after
 * {@link SHUTDOWN_TIMEOUT_MS}. An address without a host (":7777", what a
 * project config sets) binds the loopback interfaces only, 127.0.0.1 and
 * ::1 when the system has it, and then answers only requests naming a
 * loopback host, so a page using DNS rebinding cannot reach the server. A
 * request from a browser page on another site (a non-loopback Origin) is
 * refused whatever the address.
 */
export async function serveHTTP(
    addr: string,
    handler: Route,
    log: (line: string) => void,
    signal?: AbortSignal,
    timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
    const { host, port } = splitHostPort(addr);
    const local = host === "" || isLoopback(host);
    const guarded: Route = (req, res) => {
        const why = refusal(req, local);
        if (why === undefined) return handler(req, res);
        res.writeHead(403, {
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff",
        });
        res.end(`403 forbidden: ${why}\n`);
    };
    const first = await listenOn(
        addr,
        host === "" ? "127.0.0.1" : host,
        port,
        guarded,
    );
    const servers = [first];
    if (host === "") {
        // ::1 too, so a client resolving "localhost" to it connects; a
        // system without IPv6 serves on 127.0.0.1 alone.
        const bound = (first.address() as AddressInfo).port;
        try {
            servers.push(await listenOn(addr, "::1", bound, guarded));
        } catch (err) {
            const code = ((err as Error).cause as NodeJS.ErrnoException)?.code;
            if (code !== "EADDRNOTAVAIL" && code !== "EAFNOSUPPORT") {
                first.close();
                throw err;
            }
        }
    }
    for (const srv of servers) {
        log(`listening on ${formatAddr(srv.address() as AddressInfo)}`);
    }
    // The servers stop together: on the signal, or when one fails.
    const both = new AbortController();
    const stop = () => both.abort();
    if (signal?.aborted === true) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    const done = await Promise.allSettled(
        servers.map((srv) =>
            serve(srv, both.signal, timeoutMs).catch((err: unknown) => {
                stop();
                throw err;
            }),
        ),
    );
    signal?.removeEventListener("abort", stop);
    const failed = done.find((d) => d.status === "rejected");
    if (failed !== undefined) throw failed.reason;
}

/** listenOn starts a server for handler on host:port; addr names it in errors. */
async function listenOn(
    addr: string,
    host: string,
    port: number,
    handler: Route,
): Promise<ReturnType<typeof createServer>> {
    const srv = createServer((req, res) => {
        void handler(req, res);
    });
    srv.headersTimeout = READ_HEADER_TIMEOUT_MS;
    srv.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(listenError(addr, err));
        srv.once("error", onError);
        srv.listen({ port, host }, () => {
            srv.off("error", onError);
            resolve();
        });
    });
    return srv;
}

/**
 * refusal returns why req is refused, or undefined to serve it: a browser
 * Origin that is not a loopback page, or, on a loopback server (local), a
 * Host header naming another host.
 */
export function refusal(
    req: IncomingMessage,
    local: boolean,
): string | undefined {
    const origin = req.headers.origin;
    if (origin !== undefined) {
        let name = "";
        try {
            name = new URL(origin).hostname;
        } catch {
            // Not a URL ("null" from a sandboxed page): not loopback.
        }
        if (!isLoopback(name)) return `origin ${origin} is not local`;
    }
    if (local) {
        const hostHeader = req.headers.host ?? "";
        if (!isLoopback(hostName(hostHeader))) {
            return `host ${hostHeader} is not local`;
        }
    }
    return undefined;
}

/** hostName returns a Host header's host without its port and brackets. */
function hostName(hostHeader: string): string {
    if (hostHeader.startsWith("[")) {
        const end = hostHeader.indexOf("]");
        return end < 0 ? hostHeader : hostHeader.slice(1, end);
    }
    const colon = hostHeader.lastIndexOf(":");
    return colon < 0 ? hostHeader : hostHeader.slice(0, colon);
}

/** isLoopback reports whether host names this machine's loopback interface. */
export function isLoopback(host: string): boolean {
    const h = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * serve serves on the listening srv until signal aborts, then shuts down
 * gracefully. A failure to accept connections ends it with that error,
 * without a shutdown, as Go's http.Server.Serve returns it.
 */
export function serve(
    srv: ReturnType<typeof createServer>,
    signal?: AbortSignal,
    timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
            signal?.removeEventListener("abort", onAbort);
            srv.close();
            srv.closeAllConnections();
            reject(err);
        };
        const onAbort = () => {
            srv.off("error", onError);
            void shutdown(srv, timeoutMs).then(resolve);
        };
        srv.once("error", onError);
        if (signal?.aborted === true) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** IDLE_POLL_MS is how often shutdown closes connections gone idle. */
const IDLE_POLL_MS = 25;

/**
 * shutdown stops srv accepting, waits for in-flight requests, and closes
 * the connections still open after timeoutMs. Like Go's Server.Shutdown it
 * keeps closing connections as they go idle, so one that finishes its
 * request after the stop does not linger until its keep-alive timeout.
 */
export function shutdown(
    srv: ReturnType<typeof createServer>,
    timeoutMs: number,
): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(() => srv.closeAllConnections(), timeoutMs);
        const poll = setInterval(
            () => srv.closeIdleConnections(),
            IDLE_POLL_MS,
        );
        srv.close(() => {
            clearTimeout(timer);
            clearInterval(poll);
            resolve();
        });
        srv.closeIdleConnections();
    });
}

/** splitHostPort parses a Go listen address such as ":7777" or "h:0". */
export function splitHostPort(addr: string): { host: string; port: number } {
    const at = addr.lastIndexOf(":");
    if (at < 0)
        throw new Error(
            `listen: listen tcp: address ${addr}: missing port in address`,
        );
    let host = addr.slice(0, at);
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    const raw = addr.slice(at + 1);
    const port = raw === "" ? 0 : Number(raw);
    if (!/^[0-9]*$/.test(raw) || port > 65535) {
        throw new Error(`listen: listen tcp: address ${raw}: invalid port`);
    }
    return { host, port };
}

/** formatAddr formats a bound address as Go's net.Addr does. */
export function formatAddr(a: AddressInfo): string {
    return a.family === "IPv6"
        ? `[${a.address}]:${a.port}`
        : `${a.address}:${a.port}`;
}

/** checkProject confirms a project's port against its .mcp.json. */
export async function checkProject(
    fs: DocFs,
    log: (line: string) => void,
    prj: Project | null,
): Promise<void> {
    if (prj === null) return;
    if (await checkMCPJSON(fs, prj)) return;
    log(
        `warning: no .mcp.json in ${prj.root}; cannot confirm that mcp-server ` +
            `"${prj.server}" is registered on port ${prj.port}`,
    );
}

/**
 * checkGapDir confirms the gap folder exists, is a directory and is
 * writable; the server never creates it. An empty dir passes.
 */
export async function checkGapDir(fs: DocFs, dir: string): Promise<void> {
    if (dir === "") return;
    let isDir: boolean;
    try {
        isDir = (await fs.stat(dir)).isDir;
    } catch (err) {
        throw wrap("gaps folder", err);
    }
    if (!isDir) throw new Error(`gaps folder ${dir} is not a directory`);
    try {
        await fs.probeWritable(dir, ".gaps-check-");
    } catch (err) {
        throw wrap(`gaps folder ${dir} is not writable`, err);
    }
}

/** logConfig logs what the server took from cfg. */
export function logConfig(log: (line: string) => void, cfg: Config): void {
    const prj = cfg.project;
    if (prj !== null) {
        log(
            `project ${prj.root}: mcp-server "${prj.server}" on port ${prj.port}`,
        );
    }
    for (const name of [...cfg.sources.keys()].sort()) {
        const src = cfg.sources.get(name) as { dir: string; file: string };
        log(`source ${name} at ${src.dir !== "" ? src.dir : src.file}`);
    }
    if (cfg.gaps !== "") log(`gaps folder at ${cfg.gaps}`);
    if (cfg.glossary !== "") log(`glossary at ${cfg.glossary}`);
    if (cfg.precedence.length > 0)
        log(`precedence ${cfg.precedence.join(", ")}`);
    if (cfg.initiatives !== "") log(`initiatives at ${cfg.initiatives}`);
}

/** GapTidier is the part of the gap store tidyGaps drives. */
export interface GapTidier {
    tidy(): Promise<Move[]>;
}

/** tidyGaps moves misplaced gap files, logging each move and a failure. */
export async function tidyGaps(
    log: (line: string) => void,
    gst: GapTidier,
): Promise<void> {
    let moves: Move[];
    let failure: unknown;
    try {
        moves = await gst.tidy();
    } catch (err) {
        moves = err instanceof TidyError ? err.moves : [];
        failure = err;
    }
    for (const mov of moves) {
        const into = mov.to.startsWith(`${CLOSED_DIR}/`);
        log(`moved ${mov.from} ${into ? "to" : "out of"} ${CLOSED_DIR}/`);
    }
    if (failure !== undefined) log(`gap tidy failed: ${errorText(failure)}`);
}

/** GapIndexer is the part of the gap store reindexGaps drives. */
export interface GapIndexer {
    reindex(): Promise<number>;
}

/** reindexGaps rebuilds the gap index, logging the outcome. */
export async function reindexGaps(
    log: (line: string) => void,
    now: () => number,
    gst: GapIndexer,
): Promise<void> {
    const start = now();
    let cnt: number;
    try {
        cnt = await gst.reindex();
    } catch (err) {
        log(
            `gap reindex failed, serving previous gap index: ${errorText(err)}`,
        );
        return;
    }
    log(`reindexed ${cnt} gaps in ${since(now, start)}`);
}

/** GapLister is the part of the gap store logStale drives. */
export interface GapLister {
    list(filter: { stale: boolean }): Promise<Gap[]>;
}

/** logStale logs the IDs of the stale gaps; nothing when none is. */
export async function logStale(
    log: (line: string) => void,
    gst: GapLister,
): Promise<void> {
    let list: Gap[];
    try {
        list = await gst.list({ stale: true });
    } catch (err) {
        log(`stale gap check failed: ${errorText(err)}`);
        return;
    }
    if (list.length === 0) return;
    log(`stale gaps (${list.length}): ${list.map((g) => g.id).join(", ")}`);
}

/** Reloader is the part of the engine reload drives. */
export interface Reloader {
    reload(): Promise<void>;
    listDocs(): readonly unknown[];
}

/**
 * reload rebuilds the engine's index and logs the outcome; a failure to
 * close the replaced index is logged beside the success.
 */
export async function reload(
    log: (line: string) => void,
    now: () => number,
    eng: Reloader,
): Promise<void> {
    const start = now();
    let replaced: unknown;
    try {
        await eng.reload();
    } catch (err) {
        if (!(err instanceof CloseReplacedError)) {
            log(`reindex failed, serving previous index: ${errorText(err)}`);
            return;
        }
        replaced = err;
    }
    let msg = `reindexed ${eng.listDocs().length} documents in ${since(now, start)}`;
    if (replaced !== undefined) msg += `; ${errorText(replaced)}`;
    log(msg);
}

/**
 * startWatch runs the debounced rebuild loop over ntf and returns the stop
 * function, which waits for a rebuild in progress to finish.
 */
export function startWatch(
    log: (line: string) => void,
    ntf: Notifier,
    cfg: Config,
    rebuild: () => Promise<void>,
): () => Promise<void> {
    const ctl = new AbortController();
    const done = runLoop(ntf, {
        debounceMs: Number(cfg.watch.debounce / MILLISECOND),
        rebuild,
        warn: (err) => log(err.message),
        signal: ctl.signal,
    });
    return async () => {
        ctl.abort();
        await done;
    };
}

/** watchPaths splits the sources into directories and files, each sorted. */
export function watchPaths(cfg: Config): [string[], string[]] {
    const dirs: string[] = [];
    const files: string[] = [];
    for (const src of cfg.sources.values()) {
        if (src.dir !== "") dirs.push(src.dir);
        else files.push(src.file);
    }
    return [dirs.sort(), files.sort()];
}

/** newEngine indexes cfg's sources, ranked by its precedence. */
export function newEngine(fs: DocFs, cfg: Config): Promise<Engine> {
    return Engine.create({
        fs,
        sources: engineSources(cfg),
        ranking: { precedence: cfg.precedence, unranked: cfg.initiatives },
    });
}

/** engineSources maps the configured sources sorted by name. */
export function engineSources(cfg: Config): Source[] {
    return [...cfg.sources.keys()].sort().map((name) => {
        const src = cfg.sources.get(name) as { dir: string; file: string };
        return src.dir !== ""
            ? { name, dir: src.dir }
            : { name, file: src.file };
    });
}

/** since formats the time from start as Go's Duration.Round(ms). */
export function since(now: () => number, start: number): string {
    const ns = BigInt(Math.max(0, Math.round((now() - start) * 1e6)));
    return formatDuration(roundMs(ns));
}

/** roundMs rounds ns to a whole millisecond, half away from zero. */
export function roundMs(ns: bigint): bigint {
    const r = ns % MILLISECOND;
    return r + r < MILLISECOND ? ns - r : ns + MILLISECOND - r;
}

/**
 * listenError words a failed listen as Go's net.Listen does, for the errors
 * a server meets binding its address.
 */
function listenError(addr: string, err: Error): Error {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    const reason = BIND_REASONS[code];
    const text =
        reason === undefined
            ? err.message
            : `listen tcp ${addr}: bind: ${reason}`;
    return new Error(`listen: ${text}`, { cause: err });
}

/** BIND_REASONS are Go's texts for the errnos a bind meets. */
const BIND_REASONS: Readonly<Record<string, string>> = {
    EADDRINUSE: "address already in use",
    EACCES: "permission denied",
    EADDRNOTAVAIL: "cannot assign requested address",
};

/** errorText is an error's message. */
function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** wrap prefixes err's message as Go's fmt.Errorf("prefix: %w"). */
function wrap(prefix: string, err: unknown): Error {
    return new Error(`${prefix}: ${errorText(err)}`, { cause: err });
}
