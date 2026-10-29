// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { GitController } from "../../src/git/controller.ts";
import { GitRepos } from "../../src/git/repos.ts";

/** repos builds a router whose sync controller is rooted at `root`. */
function repos(root: string | null): GitRepos {
    const files = {
        isFolder: () => Promise.resolve(true),
        read: () => Promise.resolve(null),
        write: () => Promise.resolve(),
        mkdir: () => Promise.resolve(),
    };
    const ctl = (r: string | null): GitController =>
        new GitController({
            root: () => r,
            files,
            notify: () => {},
            record: () => {},
        });
    return new GitRepos(ctl(""), ctl(root), files);
}

describe("GitRepos.forPath", () => {
    it("routes a path under the sync folder to the sync repository", () => {
        const r = repos("confluence");

        expect(r.forPath("confluence/doc/a.md")).toBe(r.sync);
    });

    it("routes a path outside the sync folder to the vault repository", () => {
        const r = repos("confluence");

        expect(r.forPath("kb/a.md")).toBe(r.vault);
        expect(r.forPath("confluence-old/a.md")).toBe(r.vault);
        expect(r.forPath("confluence.md")).toBe(r.vault);
    });

    it("routes the sync folder itself to the sync repository", () => {
        const r = repos("confluence");

        expect(r.forPath("confluence")).toBe(r.sync);
    });

    it("routes everything to the vault repository without a sync folder", () => {
        const r = repos(null);

        expect(r.forPath("confluence/a.md")).toBe(r.vault);
    });
});

describe("GitRepos.all", () => {
    it("lists the vault repository first", () => {
        const r = repos("confluence");

        expect(r.all()).toEqual([r.vault, r.sync]);
    });
});

describe("GitRepos.ignorable", () => {
    it("offers files and folders in both repositories", () => {
        const r = repos("confluence");

        expect(r.ignorable("kb/a.md")).toBe(true);
        expect(r.ignorable("confluence/_docket-media")).toBe(true);
    });

    it("refuses the vault root, the sync folder, and each .gitignore", () => {
        const r = repos("confluence");

        expect(r.ignorable("/")).toBe(false);
        expect(r.ignorable("")).toBe(false);
        expect(r.ignorable("confluence")).toBe(false);
        expect(r.ignorable(".gitignore")).toBe(false);
        expect(r.ignorable("confluence/.gitignore")).toBe(false);
    });
});
