// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock, Streams } from "@docket/core";
import { describe, expect, it } from "vitest";

import { MemFS } from "../../core/test/support/memfs.ts";
import { NodeEnv } from "../src/adapters/env.ts";
import { EXIT_ERR, EXIT_OK, type MainCtx, main } from "../src/main.ts";
import {
    DEFAULT_CONFIG,
    FlagError,
    MCP_USAGE,
    parseMcpFlags,
    runMcp,
} from "../src/mcp.ts";
import { VERSION } from "../src/version.ts";

/** capture builds a Streams whose output is inspectable. */
function capture(): Streams & { outText(): string; errText(): string } {
    let out = "";
    let err = "";
    return {
        stdin: { readAll: () => "" },
        stdout: { write: (t) => (out += t) },
        stderr: { write: (t) => (err += t) },
        outText: () => out,
        errText: () => err,
    };
}

const clock: Clock = () => new Date(1_000_000);

/** mainCtx builds a MainCtx running argv. */
function mainCtx(argv: string[]): {
    ctx: MainCtx;
    streams: ReturnType<typeof capture>;
} {
    const streams = capture();
    const ctx: MainCtx = {
        argv,
        streams,
        env: new NodeEnv({}),
        fs: new MemFS(),
        clock,
        isTTY: false,
        ask: () => Promise.resolve(""),
    };
    return { ctx, streams };
}

describe("docket mcp", () => {
    // go: Test_Main_version_returns_ok
    it("prints the version", async () => {
        // --- Given ---
        const { ctx, streams } = mainCtx(["mcp", "--version"]);

        // --- When ---
        const have = await main(ctx);

        // --- Then ---
        expect(have).toBe(EXIT_OK);
        expect(streams.outText()).toBe(`docket ${VERSION}\n`);
        expect(streams.errText()).toBe("");
    });

    // go: Test_Main_error_returns_exit_err
    it("fails with error: and exit 1", async () => {
        // --- Given ---
        const dir = nodeFs.mkdtempSync(join(tmpdir(), "docket-mcp-"));
        const { ctx, streams } = mainCtx(["mcp", "-c", join(dir, "no.yaml")]);

        // --- When ---
        const have = await main(ctx);

        // --- Then ---
        expect(have).toBe(EXIT_ERR);
        expect(streams.errText()).toContain("error: read config: open ");
        nodeFs.rmSync(dir, { recursive: true, force: true });
    });

    // go: Test_run_help_is_not_an_error
    it("prints the usage for --help", async () => {
        // --- Given ---
        const { ctx, streams } = mainCtx(["mcp", "--help"]);

        // --- When ---
        const have = await main(ctx);

        // --- Then ---
        expect(have).toBe(EXIT_OK);
        expect(streams.errText()).toContain("-c, --config");
        expect(streams.errText()).toBe(MCP_USAGE);
    });

    // go: Test_run_error_unknown_flag
    it("refuses an unknown flag", async () => {
        // --- Given ---
        const { ctx, streams } = mainCtx(["mcp", "--no-such-flag"]);

        // --- When ---
        const have = await main(ctx);

        // --- Then ---
        expect(have).toBe(EXIT_ERR);
        expect(streams.errText()).toBe(
            "flag provided but not defined: -no-such-flag\n" +
                MCP_USAGE +
                "error: flag provided but not defined: -no-such-flag\n",
        );
    });

    it("lists mcp in the help and documents it", async () => {
        // --- Given ---
        const top = mainCtx(["help"]);
        const cmd = mainCtx(["help", "mcp"]);

        // --- When ---
        await main(top.ctx);
        const have = await main(cmd.ctx);

        // --- Then ---
        expect(top.streams.outText()).toContain("  mcp       Serve the");
        expect(have).toBe(EXIT_OK);
        expect(cmd.streams.outText()).toBe(MCP_USAGE);
    });

    it("serves until its signal aborts", async () => {
        // --- Given --- a stdio server over an empty corpus.
        const dir = nodeFs.mkdtempSync(join(tmpdir(), "docket-mcp-"));
        nodeFs.mkdirSync(join(dir, "docs"));
        const cfg = join(dir, "c.yaml");
        nodeFs.writeFileSync(
            cfg,
            `sources:\n  d:\n    dir: ${join(dir, "docs")}\n`,
        );
        const { PassThrough } = await import("node:stream");
        const ctl = new AbortController();
        const err: string[] = [];
        const served = runMcp({
            args: ["-c", cfg, "--stdio"],
            stdout: { write: () => {} },
            stderr: { write: (t: string) => err.push(t) },
            stdin: new PassThrough(),
            stdoutStream: new PassThrough(),
            signal: ctl.signal,
            version: VERSION,
        });

        // --- When ---
        await new Promise((resolve) => setTimeout(resolve, 100));
        ctl.abort();

        // --- Then ---
        expect(await served).toBe(EXIT_OK);
        expect(err.join("")).toContain("indexed 0 documents in ");
        nodeFs.rmSync(dir, { recursive: true, force: true });
    });
});

describe("parseMcpFlags", () => {
    it.each([
        [
            [],
            {
                config: DEFAULT_CONFIG,
                stdio: false,
                version: false,
                help: false,
            },
        ],
        [
            ["-c", "a.yaml"],
            { config: "a.yaml", stdio: false, version: false, help: false },
        ],
        [
            ["--config=b.md", "--stdio"],
            { config: "b.md", stdio: true, version: false, help: false },
        ],
        [
            ["-config", "c", "-stdio=false"],
            { config: "c", stdio: false, version: false, help: false },
        ],
        [
            ["-h"],
            {
                config: DEFAULT_CONFIG,
                stdio: false,
                version: false,
                help: true,
            },
        ],
        [
            ["--stdio", "rest", "--nope"],
            {
                config: DEFAULT_CONFIG,
                stdio: true,
                version: false,
                help: false,
            },
        ],
        [
            ["--", "--nope"],
            {
                config: DEFAULT_CONFIG,
                stdio: false,
                version: false,
                help: false,
            },
        ],
    ])("parses %j", (args, want) => {
        expect(parseMcpFlags(args)).toEqual(want);
    });

    it.each([
        [["-c"], "flag needs an argument: -c"],
        [
            ["--stdio=maybe"],
            'invalid boolean value "maybe" for -stdio: parse error',
        ],
        [["---x"], "bad flag syntax: ---x"],
        [["-=x"], "bad flag syntax: -=x"],
    ])("refuses %j", (args, want) => {
        expect(() => parseMcpFlags(args)).toThrow(new FlagError(want));
    });
});
