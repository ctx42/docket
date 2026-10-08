// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

/**
 * Executable entry point for the docket CLI (← `cmd/docket/main.go`). It wires
 * the Node adapters — process streams, environment, filesystem, system clock, and
 * an interactive line reader — into {@link main} and exits with its return code.
 * Bundled to a single binary via `bun build --compile`.
 *
 * Kept side-effect-only: tests import `./main.ts` with their own injected context,
 * never this file, so importing the package never runs the process.
 */
import { nodeClock } from "./adapters/clock.ts";
import { NodeEnv } from "./adapters/env.ts";
import { NodeFS } from "./adapters/fs.ts";
import { nodeStreams } from "./adapters/streams.ts";
import { EXIT_ERR, main } from "./main.ts";
import { nodeAsk } from "./prompt.ts";
import { nodeKeys } from "./select.ts";

// SIGINT and SIGTERM stop `docket mcp` cleanly; the other commands keep the
// default handling, so a signal still interrupts them.
const stop = new AbortController();
if (process.argv[2] === "mcp") {
    process.once("SIGINT", () => stop.abort());
    process.once("SIGTERM", () => stop.abort());
}

main({
    argv: process.argv.slice(2),
    mcp: { stdin: process.stdin, stdout: process.stdout, signal: stop.signal },
    streams: nodeStreams,
    env: new NodeEnv(process.env),
    fs: new NodeFS(),
    clock: nodeClock,
    // The reporter writes to stderr; the confirmation prompt reads stdin. Track
    // each stream's terminal status separately so redirecting one does not
    // mis-gate the other (a piped stdin must never trigger an interactive prompt).
    isTTY: Boolean(process.stderr.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    ask: nodeAsk,
    keys: nodeKeys,
})
    .then((code) => {
        // Set the exit code instead of calling process.exit(): an abrupt exit
        // truncates buffered stdout writes to a pipe or file (the StreamWriter
        // ignores backpressure), losing the tail of a large log or summary. The
        // process exits with this code once the event loop drains the streams.
        process.exitCode = code;
    })
    .catch((err: unknown) => {
        // A rejection escaping main (e.g. reporter/adapter construction) would
        // otherwise surface as an unhandled rejection; report it like any other.
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`docket: ${message}\n`);
        process.exitCode = EXIT_ERR;
    });
