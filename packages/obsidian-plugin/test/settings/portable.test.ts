// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { KnowledgeBase } from "@docket/core";
import { describe, expect, it } from "vitest";

import {
    DEFAULT_SETTINGS,
    type docketSettings,
} from "../../src/settings/model.ts";
import {
    applyImportedMaps,
    expandTilde,
    importSummary,
    isPortableConfig,
    PORTABLE_FILE,
    resolvePortablePath,
    toPortableConfig,
} from "../../src/settings/portable.ts";

function settings(over: Partial<docketSettings> = {}): docketSettings {
    return { ...DEFAULT_SETTINGS, ...over };
}

describe("toPortableConfig", () => {
    it("shapes the shareable config and formats the timeout as seconds", () => {
        const out = toPortableConfig(
            settings({
                timeoutSeconds: 45,
                flavor: "gfm",
                margin: 80,
                pages: { "a.md": "/wiki/p" },
                folders: { docs: "/wiki/f" },
                spaces: { team: "/wiki/s" },
            }),
        );
        expect(out).toEqual({
            timeout: "45s",
            markdown: { flavor: "gfm", margin: 80 },
            comments: false,
            pages: { "a.md": "/wiki/p" },
            folders: { docs: "/wiki/f" },
            spaces: { team: "/wiki/s" },
        });
    });

    it("never emits secret keys", () => {
        const out = toPortableConfig(settings({ site: "x", account: "y" }));
        expect(Object.keys(out)).toEqual([
            "timeout",
            "markdown",
            "comments",
            "pages",
            "folders",
            "spaces",
        ]);
    });

    it("lists the knowledge bases, the branch only when set", () => {
        const out = toPortableConfig(
            settings({
                knowledgeBases: [
                    {
                        kind: "git",
                        name: "kb",
                        url: "git@h:me/kb.git",
                        branch: "",
                    },
                    {
                        kind: "git",
                        name: "kb-anna",
                        url: "git@h:anna/kb.git",
                        branch: "draft",
                    },
                ],
            }),
        );

        expect(out.knowledge_bases).toEqual([
            { name: "kb", url: "git@h:me/kb.git" },
            { name: "kb-anna", url: "git@h:anna/kb.git", branch: "draft" },
        ]);
    });

    it("lists a local folder by name and kind only", () => {
        const out = toPortableConfig(
            settings({
                knowledgeBases: [
                    { kind: "folder", name: "notes", url: "", branch: "" },
                ],
            }),
        );

        expect(out.knowledge_bases).toEqual([
            { name: "notes", kind: "folder" },
        ]);
    });

    it("copies the maps rather than aliasing the settings", () => {
        const s = settings({ pages: { "a.md": "/wiki/p" } });
        const out = toPortableConfig(s);
        out.pages["b.md"] = "/wiki/q";
        expect(s.pages).toEqual({ "a.md": "/wiki/p" });
    });
});

describe("PORTABLE_FILE", () => {
    it("is not a hidden file", () => {
        expect(PORTABLE_FILE).toBe("docket.yaml");
    });
});

describe("resolvePortablePath", () => {
    it("appends the file name when the target is a folder", () => {
        expect(resolvePortablePath("sync", true)).toBe(`sync/${PORTABLE_FILE}`);
    });

    it("appends the file name for a trailing-slash input", () => {
        expect(resolvePortablePath("sync/", false)).toBe(
            `sync/${PORTABLE_FILE}`,
        );
    });

    it("uses a file path as given (trimmed)", () => {
        expect(resolvePortablePath("  sync/my.yaml  ", false)).toBe(
            "sync/my.yaml",
        );
    });

    it("resolves a '.' folder to the bare file name", () => {
        expect(resolvePortablePath(".", true)).toBe(PORTABLE_FILE);
    });
});

describe("expandTilde", () => {
    it("expands a '~/…' path to the home directory", () => {
        expect(expandTilde("~/sync/.docket.yaml", "/home/me")).toBe(
            "/home/me/sync/.docket.yaml",
        );
    });

    it("expands a bare '~' to the home directory", () => {
        expect(expandTilde("~", "/home/me")).toBe("/home/me");
    });

    it("expands a Windows-style '~\\…' path", () => {
        expect(expandTilde("~\\sync", "C:\\Users\\me")).toBe(
            "C:\\Users\\me\\sync",
        );
    });

    it("trims surrounding whitespace before expanding", () => {
        expect(expandTilde("  ~/sync  ", "/home/me")).toBe("/home/me/sync");
    });

    it("leaves another user's '~name/…' home untouched", () => {
        expect(expandTilde("~other/sync", "/home/me")).toBe("~other/sync");
    });

    it("leaves an absolute or vault-relative path untouched (trimmed)", () => {
        expect(expandTilde("  /etc/x  ", "/home/me")).toBe("/etc/x");
        expect(expandTilde("sync/x.yaml", "/home/me")).toBe("sync/x.yaml");
    });
});

describe("applyImportedMaps", () => {
    it("merges the three maps with incoming winning on a duplicate", () => {
        const base = settings({
            pages: { "a.md": "/old", "keep.md": "/keep" },
            folders: { docs: "/old-folder" },
        });
        const { settings: next, imported } = applyImportedMaps(base, {
            pages: { "a.md": "/new", "b.md": "/added" },
            folders: { docs: "/new-folder" },
            spaces: { team: "/space" },
        });
        expect(next.pages).toEqual({
            "a.md": "/new",
            "keep.md": "/keep",
            "b.md": "/added",
        });
        expect(next.folders).toEqual({ docs: "/new-folder" });
        expect(next.spaces).toEqual({ team: "/space" });
        expect(imported).toBe(4);
    });

    it("drops non-string entries and ignores non-map values", () => {
        const { settings: next, imported } = applyImportedMaps(settings(), {
            pages: { "a.md": "/ok", "bad.md": 7, nested: { x: 1 } },
            folders: "not-a-map",
        });
        expect(next.pages).toEqual({ "a.md": "/ok" });
        expect(next.folders).toEqual({});
        expect(imported).toBe(1);
    });

    it("returns an unchanged copy for a non-object parsed value", () => {
        const base = settings({ pages: { "a.md": "/p" } });
        const { settings: next, imported } = applyImportedMaps(base, "nope");
        expect(next.pages).toEqual({ "a.md": "/p" });
        expect(imported).toBe(0);
        expect(next).not.toBe(base);
    });

    it("leaves flavor, margin, timeout, and secrets untouched", () => {
        const base = settings({
            flavor: "gfm",
            margin: 80,
            timeoutSeconds: 45,
            site: "acme",
            account: "me@ex.com",
        });
        const { settings: next } = applyImportedMaps(base, {
            markdown: { flavor: "obsidian", margin: 0 },
            timeout: "1s",
            pages: { "a.md": "/p" },
        });
        expect(next.flavor).toBe("gfm");
        expect(next.margin).toBe(80);
        expect(next.timeoutSeconds).toBe(45);
        expect(next.site).toBe("acme");
        expect(next.account).toBe("me@ex.com");
    });
});

describe("applyImportedMaps knowledge bases", () => {
    const mine: KnowledgeBase = {
        kind: "git",
        name: "kb",
        url: "git@h:me/kb.git",
        branch: "",
    };

    it("adds knowledge bases under new names", () => {
        const have = applyImportedMaps(settings({ knowledgeBases: [mine] }), {
            knowledge_bases: [
                { name: "kb-anna", url: "git@h:anna/kb.git", branch: "draft" },
            ],
        });

        expect(have.settings.knowledgeBases).toEqual([
            mine,
            {
                kind: "git",
                name: "kb-anna",
                url: "git@h:anna/kb.git",
                branch: "draft",
            },
        ]);
        expect(have.addedKnowledgeBases).toBe(1);
        expect(have.skippedKnowledgeBases).toEqual([]);
    });

    it("keeps an existing entry whose name the file reuses", () => {
        const have = applyImportedMaps(settings({ knowledgeBases: [mine] }), {
            knowledge_bases: [
                { name: "kb", url: "git@h:anna/other.git" },
                { name: "kb", url: "git@h:me/kb.git" },
            ],
        });

        expect(have.settings.knowledgeBases).toEqual([mine]);
        expect(have.addedKnowledgeBases).toBe(0);
        expect(have.skippedKnowledgeBases).toEqual(["kb"]);
    });

    it("adds a local folder, and skips one whose name is a git entry", () => {
        const have = applyImportedMaps(settings({ knowledgeBases: [mine] }), {
            knowledge_bases: [
                { kind: "folder", name: "notes" },
                { kind: "folder", name: "kb" },
            ],
        });

        expect(have.settings.knowledgeBases).toEqual([
            mine,
            { kind: "folder", name: "notes", url: "", branch: "" },
        ]);
        expect(have.skippedKnowledgeBases).toEqual(["kb"]);
    });

    it("drops malformed entries", () => {
        const have = applyImportedMaps(settings(), {
            knowledge_bases: [{ name: "x" }, "y"],
        });

        expect(have.settings.knowledgeBases).toEqual([]);
        expect(have.addedKnowledgeBases).toBe(0);
    });
});

describe("importSummary", () => {
    const r = {
        settings: settings(),
        imported: 3,
        addedKnowledgeBases: 0,
        skippedKnowledgeBases: [],
    };

    it("counts the mappings", () => {
        expect(importSummary(r, "a/.docket.yaml")).toBe(
            "docket: imported 3 mappings from a/.docket.yaml.",
        );
    });

    it("counts added knowledge bases and says how to get them", () => {
        const have = importSummary({ ...r, addedKnowledgeBases: 1 }, "f");

        expect(have).toBe(
            "docket: imported 3 mappings and 1 knowledge base from f. " +
                "Clone it from its card.",
        );
    });

    it("names the knowledge bases it kept", () => {
        const have = importSummary(
            { ...r, imported: 1, skippedKnowledgeBases: ["kb", "notes"] },
            "f",
        );

        expect(have).toBe(
            "docket: imported 1 mapping from f. Kept your kb, notes: " +
                "the import names a different source for them.",
        );
    });
});

describe("isPortableConfig", () => {
    it("accepts what an export writes", () => {
        expect(isPortableConfig(toPortableConfig(settings()))).toBe(true);
    });

    it("accepts a config holding only one section", () => {
        expect(isPortableConfig({ pages: { "a.md": "/wiki/p" } })).toBe(true);
        expect(isPortableConfig({ folders: {} })).toBe(true);
        expect(isPortableConfig({ spaces: {} })).toBe(true);
        expect(isPortableConfig({ knowledge_bases: [] })).toBe(true);
    });

    it("refuses anything else", () => {
        expect(isPortableConfig("some copied text")).toBe(false);
        expect(isPortableConfig(null)).toBe(false);
        expect(isPortableConfig(["a"])).toBe(false);
        expect(isPortableConfig({ title: "a note" })).toBe(false);
    });
});

describe("resolvePortablePath on Windows", () => {
    it("joins the file name onto a folder the picker returned", () => {
        expect(resolvePortablePath("C:\\Users\\me", true)).toBe(
            "C:\\Users\\me/docket.yaml",
        );
    });
});
