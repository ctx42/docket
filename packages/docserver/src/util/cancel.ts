// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Cancellation for operations Go runs under a context.Context: an operation
// takes an optional signal and stops before its work once it is aborted.

/** Signal is the part of an `AbortSignal` cancellation needs. */
export interface Signal {
    readonly aborted: boolean;
}

/** CanceledError is Go's `context.Canceled`. */
export class CanceledError extends Error {
    constructor() {
        super("context canceled");
        this.name = "CanceledError";
    }
}

/** checkSignal throws a {@link CanceledError} once signal is aborted. */
export function checkSignal(signal: Signal | undefined): void {
    if (signal?.aborted === true) throw new CanceledError();
}

/**
 * AbortLike is the part of an `AbortSignal` a long-running loop needs to
 * stop when it aborts.
 */
export interface AbortLike extends Signal {
    addEventListener(
        type: "abort",
        fn: () => void,
        opts?: { once?: boolean },
    ): void;
    removeEventListener(type: "abort", fn: () => void): void;
}
