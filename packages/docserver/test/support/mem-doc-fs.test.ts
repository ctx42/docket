// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { DocFsError } from "../../src/ports.ts";
import { MemDocFs } from "./mem-doc-fs.ts";

const OPTS = { mode: 0o644, tempPrefix: ".gap-", tempSuffix: ".tmp" };

/** fixture builds a small tree: /w/a.md, /w/sub/b.md, links. */
function fixture(): MemDocFs {
    return new MemDocFs()
        .writeFile("/w/a.md", "alpha")
        .writeFile("/w/sub/b.md", "beta", { mode: 0o600 })
        .symlink("a.md", "/w/link.md")
        .symlink("/w/sub", "/w/dirlink")
        .symlink("nope.md", "/w/dangling.md")
        .symlink("loop2", "/w/loop1")
        .symlink("loop1", "/w/loop2");
}

describe("MemDocFs setup helpers", () => {
    it("builds trees and reports them", () => {
        const fs = new MemDocFs().mkdirp("/a/b").writeFile("/a/b/c.md", "x");

        expect(fs.paths()).toEqual(["/", "/a", "/a/b", "/a/b/c.md"]);
        expect(fs.exists("/a/b")).toBe(true);
        expect(fs.exists("/a/zz")).toBe(false);
        expect(fs.readFile("/a/b/c.md")).toBe("x");
        expect(fs.modeOf("/a/b")).toBe(0o755);
    });

    it("removes a whole tree", () => {
        const fs = fixture().removeAll("/w/sub").removeAll("/w/zz");

        expect(fs.paths().filter((p) => p.startsWith("/w/sub"))).toEqual([]);
        expect(fs.exists("/w/a.md")).toBe(true);
    });

    it("chmods files and directories", () => {
        const fs = fixture().chmod("/w/a.md", 0o600).chmod("/w/sub", 0o555);

        expect(fs.modeOf("/w/a.md")).toBe(0o600);
        expect(fs.modeOf("/w/sub")).toBe(0o555);
    });

    it("refuses helper misuse", () => {
        const fs = fixture();

        expect(() => fs.mkdirp("/w/a.md/x")).toThrow("not a directory");
        expect(() => fs.chmod("/w/link.md", 0o600)).toThrow("chmod");
        expect(() => fs.chmod("/w/zz", 0o600)).toThrow("chmod");
        expect(() => fs.readFile("/w/sub")).toThrow("no file");
        expect(() => fs.modeOf("/w/link.md")).toThrow("modeOf");
        expect(() => fs.modeOf("/w/zz")).toThrow("modeOf");
    });

    it("stamps mtimes from the injected clock", async () => {
        let now = 100n;
        const fs = new MemDocFs({ clock: () => now });
        fs.writeFile("/f", "x");
        now = 200n;

        await fs.writeAtomic("/f", "y", OPTS);

        expect((await fs.stat("/f")).mtimeNs).toBe(200n);
    });

    it("advances the default clock on every change", async () => {
        const fs = new MemDocFs().writeFile("/f", "x");
        const before = (await fs.stat("/f")).mtimeNs;

        await fs.writeAtomic("/f", "x", OPTS);

        expect((await fs.stat("/f")).mtimeNs).toBeGreaterThan(before);
    });
});

describe("MemDocFs reads", () => {
    it("reads text and bytes, following symlinks", async () => {
        const fs = fixture();

        expect(await fs.readText("/w/link.md")).toBe("alpha");
        expect(await fs.readText("/w/dirlink/b.md")).toBe("beta");
        expect([...(await fs.readBytes("/w/a.md"))]).toEqual([
            ...Buffer.from("alpha"),
        ]);
    });

    it.each([
        ["/w/zz.md", "open /w/zz.md: no such file or directory"],
        ["/w/zz/a.md", "open /w/zz/a.md: no such file or directory"],
        ["/w/a.md/x", "open /w/a.md/x: not a directory"],
        ["/w/sub", "read /w/sub: is a directory"],
        ["/w/dangling.md", "open /w/dangling.md: no such file or directory"],
        ["/w/loop1", "open /w/loop1: too many levels of symbolic links"],
    ])("fails reading %s like Go", async (path, want) => {
        const fs = fixture();

        await expect(fs.readText(path)).rejects.toThrow(want);
    });

    it("refuses an unreadable file", async () => {
        const fs = fixture().chmod("/w/a.md", 0o200);

        await expect(fs.readBytes("/w/a.md")).rejects.toThrow(
            "open /w/a.md: permission denied",
        );
    });
});

describe("MemDocFs stat and lstat", () => {
    it("stats files, directories and symlinks", async () => {
        const fs = fixture();

        const file = await fs.stat("/w/sub/b.md");
        expect(file).toMatchObject({
            isFile: true,
            isDir: false,
            isSymlink: false,
            size: 4,
            mode: 0o600,
        });
        expect(await fs.stat("/w/link.md")).toMatchObject({ isFile: true });
        expect(await fs.stat("/w/dirlink")).toMatchObject({
            isDir: true,
            size: 0,
        });
        expect(await fs.lstat("/w/link.md")).toMatchObject({
            isSymlink: true,
            isFile: false,
            size: 4,
            mode: 0o777,
        });
        expect(await fs.lstat("/w/dangling.md")).toMatchObject({
            isSymlink: true,
        });
        expect(await fs.stat("/")).toMatchObject({ isDir: true });
    });

    it("fails like Go", async () => {
        const fs = fixture();

        await expect(fs.stat("/w/dangling.md")).rejects.toThrow(
            "stat /w/dangling.md: no such file or directory",
        );
        await expect(fs.stat("/w/loop1")).rejects.toThrow(
            "stat /w/loop1: too many levels of symbolic links",
        );
        await expect(fs.lstat("/w/zz")).rejects.toThrow(
            "lstat /w/zz: no such file or directory",
        );
    });
});

describe("MemDocFs readdir", () => {
    it("lists entries sorted with their unfollowed kinds", async () => {
        const fs = fixture();

        const have = await fs.readdir("/w");

        expect(have).toEqual([
            { name: "a.md", kind: "file" },
            { name: "dangling.md", kind: "symlink" },
            { name: "dirlink", kind: "symlink" },
            { name: "link.md", kind: "symlink" },
            { name: "loop1", kind: "symlink" },
            { name: "loop2", kind: "symlink" },
            { name: "sub", kind: "dir" },
        ]);
        expect(await fs.readdir("/w/dirlink")).toEqual([
            { name: "b.md", kind: "file" },
        ]);
    });

    it("fails like Go", async () => {
        const fs = fixture().mkdirp("/locked").chmod("/locked", 0o300);

        await expect(fs.readdir("/w/zz")).rejects.toThrow(
            "open /w/zz: no such file or directory",
        );
        await expect(fs.readdir("/w/a.md")).rejects.toThrow(
            "open /w/a.md: not a directory",
        );
        await expect(fs.readdir("/locked")).rejects.toThrow(
            "open /locked: permission denied",
        );
    });
});

describe("MemDocFs realpath", () => {
    it("resolves every symlink", async () => {
        const fs = fixture().symlink("../w/dirlink/b.md", "/x/rel.md");

        expect(await fs.realpath("/w/dirlink/b.md")).toBe("/w/sub/b.md");
        expect(await fs.realpath("/x/rel.md")).toBe("/w/sub/b.md");
        expect(await fs.realpath("/w//sub/./b.md")).toBe("/w/sub/b.md");
    });

    it("names the missing resolved path like Go's EvalSymlinks", async () => {
        const fs = fixture();

        await expect(fs.realpath("/w/dangling.md")).rejects.toThrow(
            "lstat /w/nope.md: no such file or directory",
        );
        await expect(fs.realpath("/w/zz/q")).rejects.toThrow(
            "lstat /w/zz: no such file or directory",
        );
    });
});

describe("MemDocFs writeAtomic", () => {
    it("creates and replaces files with the given mode, syncing the dir", async () => {
        const fs = fixture();

        await fs.writeAtomic("/w/new.md", "fresh", OPTS);
        await fs.writeAtomic("/w/a.md", "replaced", { ...OPTS, mode: 0o600 });

        expect(fs.readFile("/w/new.md")).toBe("fresh");
        expect(fs.modeOf("/w/new.md")).toBe(0o644);
        expect(fs.readFile("/w/a.md")).toBe("replaced");
        expect(fs.modeOf("/w/a.md")).toBe(0o600);
        expect(fs.synced).toEqual(["/w", "/w"]);
        expect(fs.paths().some((p) => p.includes(".gap-"))).toBe(false);
    });

    it("writes bytes and through a symlinked directory", async () => {
        const fs = fixture();

        await fs.writeAtomic(
            "/w/dirlink/c.md",
            Uint8Array.from([104, 105]),
            OPTS,
        );

        expect(fs.readFile("/w/sub/c.md")).toBe("hi");
    });

    it.each([
        [
            "/w/zz/x.md",
            /^open \/w\/zz\/\.gap-\d+\.tmp: no such file or directory$/,
        ],
        ["/w/a.md/x.md", /^open \/w\/a\.md\/\.gap-\d+\.tmp: not a directory$/],
        ["/w/q/r/x.md", /^open \/w\/q\/r\/\.gap-\d+\.tmp: no such file/],
        ["/w/sub", /^rename \/w\/\.gap-\d+\.tmp \/w\/sub: file exists$/],
    ])("fails writing %s like Go", async (path, want) => {
        const fs = fixture();

        await expect(fs.writeAtomic(path, "x", OPTS)).rejects.toThrow(want);
    });

    it("refuses a read-only directory at the create stage", async () => {
        const fs = fixture().chmod("/w/sub", 0o555);

        const have = fs.writeAtomic("/w/sub/b.md", "x", OPTS);

        await expect(have).rejects.toMatchObject({
            code: "EACCES",
            stage: "create",
        });
        expect(fs.readFile("/w/sub/b.md")).toBe("beta");
    });

    it.each([
        ["create", /^open \/w\/\.gap-\d+\.tmp: input\/output error$/],
        ["chmod", /^chmod \/w\/\.gap-\d+\.tmp: input\/output error$/],
        ["write", /^write \/w\/\.gap-\d+\.tmp: input\/output error$/],
        ["sync", /^sync \/w\/\.gap-\d+\.tmp: input\/output error$/],
        ["close", /^close \/w\/\.gap-\d+\.tmp: input\/output error$/],
        [
            "rename",
            /^rename \/w\/\.gap-\d+\.tmp \/w\/a\.md: input\/output error$/,
        ],
    ] as const)(
        "injects a %s failure leaving the file",
        async (stage, want) => {
            const fs = fixture().failOn("writeAtomic", "/w/a.md", { stage });

            const have = fs.writeAtomic("/w/a.md", "x", OPTS);

            await expect(have).rejects.toThrow(want);
            await expect(
                fs.writeAtomic("/w/a.md", "x", OPTS),
            ).rejects.toMatchObject({
                stage,
            });
            expect(fs.readFile("/w/a.md")).toBe("alpha");
        },
    );

    it("injects a syncdir failure after the rename", async () => {
        const fs = fixture().failOn("writeAtomic", "/w/a.md", {
            stage: "syncdir",
            code: "ENOSPC",
            once: true,
        });

        const have = fs.writeAtomic("/w/a.md", "x", OPTS);

        await expect(have).rejects.toThrow("sync /w: no space left on device");
        expect(fs.readFile("/w/a.md")).toBe("x");
        await fs.writeAtomic("/w/a.md", "y", OPTS);
        expect(fs.readFile("/w/a.md")).toBe("y");
    });

    it("defaults an injected fault to the create stage", async () => {
        const fs = fixture().failOn("writeAtomic", "/w/a.md");

        const have = fs.writeAtomic("/w/a.md", "x", OPTS);

        await expect(have).rejects.toMatchObject({
            code: "EIO",
            stage: "create",
        });
    });
});

describe("MemDocFs rename", () => {
    it("moves files and whole directories", async () => {
        const fs = fixture().mkdirp("/w/closed");

        await fs.rename("/w/a.md", "/w/closed/a.md");
        await fs.rename("/w/sub", "/w/moved");

        expect(fs.readFile("/w/closed/a.md")).toBe("alpha");
        expect(fs.exists("/w/a.md")).toBe(false);
        expect(fs.readFile("/w/moved/b.md")).toBe("beta");
        expect(fs.exists("/w/sub/b.md")).toBe(false);
    });

    it("moves a symlink itself", async () => {
        const fs = fixture();

        await fs.rename("/w/link.md", "/w/link2.md");

        expect((await fs.lstat("/w/link2.md")).isSymlink).toBe(true);
    });

    it.each([
        ["/w/zz", "/w/x", "rename /w/zz /w/x: no such file or directory"],
        ["/w/a.md", "/w/sub/b.md", "rename /w/a.md /w/sub/b.md: file exists"],
        [
            "/w/a.md",
            "/w/no/x",
            "rename /w/a.md /w/no/x: no such file or directory",
        ],
        [
            "/w/a.md",
            "/w/q/r/x",
            "rename /w/a.md /w/q/r/x: no such file or directory",
        ],
        [
            "/w/a.md",
            "/w/sub/b.md/x",
            "rename /w/a.md /w/sub/b.md/x: not a directory",
        ],
        ["/w/zz/a", "/w/x", "rename /w/zz/a /w/x: no such file or directory"],
    ])("fails renaming %s to %s like Go", async (from, to, want) => {
        const fs = fixture();

        await expect(fs.rename(from, to)).rejects.toThrow(want);
    });

    it("refuses read-only source or target directories", async () => {
        const fs = fixture().mkdirp("/ro").chmod("/ro", 0o555);

        await expect(fs.rename("/w/a.md", "/ro/a.md")).rejects.toThrow(
            "rename /w/a.md /ro/a.md: permission denied",
        );
        fs.chmod("/ro", 0o755).writeFile("/ro/f", "x").chmod("/ro", 0o555);
        await expect(fs.rename("/ro/f", "/w/f")).rejects.toThrow(
            "permission denied",
        );
    });

    it("injects a fault keyed by the source", async () => {
        const fs = fixture().failOn("rename", "/w/a.md", { code: "EXDEV" });

        await expect(fs.rename("/w/a.md", "/w/b.md")).rejects.toThrow(
            "rename /w/a.md /w/b.md: exdev",
        );
    });
});

describe("MemDocFs remove", () => {
    it("removes files, symlinks and empty directories", async () => {
        const fs = fixture().mkdirp("/w/empty");

        await fs.remove("/w/a.md");
        await fs.remove("/w/link.md");
        await fs.remove("/w/empty");

        expect(fs.exists("/w/a.md")).toBe(false);
        expect(fs.exists("/w/link.md")).toBe(false);
        expect(fs.exists("/w/empty")).toBe(false);
    });

    it("fails like Go", async () => {
        const fs = fixture()
            .mkdirp("/ro")
            .writeFile("/ro/f", "x")
            .chmod("/ro", 0o555);

        await expect(fs.remove("/w/zz")).rejects.toThrow(
            "remove /w/zz: no such file or directory",
        );
        await expect(fs.remove("/w/zz/q")).rejects.toThrow(
            "remove /w/zz/q: no such file or directory",
        );
        await expect(fs.remove("/w/sub")).rejects.toThrow(
            "remove /w/sub: directory not empty",
        );
        await expect(fs.remove("/ro/f")).rejects.toThrow(
            "remove /ro/f: permission denied",
        );
    });
});

describe("MemDocFs mkdir", () => {
    it("creates one directory with its mode", async () => {
        const fs = fixture();

        await fs.mkdir("/w/closed", 0o700);

        expect(fs.modeOf("/w/closed")).toBe(0o700);
    });

    it("fails like Go", async () => {
        const fs = fixture().mkdirp("/ro").chmod("/ro", 0o555);

        await expect(fs.mkdir("/w/sub", 0o755)).rejects.toThrow(
            "mkdir /w/sub: file exists",
        );
        await expect(fs.mkdir("/w/x/y", 0o755)).rejects.toThrow(
            "mkdir /w/x/y: no such file or directory",
        );
        await expect(fs.mkdir("/ro/closed", 0o755)).rejects.toThrow(
            "mkdir /ro/closed: permission denied",
        );
    });
});

describe("MemDocFs syncDir", () => {
    it("records synced directories", async () => {
        const fs = fixture();

        await fs.syncDir("/w/sub");
        await fs.syncDir("/w/dirlink");

        expect(fs.synced).toEqual(["/w/sub", "/w/dirlink"]);
    });

    it("fails on a missing directory like Go", async () => {
        const fs = fixture();

        await expect(fs.syncDir("/w/zz")).rejects.toThrow(
            "open /w/zz: no such file or directory",
        );
        await expect(fs.syncDir("/w/zz/q")).rejects.toThrow(
            "open /w/zz/q: no such file or directory",
        );
    });
});

describe("MemDocFs probeWritable", () => {
    it("accepts a writable directory and leaves nothing behind", async () => {
        const fs = fixture();
        const before = fs.paths();

        await fs.probeWritable("/w", ".gaps-check-");

        expect(fs.paths()).toEqual(before);
    });

    it.each([
        [
            "/w/zz",
            /^open \/w\/zz\/\.gaps-check-\d+: no such file or directory$/,
        ],
        ["/w/zz/q", /^open \/w\/zz\/q\/\.gaps-check-\d+: no such file/],
        ["/w/a.md", /^open \/w\/a\.md\/\.gaps-check-\d+: not a directory$/],
    ])("fails probing %s like Go", async (dir, want) => {
        const fs = fixture();

        await expect(fs.probeWritable(dir, ".gaps-check-")).rejects.toThrow(
            want,
        );
    });

    it("refuses a read-only directory", async () => {
        const fs = fixture().chmod("/w/sub", 0o555);

        await expect(
            fs.probeWritable("/w/sub", ".gaps-check-"),
        ).rejects.toThrow(
            /^open \/w\/sub\/\.gaps-check-\d+: permission denied$/,
        );
    });
});

describe("MemDocFs.failOn", () => {
    it.each([
        ["readText", (fs: MemDocFs) => fs.readText("/w/a.md"), "open /w/a.md"],
        [
            "readBytes",
            (fs: MemDocFs) => fs.readBytes("/w/a.md"),
            "open /w/a.md",
        ],
        ["stat", (fs: MemDocFs) => fs.stat("/w/a.md"), "stat /w/a.md"],
        ["lstat", (fs: MemDocFs) => fs.lstat("/w/a.md"), "lstat /w/a.md"],
        ["readdir", (fs: MemDocFs) => fs.readdir("/w/a.md"), "open /w/a.md"],
        ["realpath", (fs: MemDocFs) => fs.realpath("/w/a.md"), "lstat /w/a.md"],
        ["remove", (fs: MemDocFs) => fs.remove("/w/a.md"), "remove /w/a.md"],
        [
            "mkdir",
            (fs: MemDocFs) => fs.mkdir("/w/a.md", 0o755),
            "mkdir /w/a.md",
        ],
        ["syncDir", (fs: MemDocFs) => fs.syncDir("/w/a.md"), "open /w/a.md"],
        [
            "probeWritable",
            (fs: MemDocFs) => fs.probeWritable("/w/a.md", ".p-"),
            "open /w/a.md/.p-",
        ],
    ] as const)("fails %s with Go's op name", async (op, call, want) => {
        const fs = fixture().failOn(op, "/w/a.md", { code: "EACCES" });

        await expect(call(fs)).rejects.toThrow(want);
        await expect(call(fs)).rejects.toThrow("permission denied");
    });

    it("fires a once fault a single time", async () => {
        const fs = fixture().failOn("stat", "/w/a.md", { once: true });

        await expect(fs.stat("/w/a.md")).rejects.toThrow(DocFsError);
        await expect(fs.stat("/w/a.md")).resolves.toMatchObject({
            isFile: true,
        });
    });

    it("matches the cleaned path and clears", async () => {
        const fs = fixture().failOn("readText", "/w/./sub/../a.md");

        await expect(fs.readText("/w/a.md")).rejects.toThrow(
            "open /w/a.md: input/output error",
        );
        fs.clearFaults();
        await expect(fs.readText("/w/a.md")).resolves.toBe("alpha");
    });
});
