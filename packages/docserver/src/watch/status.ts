// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// How current the search index is: when it was last built, whether a source
// changed since, and how the last rebuild went. The host feeds it the
// watcher's change signals and runs every rebuild through it, so a client
// can ask whether a file it just wrote is searchable yet, or rebuild now.

import { CloseReplacedError } from "../engine/engine.ts";

/** Reindexable is the part of the engine the tracker rebuilds and reads. */
export interface Reindexable {
    reload(): Promise<void>;
    listDocs(): readonly unknown[];
    generation(): number;
}

/** IndexState is how current the index is. */
export interface IndexState {
    /** generation counts the rebuilds since start, 0 for the first index. */
    generation: number;
    /** indexedAt is when the serving index was built, as an ISO 8601 time. */
    indexedAt: string;
    /** docs is the number of indexed documents. */
    docs: number;
    /** watching tells whether the server rebuilds on source changes. */
    watching: boolean;
    /** pending tells whether a source changed since the last rebuild began. */
    pending: boolean;
    /** lastError is why the last rebuild failed, "" when it did not. */
    lastError: string;
}

/** ReindexResult is the outcome of one {@link IndexTracker.reindex}. */
export interface ReindexResult {
    /** ok tells whether the new index is serving. */
    ok: boolean;
    /** docs is the number of documents now indexed. */
    docs: number;
    /**
     * warning is why a rebuild failed, or, for one that is serving, why the
     * replaced index could not be closed; "" otherwise.
     */
    warning: string;
}

/** IndexTracker records how current the index is and rebuilds it. */
export class IndexTracker {
    private builtAt: number;
    private signals = 0;
    private seenAt = 0;
    private lastError = "";

    /**
     * constructor tracks idx, built just now by the clock now (milliseconds
     * since the epoch); watching tells whether source changes are watched.
     */
    constructor(
        private readonly idx: Reindexable,
        private readonly now: () => number,
        private readonly watching: boolean,
    ) {
        this.builtAt = now();
    }

    /** signal records that a source changed. */
    signal(): void {
        this.signals++;
    }

    /**
     * reindex rebuilds the index. A change signalled while it runs stays
     * pending; a failed rebuild keeps the old index serving, its changes
     * pending, and its error as the last error.
     */
    async reindex(): Promise<ReindexResult> {
        const seen = this.signals;
        let warning = "";
        try {
            await this.idx.reload();
        } catch (err) {
            if (!(err instanceof CloseReplacedError)) {
                this.lastError = (err as Error).message;
                return {
                    ok: false,
                    docs: this.docs(),
                    warning: this.lastError,
                };
            }
            warning = err.message;
        }
        this.builtAt = this.now();
        this.seenAt = seen;
        this.lastError = "";
        return { ok: true, docs: this.docs(), warning };
    }

    /** state reports how current the index is. */
    state(): IndexState {
        return {
            generation: this.idx.generation(),
            indexedAt: new Date(this.builtAt).toISOString(),
            docs: this.docs(),
            watching: this.watching,
            pending: this.signals > this.seenAt,
            lastError: this.lastError,
        };
    }

    private docs(): number {
        return this.idx.listDocs().length;
    }
}
