// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DocFsError } from "@docket/docserver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeDocFs, toDocFsError } from "../src/fs.ts";

/** ROOT skips permission tests: root ignores mode bits. */
const ROOT = process.getuid?.() === 0;

const OPTS = { mode: 0o644, tempPrefix: ".gap-", tempSuffix: ".tmp" };

let dir: string;
const nfs = new NodeDocFs();

beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "docfs-")));
});

afterEach(() => {
    for (const p of [dir, join(dir, "ro")]) {
        if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, data: string, mode = 0o644): string {
    const p = join(dir, name);
    fs.mkdirSync(join(p, ".."), { recursive: true });
    fs.writeFileSync(p, data, { mode });
    return p;
}

describe("NodeDocFs reads", () => {
    it("reads text and bytes", async () => {
        const p = write("a.md", "Zażółć");

        expect(await nfs.readText(p)).toBe("Zażółć");
        expect([...(await nfs.readBytes(p))]).toEqual([
            ...Buffer.from("Zażółć"),
        ]);
    });

    it("fails like Go", async () => {
        await expect(nfs.readText(join(dir, "zz"))).rejects.toThrow(
            `open ${dir}/zz: no such file or directory`,
        );
        await expect(nfs.readBytes(dir)).rejects.toThrow(
            `read ${dir}: is a directory`,
        );
    });

    it("keeps a non-errno failure's message", async () => {
        const have = nfs.readText(join(dir, "a\0b"));

        await expect(have).rejects.toMatchObject({ code: "EIO", op: "open" });
    });
});

describe("NodeDocFs stat, lstat and readdir", () => {
    it("classifies files, directories and a dangling symlink", async () => {
        const f = write("sub/b.md", "beta", 0o600);
        fs.symlinkSync("nope.md", join(dir, "dangling.md"));
        fs.symlinkSync("sub", join(dir, "dirlink"));

        expect(await nfs.stat(f)).toMatchObject({
            isFile: true,
            isDir: false,
            isSymlink: false,
            size: 4,
            mode: 0o600,
        });
        expect(await nfs.stat(join(dir, "dirlink"))).toMatchObject({
            isDir: true,
        });
        expect(await nfs.lstat(join(dir, "dangling.md"))).toMatchObject({
            isSymlink: true,
            isFile: false,
        });
        await expect(nfs.stat(join(dir, "dangling.md"))).rejects.toThrow(
            `stat ${dir}/dangling.md: no such file or directory`,
        );
        await expect(nfs.lstat(join(dir, "zz"))).rejects.toThrow(
            `lstat ${dir}/zz: no such file or directory`,
        );
    });

    it("lists entries sorted by name bytes with unfollowed kinds", async () => {
        write("b.md", "");
        write("Z.md", "");
        write("é.md", "");
        fs.mkdirSync(join(dir, "sub"));
        fs.symlinkSync("b.md", join(dir, "link"));

        const have = await nfs.readdir(dir);

        expect(have).toEqual([
            { name: "Z.md", kind: "file" },
            { name: "b.md", kind: "file" },
            { name: "link", kind: "symlink" },
            { name: "sub", kind: "dir" },
            { name: "é.md", kind: "file" },
        ]);
    });

    it("reports a special file as other", async () => {
        try {
            execFileSync("mkfifo", [join(dir, "fifo")]);
        } catch {
            return; // no mkfifo on this system
        }

        const have = await nfs.readdir(dir);

        expect(have).toEqual([{ name: "fifo", kind: "other" }]);
    });

    it("fails listing like Go", async () => {
        const f = write("a.md", "");

        await expect(nfs.readdir(join(dir, "zz"))).rejects.toThrow(
            `open ${dir}/zz: no such file or directory`,
        );
        await expect(nfs.readdir(f)).rejects.toThrow(
            `open ${f}: not a directory`,
        );
    });
});

describe("NodeDocFs realpath", () => {
    it("resolves relative and absolute symlinks", async () => {
        write("sub/b.md", "");
        fs.symlinkSync(join(dir, "sub"), join(dir, "abs"));
        fs.mkdirSync(join(dir, "x"));
        fs.symlinkSync("../abs/b.md", join(dir, "x", "rel.md"));

        expect(await nfs.realpath(join(dir, "x", "rel.md"))).toBe(
            join(dir, "sub", "b.md"),
        );
        expect(await nfs.realpath(`${dir}//sub/./b.md`)).toBe(
            join(dir, "sub", "b.md"),
        );
    });

    it("names the missing resolved path and stops a loop", async () => {
        fs.symlinkSync("nope.md", join(dir, "dangling.md"));
        fs.symlinkSync("loop2", join(dir, "loop1"));
        fs.symlinkSync("loop1", join(dir, "loop2"));

        await expect(nfs.realpath(join(dir, "dangling.md"))).rejects.toThrow(
            `lstat ${dir}/nope.md: no such file or directory`,
        );
        await expect(nfs.realpath(join(dir, "loop1"))).rejects.toThrow(
            "too many levels of symbolic links",
        );
    });
});

describe("NodeDocFs writeAtomic", () => {
    it("creates a file with the given mode and leaves no temp file", async () => {
        const p = join(dir, "new.md");

        await nfs.writeAtomic(p, "fresh", OPTS);

        expect(fs.readFileSync(p, "utf8")).toBe("fresh");
        expect(fs.statSync(p).mode & 0o777).toBe(0o644);
        expect(fs.readdirSync(dir)).toEqual(["new.md"]);
    });

    it("keeps mode 0600 across a rewrite", async () => {
        const p = write("gap.md", "old", 0o600);
        const mode = (await nfs.stat(p)).mode;

        await nfs.writeAtomic(p, Uint8Array.from(Buffer.from("new")), {
            ...OPTS,
            mode,
        });

        expect(fs.readFileSync(p, "utf8")).toBe("new");
        expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    });

    it("changes the nanosecond mtime", async () => {
        const p = write("gap.md", "old");
        // Kernel timestamps tick coarsely; backdate so the write must differ.
        fs.utimesSync(p, 1_000_000, 1_000_000.123456);
        const before = (await nfs.stat(p)).mtimeNs;

        await nfs.writeAtomic(p, "new", OPTS);

        expect((await nfs.stat(p)).mtimeNs).not.toBe(before);
    });

    it("fails at the create stage in a missing directory", async () => {
        const have = nfs.writeAtomic(join(dir, "zz", "a.md"), "x", OPTS);

        await expect(have).rejects.toMatchObject({
            code: "ENOENT",
            stage: "create",
        });
        await expect(
            nfs.writeAtomic(join(dir, "zz", "a.md"), "x", OPTS),
        ).rejects.toThrow(
            new RegExp(
                `^open ${dir}/zz/\\.gap-\\d+\\.tmp: no such file or directory$`,
            ),
        );
    });

    it.skipIf(ROOT)(
        "fails at the create stage in a read-only directory",
        async () => {
            const p = write("ro/gap.md", "old");
            fs.chmodSync(join(dir, "ro"), 0o555);

            const have = nfs.writeAtomic(p, "new", OPTS);

            await expect(have).rejects.toMatchObject({
                code: "EACCES",
                stage: "create",
            });
            expect(fs.readFileSync(p, "utf8")).toBe("old");
        },
    );

    it("fails at the rename stage and removes the temp file", async () => {
        write("target/inner", "");

        const have = nfs.writeAtomic(join(dir, "target"), "x", OPTS);

        await expect(have).rejects.toMatchObject({
            stage: "rename",
            op: "rename",
        });
        await expect(
            nfs.writeAtomic(join(dir, "target"), "x", OPTS),
        ).rejects.toThrow(
            new RegExp(`^rename ${dir}/\\.gap-\\d+\\.tmp ${dir}/target: `),
        );
        expect(fs.readdirSync(dir)).toEqual(["target"]);
    });
});

describe("NodeDocFs rename", () => {
    it("moves a file", async () => {
        const p = write("a.md", "x");
        fs.mkdirSync(join(dir, "closed"));

        await nfs.rename(p, join(dir, "closed", "a.md"));

        expect(fs.existsSync(p)).toBe(false);
        expect(fs.readFileSync(join(dir, "closed", "a.md"), "utf8")).toBe("x");
    });

    it("refuses an existing target, even a dangling symlink", async () => {
        const a = write("a.md", "a");
        const b = write("b.md", "b");
        fs.symlinkSync("nope", join(dir, "dangling"));

        await expect(nfs.rename(a, b)).rejects.toThrow(
            `rename ${a} ${b}: file exists`,
        );
        await expect(nfs.rename(a, join(dir, "dangling"))).rejects.toThrow(
            "file exists",
        );
        expect(fs.readFileSync(b, "utf8")).toBe("b");
    });

    it("fails like Go", async () => {
        const a = write("a.md", "a");

        await expect(
            nfs.rename(join(dir, "zz"), join(dir, "x")),
        ).rejects.toThrow(
            `rename ${dir}/zz ${dir}/x: no such file or directory`,
        );
        await expect(nfs.rename(join(dir, "zz"), join(a, "x"))).rejects.toThrow(
            `rename ${dir}/zz ${a}/x: not a directory`,
        );
    });
});

describe("NodeDocFs remove", () => {
    it("removes a file and an empty directory", async () => {
        const p = write("a.md", "");
        fs.mkdirSync(join(dir, "empty"));

        await nfs.remove(p);
        await nfs.remove(join(dir, "empty"));

        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("fails like Go", async () => {
        write("sub/a", "");

        await expect(nfs.remove(join(dir, "zz"))).rejects.toThrow(
            `remove ${dir}/zz: no such file or directory`,
        );
        await expect(nfs.remove(join(dir, "sub"))).rejects.toThrow(
            `remove ${dir}/sub: directory not empty`,
        );
    });

    it.skipIf(ROOT)(
        "reports the unlink error for a file in a read-only dir",
        async () => {
            const p = write("ro/a.md", "");
            fs.chmodSync(join(dir, "ro"), 0o555);

            await expect(nfs.remove(p)).rejects.toThrow(
                `remove ${p}: permission denied`,
            );
        },
    );
});

describe("NodeDocFs mkdir and syncDir", () => {
    it("creates one directory and syncs it", async () => {
        const p = join(dir, "closed");

        await nfs.mkdir(p, 0o755);
        await nfs.syncDir(p);

        expect(fs.statSync(p).isDirectory()).toBe(true);
    });

    it("fails like Go", async () => {
        await expect(nfs.mkdir(dir, 0o755)).rejects.toThrow(
            `mkdir ${dir}: file exists`,
        );
        await expect(nfs.syncDir(join(dir, "zz"))).rejects.toThrow(
            `open ${dir}/zz: no such file or directory`,
        );
    });
});

describe("NodeDocFs probeWritable", () => {
    it("accepts a writable directory and leaves nothing behind", async () => {
        await nfs.probeWritable(dir, ".gaps-check-");

        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("fails on a missing directory", async () => {
        await expect(
            nfs.probeWritable(join(dir, "zz"), ".gaps-check-"),
        ).rejects.toThrow(
            new RegExp(
                `^open ${dir}/zz/\\.gaps-check-\\d+: no such file or directory$`,
            ),
        );
    });

    it.skipIf(ROOT)("fails on a read-only directory", async () => {
        fs.mkdirSync(join(dir, "ro"));
        fs.chmodSync(join(dir, "ro"), 0o555);

        await expect(
            nfs.probeWritable(join(dir, "ro"), ".gaps-check-"),
        ).rejects.toThrow(/permission denied$/);
    });
});

describe("toDocFsError", () => {
    it("keeps errno codes and wraps anything else as EIO", () => {
        const errno = Object.assign(new Error("x"), { code: "ENOENT" });

        expect(toDocFsError(errno, "stat", "/a").message).toBe(
            "stat /a: no such file or directory",
        );
        expect(toDocFsError(new Error("boom"), "open", "/a").message).toBe(
            "open /a: boom",
        );
        expect(toDocFsError("odd", "open", "/a", "/b", "rename")).toMatchObject(
            {
                code: "EIO",
                message: "open /a /b: odd",
                stage: "rename",
            },
        );
        expect(toDocFsError(null, "open", "/a")).toBeInstanceOf(DocFsError);
    });
});
