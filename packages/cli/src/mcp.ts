// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// `docket mcp`: the documentation MCP server, ported from an earlier Go
// command. Flags parse as Go's flag package with ctx42/xflag short aliases
// does (single or double dash, `-c path` or `--config=path`), and failures
// print Go's texts: the flag error and the usage on stderr, then
// "error: <err>", exit code 1. It serves until the abort signal fires,
// which the entry point wires to SIGINT and SIGTERM — a clean exit.

import type { Readable, Writable } from "node:stream";

import { type LogWriter, run } from "@docket/docserver-node";

/** NAME is the server name in the version line. */
const NAME = "docket";

/** DEFAULT_CONFIG is the config path when -c is not given. */
export const DEFAULT_CONFIG = "docket-mcp.yaml";

/** MCP_USAGE is the command's usage, in Go's xflag layout. */
export const MCP_USAGE =
    "Usage: docket mcp [flags]\n" +
    "\n" +
    "  -c, --config     path to the config file: YAML, or a project-config.md note\n" +
    "      --stdio      serve a single client over stdio instead of HTTP\n" +
    "      --version    print version and exit\n";

/** McpCtx is what `docket mcp` runs against. */
export interface McpCtx {
    args: string[];
    stdout: LogWriter;
    stderr: LogWriter;
    /** stdin and stdoutStream serve the stdio transport. */
    stdin?: Readable;
    stdoutStream?: Writable;
    /** signal stops the server; an abort is a clean exit. */
    signal?: AbortSignal;
    version: string;
}

/** McpFlags are the parsed flags. */
export interface McpFlags {
    config: string;
    stdio: boolean;
    version: boolean;
    help: boolean;
}

/** FlagError is a flag Go's flag package refuses. */
export class FlagError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FlagError";
    }
}

/**
 * parseMcpFlags parses args as Go's flag package does: flags stop at the
 * first non-flag or a bare "--"; a flag takes one or two dashes; a string
 * flag takes "=value" or the next argument.
 */
export function parseMcpFlags(args: readonly string[]): McpFlags {
    const out: McpFlags = {
        config: DEFAULT_CONFIG,
        stdio: false,
        version: false,
        help: false,
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] as string;
        if (arg === "--" || !arg.startsWith("-") || arg === "-") break;
        const body = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
        if (body === "" || body.startsWith("-") || body.startsWith("=")) {
            throw new FlagError(`bad flag syntax: ${arg}`);
        }
        const eq = body.indexOf("=");
        const name = eq < 0 ? body : body.slice(0, eq);
        const value = eq < 0 ? undefined : body.slice(eq + 1);
        switch (name) {
            case "c":
            case "config": {
                if (value !== undefined) {
                    out.config = value;
                } else if (i + 1 < args.length) {
                    out.config = args[++i] as string;
                } else {
                    throw new FlagError(`flag needs an argument: -${name}`);
                }
                break;
            }
            case "stdio":
            case "version":
                out[name] = boolValue(name, value);
                break;
            case "h":
            case "help":
                out.help = true;
                return out;
            default:
                throw new FlagError(`flag provided but not defined: -${name}`);
        }
    }
    return out;
}

/** boolValue parses a boolean flag's optional value as strconv.ParseBool. */
function boolValue(name: string, value: string | undefined): boolean {
    if (value === undefined) return true;
    if (["1", "t", "T", "TRUE", "true", "True"].includes(value)) return true;
    if (["0", "f", "F", "FALSE", "false", "False"].includes(value))
        return false;
    throw new FlagError(
        `invalid boolean value "${value}" for -${name}: parse error`,
    );
}

/**
 * runMcp runs `docket mcp` and returns the process exit code: 0 on success,
 * a clean shutdown, help or the version; 1 on any failure.
 */
export async function runMcp(ctx: McpCtx): Promise<number> {
    let flags: McpFlags;
    try {
        flags = parseMcpFlags(ctx.args);
    } catch (err) {
        const msg = (err as Error).message;
        ctx.stderr.write(`${msg}\n${MCP_USAGE}`);
        ctx.stderr.write(`error: ${msg}\n`);
        return 1;
    }
    if (flags.help) {
        ctx.stderr.write(MCP_USAGE);
        return 0;
    }
    if (flags.version) {
        ctx.stdout.write(`${NAME} ${ctx.version}\n`);
        return 0;
    }
    try {
        await run({
            config: flags.config,
            stdio: flags.stdio,
            version: ctx.version,
            stderr: ctx.stderr,
            ...(ctx.stdin === undefined ? {} : { stdin: ctx.stdin }),
            ...(ctx.stdoutStream === undefined
                ? {}
                : { stdout: ctx.stdoutStream }),
            ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        });
    } catch (err) {
        ctx.stderr.write(`error: ${(err as Error).message}\n`);
        return 1;
    }
    return 0;
}
