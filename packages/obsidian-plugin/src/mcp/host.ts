// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's doc server host: one server run at a time, started, stopped
// and restarted on request, its state tracked from the run's own log lines
// ("listening on <addr>") and outcome. Requests are serialized, so a
// restart waits for the old server to release its port before the new one
// binds. A failed run (a config error, a port in use) becomes the error
// state, reported to the plugin, never a thrown error. The server itself is
// injected, so the state machine is unit-tested without Obsidian or a
// socket.

import type { LogWriter } from "@docket/docserver-node";

/** McpState is where the server is in its life. */
export type McpState =
    | { kind: "stopped" }
    | { kind: "starting" }
    | { kind: "listening"; address: string }
    | { kind: "error"; message: string };

/** RunRequest is what a server run gets from the host. */
export interface RunRequest {
    /** signal stops the run; an abort is a clean shutdown. */
    signal: AbortSignal;
    /** stderr receives the server's log lines. */
    stderr: LogWriter;
}

/** McpHostDeps are the host's server and listeners. */
export interface McpHostDeps {
    /**
     * run serves until the request's signal aborts, resolving then, or
     * rejects with the error that stopped it.
     */
    run: (req: RunRequest) => Promise<void>;
    /** onState is told every state change. */
    onState?: (state: McpState) => void;
    /** log receives each server log line. */
    log?: (line: string) => void;
}

/** LISTENING_PREFIX starts the log line a server logs once it serves. */
const LISTENING_PREFIX = "listening on ";

/** Running is the server run in progress. */
interface Running {
    abort: AbortController;
    done: Promise<void>;
}

/** McpHost runs the doc server on request; see the module comment. */
export class McpHost {
    private current: Running | undefined;
    private queue: Promise<void> = Promise.resolve();
    private now: McpState = { kind: "stopped" };
    private disposed = false;

    constructor(private readonly deps: McpHostDeps) {}

    /** state is the current state. */
    get state(): McpState {
        return this.now;
    }

    /** running reports whether a server run is in progress. */
    get running(): boolean {
        return this.current !== undefined;
    }

    /**
     * start starts the server unless it is running; it resolves once the
     * run is launched, not once it listens.
     */
    start(): Promise<void> {
        return this.enqueue(async () => {
            if (this.current === undefined && !this.disposed) this.launch();
        });
    }

    /** stop stops the server and resolves once it has shut down. */
    stop(): Promise<void> {
        return this.enqueue(() => this.halt());
    }

    /** restart stops the server if it runs, then starts it afresh. */
    restart(): Promise<void> {
        return this.enqueue(async () => {
            await this.halt();
            if (!this.disposed) this.launch();
        });
    }

    /**
     * dispose stops the server for good: requests already queued and any
     * made later start nothing.
     */
    dispose(): Promise<void> {
        this.disposed = true;
        return this.stop();
    }

    /** enqueue runs op after every request before it. */
    private enqueue(op: () => Promise<void>): Promise<void> {
        const next = this.queue.then(op);
        this.queue = next.catch(() => {});
        return next;
    }

    /** launch starts a run and tracks its state. */
    private launch(): void {
        const abort = new AbortController();
        const run: Running = { abort, done: Promise.resolve() };
        let partial = "";
        const stderr: LogWriter = {
            write: (text: string) => {
                const lines = (partial + text).split("\n");
                partial = lines.pop() ?? "";
                for (const line of lines) this.line(run, line);
                return true;
            },
        };
        this.current = run;
        this.set({ kind: "starting" });
        run.done = this.deps.run({ signal: abort.signal, stderr }).then(
            () => this.finish(run, { kind: "stopped" }),
            (err: unknown) =>
                this.finish(run, {
                    kind: "error",
                    message: err instanceof Error ? err.message : String(err),
                }),
        );
    }

    /** line handles one log line of run. */
    private line(run: Running, line: string): void {
        this.deps.log?.(line);
        // A run asked to stop while indexing still binds before it sees the
        // abort; it is stopping, not serving.
        if (this.current !== run || run.abort.signal.aborted) return;
        if (!line.startsWith(LISTENING_PREFIX)) return;
        this.set({
            kind: "listening",
            address: line.slice(LISTENING_PREFIX.length),
        });
    }

    /**
     * finish records how run ended, unless a newer run replaced it; a run
     * that was asked to stop has stopped, even if closing reported an error.
     */
    private finish(run: Running, state: McpState): void {
        if (this.current !== run) return;
        this.current = undefined;
        this.set(run.abort.signal.aborted ? { kind: "stopped" } : state);
    }

    /** halt stops the current run, if any, and waits for it to end. */
    private async halt(): Promise<void> {
        const run = this.current;
        if (run === undefined) {
            if (this.now.kind !== "stopped") this.set({ kind: "stopped" });
            return;
        }
        run.abort.abort();
        await run.done;
    }

    private set(state: McpState): void {
        this.now = state;
        this.deps.onState?.(state);
    }
}
