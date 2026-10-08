// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Timers for runtime-neutral code: every JS host has setTimeout, but the
// ES2022 library this package compiles against does not declare it. The
// globals are looked up at call time, so fake timers installed by a test
// apply.

/** TimerHandle is an opaque timer returned by {@link setTimer}. */
export type TimerHandle = { readonly __timer: unique symbol };

interface TimerGlobals {
    setTimeout(fn: () => void, ms: number): TimerHandle;
    clearTimeout(handle: TimerHandle | undefined): void;
}

/** setTimer runs fn once after ms milliseconds. */
export function setTimer(fn: () => void, ms: number): TimerHandle {
    return (globalThis as unknown as TimerGlobals).setTimeout(fn, ms);
}

/** clearTimer cancels a timer; undefined is ignored. */
export function clearTimer(handle: TimerHandle | undefined): void {
    (globalThis as unknown as TimerGlobals).clearTimeout(handle);
}
