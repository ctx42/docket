// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// An async mutual-exclusion lock: the single-threaded stand-in for the Go
// mutexes that serialize engine reloads and gap-store operations across
// awaits.

/** Mutex runs critical sections one at a time, in call order. */
export class Mutex {
    private tail: Promise<void> = Promise.resolve();

    /** run waits for the lock, runs fn, and releases the lock. */
    run<T>(fn: () => T | Promise<T>): Promise<T> {
        const result = this.tail.then(fn);
        this.tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }
}
