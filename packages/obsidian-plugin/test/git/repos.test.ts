// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { GitController } from "../../src/git/controller.ts";
import { GitRepos, gitKbNames } from "../../src/git/repos.ts";

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
    return new GitRepos(ctl(""), ctl(root), files, ctl);
}

describe("GitRepos.setKnowledgeBases", () => {
    it("opens one repository per knowledge base, listed by name", () => {
        const r = repos("confluence");

        const added = r.setKnowledgeBases(["kb-team", "kb"]);

        expect(r.kbNames()).toEqual(["kb", "kb-team"]);
        expect(r.kb("kb")?.root).toBe("kb");
        expect(added).toEqual([r.kb("kb-team"), r.kb("kb")]);
        expect(r.all()).toEqual([r.vault, r.sync, r.kb("kb"), r.kb("kb-team")]);
    });

    it("keeps a known one, drops a removed one, and reports only new ones", () => {
        const r = repos("confluence");
        r.setKnowledgeBases(["kb", "old"]);
        const kb = r.kb("kb");

        const added = r.setKnowledgeBases(["kb", "new"]);

        expect(r.kb("kb")).toBe(kb);
        expect(r.kb("old")).toBeUndefined();
        expect(added).toEqual([r.kb("new")]);
    });

    it("tells listeners when the set changes, and only then", () => {
        const r = repos("confluence");
        let calls = 0;
        const stop = r.onChange(() => calls++);

        r.setKnowledgeBases(["kb"]);
        r.setKnowledgeBases(["kb"]);
        r.setKnowledgeBases([]);
        stop();
        r.setKnowledgeBases(["kb"]);

        expect(calls).toBe(2);
    });
});

describe("GitRepos.each", () => {
    it("sets up every repository, later ones too, and cleans up dropped ones", () => {
        const r = repos("confluence");
        r.setKnowledgeBases(["kb"]);
        const log: string[] = [];
        const id = (g: unknown): string =>
            g === r.vault
                ? "vault"
                : g === r.sync
                  ? "sync"
                  : String((g as { root: string }).root);

        const stop = r.each((git) => {
            log.push(`+${id(git)}`);
            return () => log.push(`-${id(git)}`);
        });
        r.setKnowledgeBases(["kb-team"]);
        stop();
        r.setKnowledgeBases(["kb"]);

        expect(log).toEqual([
            "+vault",
            "+sync",
            "+kb",
            "-kb",
            "+kb-team",
            "-vault",
            "-sync",
            "-kb-team",
        ]);
    });
});

describe("GitRepos.get", () => {
    it("finds every repository by its id", () => {
        const r = repos("confluence");
        r.setKnowledgeBases(["kb"]);

        expect(r.get("vault")).toBe(r.vault);
        expect(r.get("sync")).toBe(r.sync);
        expect(r.get("kb:kb")).toBe(r.kb("kb"));
        expect(r.get("kb:gone")).toBeUndefined();
    });
});

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

    it("routes a path in a knowledge base's folder to its repository", () => {
        const r = repos("confluence");
        r.setKnowledgeBases(["kb", "kb-team"]);

        expect(r.forPath("kb")).toBe(r.kb("kb"));
        expect(r.forPath("kb/alarms/a.md")).toBe(r.kb("kb"));
        expect(r.forPath("kb-team/a.md")).toBe(r.kb("kb-team"));
        expect(r.forPath("kb.md")).toBe(r.vault);
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

    it("offers a knowledge base's files but not its folder or .gitignore", () => {
        const r = repos("confluence");
        r.setKnowledgeBases(["kb"]);

        expect(r.ignorable("kb/a.md")).toBe(true);
        expect(r.ignorable("kb")).toBe(false);
        expect(r.ignorable("kb/.gitignore")).toBe(false);
    });
});

describe("gitKbNames", () => {
    it("names the git knowledge bases and skips local folders", () => {
        const have = gitKbNames([
            { kind: "git", name: "kb", url: "git@h:me/kb.git", branch: "" },
            { kind: "folder", name: "notes", url: "", branch: "" },
            {
                kind: "git",
                name: "kb-team",
                url: "git@h:t/kb.git",
                branch: "main",
            },
        ]);

        expect(have).toEqual(["kb", "kb-team"]);
    });
});
