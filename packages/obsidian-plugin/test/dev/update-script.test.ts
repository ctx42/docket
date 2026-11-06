// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// dev/update.sh against stub bun and obsidian commands, in a throwaway repo
// layout: nothing is built, and no real vault or Obsidian is touched.

import { execFileSync, spawnSync } from "node:child_process";
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** SCRIPT is the real script; each test runs a copy of it. */
const SCRIPT = fileURLToPath(
    new URL("../../../../dev/update.sh", import.meta.url),
);

/** TOOLS are the host commands the script needs from its restricted PATH. */
const TOOLS = ["bash", "env", "dirname", "basename", "grep"];

/** ENABLED is what `obsidian plugin` prints for an enabled plugin. */
const ENABLED = "type\tcommunity\nname\tdocket\nenabled\ttrue";

/** RunOptions are the inputs of one script run. */
interface RunOptions {
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
}

describe("dev/update.sh", () => {
    let root: string;
    let bin: string;
    let log: string;

    /** stub writes an executable shell script to path. */
    async function stub(path: string, body: string): Promise<void> {
        await writeFile(path, `#!/bin/sh\n${body}\n`);
        await chmod(path, 0o755);
    }

    /** stubObsidian installs an obsidian command on the script's PATH. */
    async function stubObsidian(): Promise<void> {
        await stub(
            join(bin, "obsidian"),
            [
                'echo "obsidian $*" >> "$LOG"',
                'case "$*" in *" plugin id="*) echo "$OBSIDIAN_INFO" ;; esac',
            ].join("\n"),
        );
    }

    /** run executes the copied script on a PATH of stubs and listed tools. */
    function run(opts: RunOptions = {}) {
        return spawnSync(join(root, "dev/update.sh"), opts.args ?? [], {
            cwd: opts.cwd ?? root,
            encoding: "utf8",
            env: {
                PATH: bin,
                INSTALL_EXIT: "0",
                LOG: log,
                OBSIDIAN_INFO: ENABLED,
                ...opts.env,
            },
        });
    }

    /** calls returns the logged commands, one per line. */
    async function calls(): Promise<string[]> {
        const text = await readFile(log, "utf8").catch(() => "");
        return text.split("\n").filter((line) => line !== "");
    }

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "docket-update-"));
        bin = join(root, "bin");
        log = join(root, "calls.log");
        await mkdir(join(root, "dev"));
        await mkdir(join(root, "scripts"));
        await mkdir(bin);
        await copyFile(SCRIPT, join(root, "dev/update.sh"));
        await stub(
            join(root, "scripts/install.sh"),
            'echo install >> "$LOG"\nexit "$INSTALL_EXIT"',
        );
        await stub(join(bin, "bun"), 'echo "bun $*" >> "$LOG"');
        for (const tool of TOOLS) {
            const path = execFileSync("sh", ["-c", `command -v ${tool}`], {
                encoding: "utf8",
            }).trim();
            await symlink(path, join(bin, tool));
        }
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("builds, deploys, and reloads the plugin in the vault", async () => {
        // --- Given ---
        const vault = join(root, "my vault");
        await mkdir(vault);
        await stubObsidian();

        // --- When ---
        const have = run({ args: [vault] });

        // --- Then ---
        expect(have.status).toBe(0);
        expect(have.stdout).toContain(
            "update: reloaded ctx42-docket in my vault",
        );
        expect(await calls()).toEqual([
            "install",
            `bun run deploy:plugin ${vault} --link`,
            "obsidian vault=my vault plugin:disable id=ctx42-docket",
            "obsidian vault=my vault plugin:enable id=ctx42-docket",
            "obsidian vault=my vault plugin id=ctx42-docket",
        ]);
    });

    it("takes the vault from DOCKET_VAULT", async () => {
        // --- Given ---
        const vault = join(root, "notes");
        await mkdir(vault);
        await stubObsidian();

        // --- When ---
        const have = run({ env: { DOCKET_VAULT: vault } });

        // --- Then ---
        expect(have.status).toBe(0);
        expect(await calls()).toContain(
            `bun run deploy:plugin ${vault} --link`,
        );
    });

    it("resolves a relative vault path from the caller's directory", async () => {
        // --- Given ---
        const vault = join(root, "notes");
        await mkdir(vault);
        await stubObsidian();

        // --- When ---
        const have = run({ args: ["notes/"], cwd: root });

        // --- Then ---
        expect(have.status).toBe(0);
        const want = [
            `bun run deploy:plugin ${vault} --link`,
            "obsidian vault=notes plugin:disable id=ctx42-docket",
        ];
        expect(await calls()).toEqual(expect.arrayContaining(want));
    });

    it("refuses to run without a vault", async () => {
        // --- When ---
        const have = run();

        // --- Then ---
        expect(have.status).toBe(2);
        expect(have.stderr).toContain("usage:");
        expect(await calls()).toEqual([]);
    });

    it("refuses a vault path that is not a directory", async () => {
        // --- When ---
        const have = run({ args: [join(root, "missing")] });

        // --- Then ---
        expect(have.status).toBe(1);
        expect(have.stderr).toContain("not a directory");
        expect(await calls()).toEqual([]);
    });

    it("stops before Obsidian when the build fails", async () => {
        // --- Given ---
        const vault = join(root, "notes");
        await mkdir(vault);
        await stubObsidian();

        // --- When ---
        const have = run({ args: [vault], env: { INSTALL_EXIT: "1" } });

        // --- Then ---
        expect(have.status).toBe(1);
        expect(await calls()).toEqual(["install"]);
    });

    it("asks for a manual reload without the obsidian command", async () => {
        // --- Given ---
        const vault = join(root, "notes");
        await mkdir(vault);

        // --- When ---
        const have = run({ args: [vault] });

        // --- Then ---
        expect(have.status).toBe(0);
        expect(have.stderr).toContain("obsidian command not found");
        expect(have.stdout).not.toContain("update: reloaded");
    });

    it("reports a failed reload the CLI exits 0 for", async () => {
        // --- Given ---
        const vault = join(root, "notes");
        await mkdir(vault);
        await stubObsidian();

        // --- When ---
        const have = run({
            args: [vault],
            env: { OBSIDIAN_INFO: "Vault not found." },
        });

        // --- Then ---
        expect(have.status).toBe(0);
        expect(have.stderr).toContain("could not reload ctx42-docket");
        expect(have.stderr).toContain("Vault not found.");
        expect(have.stdout).not.toContain("update: reloaded");
    });
});
