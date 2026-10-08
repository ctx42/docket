// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Rebuilding derived state when the files it was built from change: a
// Notifier turns filesystem events into change signals (the Node host has
// one over `fs.watch`), and runLoop debounces those signals into rebuilds
// that never overlap.

import type { AbortLike } from "../util/cancel.ts";
import { clearTimer, setTimer, type TimerHandle } from "../util/timers.ts";

/** NotifierSink receives what a {@link Notifier} delivers. */
export interface NotifierSink {
    /** change signals that a watched file changed. */
    change(): void;
    /** error delivers an error met while watching that did not stop it. */
    error(err: Error): void;
    /** closed reports that the notifier stopped; nothing follows it. */
    closed(): void;
}

/**
 * Notifier delivers change signals and non-fatal errors to one sink (Go's
 * channels): signals arriving before the sink is set coalesce into one,
 * errors queue up to {@link ERR_BUFFER}, and a stopped notifier reports
 * closed at once.
 */
export interface Notifier {
    listen(sink: NotifierSink): void;
}

/** ERR_BUFFER is how many errors a notifier holds for its reader. */
export const ERR_BUFFER = 16;

/**
 * Relay is the buffering half of a {@link Notifier}: producers call
 * signal, warn and close; it delivers to the sink once one listens, holding
 * one coalesced change and up to {@link ERR_BUFFER} errors until then.
 */
export class Relay implements Notifier {
    private sink: NotifierSink | undefined;
    private pending = false;
    private readonly errs: Error[] = [];
    private done = false;

    listen(sink: NotifierSink): void {
        this.sink = sink;
        for (const err of this.errs.splice(0)) sink.error(err);
        if (this.pending) {
            this.pending = false;
            sink.change();
        }
        if (this.done) sink.closed();
    }

    /** signal records a change, coalescing with one not yet delivered. */
    signal(): void {
        if (this.done) return;
        if (this.sink === undefined) this.pending = true;
        else this.sink.change();
    }

    /** warn delivers err, dropping it when the buffer is full. */
    warn(err: Error): void {
        if (this.done) return;
        if (this.sink !== undefined) this.sink.error(err);
        else if (this.errs.length < ERR_BUFFER) this.errs.push(err);
    }

    /** close stops delivery and reports closed; later calls do nothing. */
    close(): void {
        if (this.done) return;
        this.done = true;
        this.sink?.closed();
    }
}

/** LoopOptions configure {@link runLoop}. */
export interface LoopOptions {
    /** debounceMs is the quiet period after the last signal. */
    debounceMs: number;
    /** rebuild rebuilds the derived state; it reports its own failures. */
    rebuild: () => void | Promise<void>;
    /** warn receives the notifier's non-fatal errors. */
    warn: (err: Error) => void;
    /** signal stops the loop once aborted. */
    signal?: AbortLike;
}

/**
 * runLoop serves signals from ntf until the signal aborts or ntf closes,
 * rebuilding once debounceMs passed without a further signal, so a burst
 * of writes costs one rebuild. Rebuilds never overlap: a signal arriving
 * during one starts a new debounce window once it returns, so the last
 * rebuild always follows the last change. Errors met during a rebuild are
 * delivered after it. A rebuild running when the loop stops completes
 * before runLoop resolves.
 */
export function runLoop(ntf: Notifier, opts: LoopOptions): Promise<void> {
    return new Promise<void>((resolve) => {
        let timer: TimerHandle | undefined;
        let rebuilding = false;
        let pending = false;
        let stopped = false;
        const queued: Error[] = [];
        let notifierErrs = 0;

        const finish = () => {
            clearTimer(timer);
            timer = undefined;
            opts.signal?.removeEventListener("abort", stop);
            resolve();
        };
        const stop = () => {
            if (stopped) return;
            stopped = true;
            if (!rebuilding) finish();
        };
        const arm = () => {
            clearTimer(timer);
            timer = setTimer(() => void fire(), opts.debounceMs);
        };
        const fire = async () => {
            timer = undefined;
            rebuilding = true;
            try {
                await opts.rebuild();
            } catch (err) {
                // rebuild reports its own failures; one escaping it is
                // warned rather than lost.
                queued.push(
                    err instanceof Error ? err : new Error(String(err)),
                );
            }
            rebuilding = false;
            notifierErrs = 0;
            for (const err of queued.splice(0)) opts.warn(err);
            if (stopped) return finish();
            if (pending) {
                pending = false;
                arm();
            }
        };

        if (opts.signal?.aborted) return resolve();
        opts.signal?.addEventListener("abort", stop, { once: true });
        ntf.listen({
            change: () => {
                if (stopped) return;
                if (rebuilding) pending = true;
                else arm();
            },
            error: (err) => {
                if (stopped) return;
                // Go's error channel holds ERR_BUFFER errors while a rebuild
                // blocks its reader, dropping the rest.
                if (!rebuilding) opts.warn(err);
                else if (notifierErrs++ < ERR_BUFFER) queued.push(err);
            },
            closed: stop,
        });
    });
}
