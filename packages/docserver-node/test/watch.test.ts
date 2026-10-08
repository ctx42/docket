// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { slashPath } from "../src/fs.ts";
import { FsNotifier, PENDING_MS, underDir } from "../src/watch.ts";

/** SETTLE bounds a wait proving nothing more arrives; TIMEOUT one that must. */
const SETTLE = 150;
const TIMEOUT = 5000;

let dir: string;
const open: FsNotifier[] = [];

beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "watch-"));
});

afterEach(() => {
    for (const ntf of open.splice(0)) ntf.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** Probe counts what a notifier delivers and waits for the next change. */
class Probe {
    changes = 0;
    errors: Error[] = [];
    closed = 0;
    private waiter: (() => void) | undefined;

    constructor(ntf: FsNotifier) {
        ntf.listen({
            change: () => {
                this.changes++;
                this.waiter?.();
            },
            error: (err) => this.errors.push(err),
            closed: () => {
                this.closed++;
            },
        });
    }

    /** received reports whether a change arrives within ms. */
    received(ms: number): Promise<boolean> {
        const before = this.changes;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.waiter = undefined;
                resolve(this.changes > before);
            }, ms);
            this.waiter = () => {
                clearTimeout(timer);
                this.waiter = undefined;
                resolve(true);
            };
        });
    }

    /** drain waits until no change arrives for the settle period. */
    async drain(): Promise<void> {
        while (await this.received(SETTLE)) {
            // keep draining
        }
    }
}

/** src returns the path of a source file of this package. */
function src(name: string): string {
    return new URL(`../src/${name}`, import.meta.url).pathname;
}

/** write writes content to name under base, creating parent directories. */
function write(base: string, name: string, content: string): string {
    const path = join(base, name);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, content);
    return path;
}

/** watching watches dirs and files, returning a drained probe. */
async function watching(dirs: string[], files: string[] = []): Promise<Probe> {
    const ntf = new FsNotifier(dirs, files);
    open.push(ntf);
    const probe = new Probe(ntf);
    await probe.drain();
    return probe;
}

describe("FsNotifier", () => {
    // go: Test_NewFS_error_missing_dir
    it("refuses a missing directory", () => {
        // --- Given ---
        const missing = join(dir, "absent");

        // --- When ---
        const have = () => new FsNotifier([missing]);

        // --- Then ---
        expect(have).toThrow(`watch ${missing}: no such file or directory`);
    });

    // go: Test_NewFS_error_missing_file_parent
    it("refuses a file source whose parent is missing", () => {
        // --- Given ---
        const file = join(dir, "absent", "a.md");

        // --- When ---
        const have = () => new FsNotifier([], [file]);

        // --- Then ---
        expect(have).toThrow(`watch ${file}: no such file or directory`);
    });

    // go: Test_FS_signals_tabular
    it.each([
        ["edit md", (d: string) => write(d, "a.md", "rewritten\n"), true],
        ["add md", (d: string) => write(d, "b.md", "new\n"), true],
        ["delete md", (d: string) => fs.rmSync(join(d, "a.md")), true],
        [
            "edit md in nested dir",
            (d: string) => write(d, "sub/deep/c.md", "rewritten\n"),
            true,
        ],
        [
            "remove nested dir",
            (d: string) => fs.rmSync(join(d, "sub"), { recursive: true }),
            true,
        ],
        [
            "non-md file",
            (d: string) => write(d, "notes.txt", "ignored\n"),
            false,
        ],
        [
            "chmod only",
            (d: string) => fs.chmodSync(join(d, "a.md"), 0o600),
            false,
        ],
    ])("%s", async (_name, change, want) => {
        // --- Given ---
        write(dir, "a.md", "alpha\n");
        write(dir, "sub/deep/c.md", "gamma\n");
        const probe = await watching([dir]);

        // --- When ---
        change(dir);

        // --- Then ---
        expect(await probe.received(want ? TIMEOUT : SETTLE)).toBe(want);
    });

    // go: Test_FS_watches_new_subdirectory
    it("watches a directory created later", async () => {
        // --- Given --- the new directory's own signal is drained.
        const probe = await watching([dir]);
        fs.mkdirSync(join(dir, "later"));
        expect(await probe.received(TIMEOUT)).toBe(true);
        await probe.drain();

        // --- When ---
        write(dir, "later/x.md", "new\n");

        // --- Then ---
        expect(await probe.received(TIMEOUT)).toBe(true);
    });

    // go: Test_FS_watches_replaced_root
    it("watches a replaced root", async () => {
        // --- Given --- a sync tool swaps the whole source directory.
        const root = join(dir, "docs");
        write(root, "a.md", "alpha\n");
        const probe = await watching([root]);
        const next = join(dir, "docs.new");
        write(next, "a.md", "beta\n");
        fs.renameSync(root, join(dir, "docs.old"));
        fs.renameSync(next, root);
        expect(await probe.received(TIMEOUT)).toBe(true);
        await probe.drain();

        // --- When ---
        write(root, "b.md", "gamma\n");

        // --- Then ---
        expect(await probe.received(TIMEOUT)).toBe(true);
    });

    // go: Test_FS_ignores_root_sibling
    it("ignores a sibling of the root", async () => {
        // --- Given ---
        const root = join(dir, "docs");
        fs.mkdirSync(root);
        const probe = await watching([root]);

        // --- When ---
        write(dir, "docs.md", "sibling\n");

        // --- Then ---
        expect(await probe.received(SETTLE)).toBe(false);
    });

    // go: Test_FS_file_source_tabular
    it.each([
        ["watched file", "arch.md", true],
        ["sibling file", "other.md", false],
    ])("signals a write to a %s: %s", async (_name, name, want) => {
        // --- Given ---
        const file = write(dir, "arch.md", "alpha\n");
        write(dir, "other.md", "beta\n");
        const probe = await watching([], [file]);

        // --- When ---
        write(dir, name, "rewritten\n");

        // --- Then ---
        expect(await probe.received(want ? TIMEOUT : SETTLE)).toBe(want);
    });

    // go: Test_FS_file_source_replaced_by_rename
    it("sees a file source replaced by rename", async () => {
        // --- Given ---
        const file = write(dir, "arch.md", "alpha\n");
        const tmp = write(dir, ".arch.md.tmp", "rewritten\n");
        const probe = await watching([], [file]);

        // --- When ---
        fs.renameSync(tmp, file);

        // --- Then ---
        expect(await probe.received(TIMEOUT)).toBe(true);
    });

    // go: Test_FS_Close
    it("closes once and delivers nothing after", async () => {
        // --- Given ---
        const ntf = new FsNotifier([dir]);
        const probe = new Probe(ntf);

        // --- When ---
        ntf.close();
        ntf.close();

        // --- Then ---
        expect(probe.closed).toBe(1);
        expect(ntf.size).toBe(0);
        write(dir, "late.md", "x\n");
        expect(await probe.received(SETTLE)).toBe(false);
    });

    it("ignores a chmod after an atomic save", async () => {
        // --- Given --- an editor saves by writing a temp file and renaming
        // it over the original; that save's signal is drained.
        write(dir, "a.md", "alpha\n");
        const probe = await watching([dir]);
        const tmp = write(dir, ".a.md.tmp", "beta\n");
        fs.renameSync(tmp, join(dir, "a.md"));
        expect(await probe.received(TIMEOUT)).toBe(true);
        await probe.drain();

        // --- When ---
        fs.chmodSync(join(dir, "a.md"), 0o600);

        // --- Then ---
        expect(await probe.received(SETTLE)).toBe(false);
    });

    it("stops watching a directory moved out of a source", async () => {
        // --- Given ---
        const root = join(dir, "docs");
        write(root, "sub/a.md", "alpha\n");
        const probe = await watching([root]);
        const before = (open[0] as FsNotifier).size;
        fs.renameSync(join(root, "sub"), join(dir, "moved"));
        expect(await probe.received(TIMEOUT)).toBe(true);
        await probe.drain();

        // --- When ---
        write(dir, "moved/x.md", "outside\n");

        // --- Then ---
        expect(await probe.received(SETTLE)).toBe(false);
        expect((open[0] as FsNotifier).size).toBe(before - 1);
    });

    it("releases the watchers of a removed directory", async () => {
        // --- Given ---
        write(dir, "sub/deep/c.md", "gamma\n");
        const probe = await watching([dir]);
        const before = (open[0] as FsNotifier).size;

        // --- When ---
        fs.rmSync(join(dir, "sub"), { recursive: true });

        // --- Then ---
        expect(await probe.received(TIMEOUT)).toBe(true);
        await probe.drain();
        expect((open[0] as FsNotifier).size).toBe(before - 2);
    });

    it("ignores a chmod of a file source", async () => {
        // --- Given ---
        const file = write(dir, "arch.md", "alpha\n");
        const probe = await watching([], [file]);

        // --- When ---
        fs.chmodSync(file, 0o600);

        // --- Then ---
        expect(await probe.received(SETTLE)).toBe(false);
    });

    it("signals a rename inside a source", async () => {
        // --- Given ---
        write(dir, "notes.txt", "x\n");
        const probe = await watching([dir]);

        // --- When ---
        fs.renameSync(join(dir, "notes.txt"), join(dir, "notes.bak"));

        // --- Then ---
        expect(await probe.received(TIMEOUT)).toBe(true);
    });

    it("signals a temp file renamed later over a Markdown file", async () => {
        // --- Given --- the temp file is seen before the rename.
        write(dir, "a.md", "alpha\n");
        const probe = await watching([dir]);
        const tmp = write(dir, ".a.md.tmp", "beta\n");
        expect(await probe.received(SETTLE)).toBe(false);

        // --- When ---
        fs.renameSync(tmp, join(dir, "a.md"));

        // --- Then ---
        expect(await probe.received(TIMEOUT)).toBe(true);
    });

    it("stays quiet for a lasting non-Markdown file", async () => {
        // --- Given ---
        const probe = await watching([dir]);

        // --- When ---
        write(dir, "notes.txt", "x\n");

        // --- Then ---
        expect(await probe.received(PENDING_MS + 2 * SETTLE)).toBe(false);
    });

    // Bun reports a rename only under the old name and can fold a temp
    // entry's creation and rename into one event, seen while it exists.
    it.each([
        [
            "a directory source",
            "[dir]",
            "[]",
            `await new NodeDocFs().writeAtomic(dir + "/a.md", "beta\\n", opts);`,
        ],
        [
            "a file source",
            "[]",
            "[dir + '/a.md']",
            `await new NodeDocFs().writeAtomic(dir + "/a.md", "beta\\n", opts);`,
        ],
        [
            "a directory source replaced by rename",
            "[dir + '/src']",
            "[]",
            `fs.mkdirSync(dir + "/.src.new");
            fs.rmSync(dir + "/src", { recursive: true });
            fs.renameSync(dir + "/.src.new", dir + "/src");
            await sleep(300);
            changes = 0;
            fs.writeFileSync(dir + "/src/b.md", "x");`,
        ],
    ])("signals an atomic save of %s under Bun", (_name, dirs, files, act) => {
        // --- Given ---
        write(dir, "a.md", "alpha\n");
        write(dir, "src/a.md", "alpha\n");
        const script = `
            import * as fs from "node:fs";
            import { NodeDocFs } from ${JSON.stringify(src("fs.ts"))};
            import { FsNotifier } from ${JSON.stringify(src("watch.ts"))};
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const dir = ${JSON.stringify(dir)};
            const opts = { mode: 0o644, tempPrefix: ".gap-", tempSuffix: ".tmp" };
            const ntf = new FsNotifier(${dirs}, ${files});
            let changes = 0;
            ntf.listen({ change: () => changes++, error() {}, closed() {} });
            await sleep(300);
            ${act}
            await sleep(500);
            ntf.close();
            console.log(changes > 0 ? "signalled" : "missed");
        `;

        // --- When ---
        const have = execFileSync("bun", ["-e", script], {
            encoding: "utf8",
            timeout: TIMEOUT,
        });

        // --- Then ---
        expect(have.trim()).toBe("signalled");
    });
});

describe("underDir", () => {
    // go: Test_underDir_tabular
    it.each([
        ["equal", "/a/b", "/a/b", true],
        ["child", "/a/b/c.md", "/a/b", true],
        ["sibling prefix", "/a/bc/d.md", "/a/b", false],
        ["parent", "/a", "/a/b", false],
        ["relative to absolute", "a/b", "/a/b", false],
    ])("%s", (_name, path, base, want) => {
        // --- When ---
        const have = underDir(path, base);

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("Windows paths", () => {
    it.each<[string, string, string, string]>([
        ["converts on Windows", "C:\\Vault\\docs", "win32", "C:/Vault/docs"],
        ["keeps a slash path", "C:/Vault/docs", "win32", "C:/Vault/docs"],
        ["leaves POSIX alone", "/v/a\\b", "linux", "/v/a\\b"],
    ])("slashPath %s", (_name, path, platform, want) => {
        // --- When ---
        const have = slashPath(path, platform);

        // --- Then ---
        expect(have).toBe(want);
    });

    it.each<[string, string, string, boolean]>([
        ["child", "C:/v/docs/a.md", "C:/v/docs", true],
        ["equal", "C:/v/docs", "C:/v/docs", true],
        ["sibling prefix", "C:/v/docs2/a.md", "C:/v/docs", false],
        ["other drive", "D:/v/docs/a.md", "C:/v/docs", false],
    ])("underDir %s", (_name, path, dir, want) => {
        // --- When ---
        const have = underDir(path, dir);

        // --- Then ---
        expect(have).toBe(want);
    });
});
