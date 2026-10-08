// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { DocFsError, isExist, isNotExist } from "../src/ports.ts";

describe("DocFsError", () => {
    it("formats like Go's PathError", () => {
        const have = new DocFsError({ code: "ENOENT", op: "open", path: "/a" });

        expect(have.message).toBe("open /a: no such file or directory");
        expect(have.name).toBe("DocFsError");
        expect([have.code, have.op, have.path]).toEqual([
            "ENOENT",
            "open",
            "/a",
        ]);
        expect(have.path2).toBeUndefined();
        expect(have.stage).toBeUndefined();
        expect(have.reason).toBe("no such file or directory");
    });

    it("formats like Go's LinkError when path2 is set", () => {
        const have = new DocFsError({
            code: "EEXIST",
            op: "rename",
            path: "/a",
            path2: "/b",
            stage: "rename",
        });

        expect(have.message).toBe("rename /a /b: file exists");
        expect(have.stage).toBe("rename");
    });

    it.each([
        ["EACCES", "permission denied"],
        ["EIO", "input/output error"],
        ["EISDIR", "is a directory"],
        ["ELOOP", "too many levels of symbolic links"],
        ["ENOSPC", "no space left on device"],
        ["ENOTDIR", "not a directory"],
        ["ENOTEMPTY", "directory not empty"],
        ["EPERM", "operation not permitted"],
        ["EROFS", "read-only file system"],
        ["EWEIRD", "eweird"],
    ])("spells %s as Go", (code, want) => {
        const have = new DocFsError({ code, op: "stat", path: "/x" });

        expect(have.message).toBe(`stat /x: ${want}`);
    });

    it("uses an explicit reason", () => {
        const have = new DocFsError({
            code: "EIO",
            op: "sync",
            path: "/d",
            reason: "disk on fire",
        });

        expect(have.message).toBe("sync /d: disk on fire");
    });
});

describe("isNotExist / isExist", () => {
    const err = (code: string) => new DocFsError({ code, op: "x", path: "/" });

    it("classify errno codes like Go's errors.Is", () => {
        expect(isNotExist(err("ENOENT"))).toBe(true);
        expect(isNotExist(err("EEXIST"))).toBe(false);
        expect(isNotExist(new Error("ENOENT"))).toBe(false);

        expect(isExist(err("EEXIST"))).toBe(true);
        expect(isExist(err("ENOTEMPTY"))).toBe(true);
        expect(isExist(err("ENOENT"))).toBe(false);
        expect(isExist("EEXIST")).toBe(false);
    });
});
