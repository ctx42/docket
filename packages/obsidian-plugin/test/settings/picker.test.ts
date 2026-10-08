// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import {
    type ChildNode,
    DEFAULT_SETTINGS,
    type docketSettings,
    type Space,
} from "@docket/core";
import { describe, expect, it } from "vitest";
import {
    canSave,
    changeCount,
    childNodes,
    currentName,
    emptyDraft,
    groupSpaces,
    isTicked,
    localName,
    renameKind,
    review,
    setDest,
    setRename,
    sourceOf,
    spaceNode,
    syncedAs,
    type TreeNode,
    toggle,
} from "../../src/settings/picker.ts";

/** settings builds valid settings holding the given maps. */
function settings(over: Partial<docketSettings> = {}): docketSettings {
    return {
        ...DEFAULT_SETTINGS,
        site: "ex",
        account: "a@ex.com",
        ...over,
    };
}

/** space builds a space list entry. */
function space(key: string, name: string, type = "global"): Space {
    return {
        id: `id-${key}`,
        key,
        name,
        type,
        status: "current",
        homepageId: "1",
    };
}

/** kid builds one listing entry. */
function kid(id: string, type: "page" | "folder", title = `T${id}`): ChildNode {
    return { id, type, title, status: "current" };
}

const ENG = spaceNode(space("ENG", "Engineering"));

/** child returns the only child node a listing of one entry builds. */
function child(s: docketSettings, parent: TreeNode, k: ChildNode): TreeNode {
    const [node] = childNodes(s, parent, [k]);
    if (node === undefined) throw new Error("no child");
    return node;
}

describe("groupSpaces", () => {
    const spaces = [
        space("~other", "Bob", "personal"),
        space("ENG", "Engineering"),
        space("~me", "Me", "personal"),
        space("KB", "Knowledge", "knowledge_base"),
    ];

    it("splits team and personal spaces, own personal first", () => {
        const have = groupSpaces(spaces, "", "me");

        expect(have.team.map((sp) => sp.key)).toEqual(["ENG", "KB"]);
        expect(have.personal.map((sp) => sp.key)).toEqual(["~me", "~other"]);
    });

    it("filters by name or key, ignoring case", () => {
        expect(groupSpaces(spaces, "know", "me").team).toHaveLength(1);
        expect(groupSpaces(spaces, "eng", "me").team).toHaveLength(1);
        expect(groupSpaces(spaces, " BOB ", "me").personal).toHaveLength(1);
        expect(groupSpaces(spaces, "zzz", "me")).toEqual({
            team: [],
            personal: [],
        });
    });
});

describe("sourceOf", () => {
    it("builds page, folder, and space sources", () => {
        expect(sourceOf("page", "ENG", "1")).toBe("/wiki/spaces/ENG/pages/1");
        expect(sourceOf("folder", "ENG", "2")).toBe(
            "/wiki/spaces/ENG/folder/2",
        );
        expect(sourceOf("space", "ENG", "ENG")).toBe(
            "/wiki/spaces/ENG/overview",
        );
    });
});

describe("syncedAs", () => {
    const s = settings({
        pages: { "p.md": "https://ex.atlassian.net/wiki/spaces/ENG/pages/7/T" },
        folders: { f: "/wiki/spaces/ENG/folder/8" },
        spaces: { eng: "/wiki/spaces/ENG/overview" },
    });

    it("matches a location by page id, folder id, and space key", () => {
        expect(syncedAs(s, child(s, ENG, kid("7", "page")))?.dest).toBe("p.md");
        expect(syncedAs(s, child(s, ENG, kid("8", "folder")))?.dest).toBe("f");
        expect(syncedAs(s, ENG)?.dest).toBe("eng");
    });

    it("is null for an unsynced node", () => {
        expect(syncedAs(s, child(s, ENG, kid("9", "page")))).toBeNull();
        expect(syncedAs(s, child(s, ENG, kid("7", "folder")))).toBeNull();
    });
});

describe("childNodes", () => {
    const synced = settings({
        folders: { f: "/wiki/spaces/ENG/folder/8" },
        spaces: { eng: "/wiki/spaces/ENG/overview" },
    });

    it("covers a synced space's subtree, pages included", () => {
        const page = child(synced, ENG, kid("1", "page"));
        const grand = child(synced, page, kid("2", "page"));

        expect(page.cover).toEqual({ dest: "eng", deep: true });
        expect(grand.cover).toEqual({ dest: "eng", deep: true });
        expect(page.src).toBe("/wiki/spaces/ENG/pages/1");
    });

    it("leaves pages beside the homepage uncovered", () => {
        const [inside, beside] = childNodes(
            synced,
            ENG,
            [kid("1", "page")],
            [kid("2", "page")],
        );

        expect(inside?.cover).not.toBeNull();
        expect(beside?.cover).toBeNull();
    });

    it("covers a synced folder's pages and sub-folders, not page children", () => {
        const s = settings({ folders: { f: "/wiki/spaces/ENG/folder/8" } });
        const folder = child(s, ENG, kid("8", "folder"));
        const sub = child(s, folder, kid("9", "folder"));
        const page = child(s, sub, kid("10", "page"));
        const grand = child(s, page, kid("11", "page"));

        expect(folder.cover).toBeNull();
        expect(sub.cover).toEqual({ dest: "f", deep: false });
        expect(page.cover).toEqual({ dest: "f", deep: false });
        expect(grand.cover).toBeNull();
    });

    it("does not cover a synced page's children", () => {
        const s = settings({ pages: { "p.md": "/wiki/spaces/ENG/pages/7" } });
        const page = child(s, ENG, kid("7", "page"));

        expect(child(s, page, kid("8", "page")).cover).toBeNull();
    });
});

describe("toggle", () => {
    const s = settings({ spaces: { eng: "/wiki/spaces/ENG/overview" } });
    const page = child(s, ENG, kid("1", "page", "Release Notes"));

    it("adds an unsynced node at its title's path, and undoes it", () => {
        const added = toggle(s, emptyDraft(), page);

        expect(added.adds.get(page.key)?.dest).toBe("Release Notes.md");
        expect(isTicked(s, added, page)).toBe(true);
        expect(changeCount(toggle(s, added, page))).toBe(0);
    });

    it("removes a synced node, and undoes it", () => {
        const removed = toggle(s, emptyDraft(), ENG);

        expect(removed.removes.get(ENG.key)?.dest).toBe("eng");
        expect(isTicked(s, removed, ENG)).toBe(false);
        expect(isTicked(s, toggle(s, removed, ENG), ENG)).toBe(true);
    });

    it("leaves the input draft unchanged", () => {
        const d = emptyDraft();
        toggle(s, d, page);

        expect(changeCount(d)).toBe(0);
    });
});

describe("setDest", () => {
    it("changes an addition's path, trimmed", () => {
        const s = settings();
        const page = child(s, ENG, kid("1", "page"));
        const d = setDest(toggle(s, emptyDraft(), page), page.key, " a/b.md ");

        expect(d.adds.get(page.key)?.dest).toBe("a/b.md");
    });

    it("ignores an unknown key", () => {
        const d = emptyDraft();

        expect(setDest(d, "page:1", "x.md")).toBe(d);
    });
});

describe("review", () => {
    it("applies removals and additions to the settings", () => {
        const s = settings({ spaces: { eng: "/wiki/spaces/ENG/overview" } });
        const page = child(s, ENG, kid("1", "page", "Notes"));
        const d = toggle(s, toggle(s, emptyDraft(), ENG), page);

        const have = review(s, d, "tok");

        expect(have.rows.map((r) => [r.op, r.location.dest])).toEqual([
            ["remove", "eng"],
            ["add", "Notes.md"],
        ]);
        expect(have.settings.spaces).toEqual({});
        expect(have.settings.pages).toEqual({
            "Notes.md": "/wiki/spaces/ENG/pages/1",
        });
        expect(canSave(have)).toBe(true);
    });

    it("refuses two additions at the same path", () => {
        const s = settings();
        const a = child(s, ENG, kid("1", "page", "Same"));
        const b = child(s, ENG, kid("2", "page", "Same"));
        const d = toggle(s, toggle(s, emptyDraft(), a), b);

        const have = review(s, d, "tok");

        expect(have.rows[0]?.error).toBe("");
        expect(have.rows[1]?.error).toBe(
            "Same.md is already a synced location.",
        );
        expect(canSave(have)).toBe(false);
    });

    it("reports a config error of the whole result", () => {
        const s = settings({ spaces: { docs: "/wiki/spaces/ENG/overview" } });
        const folder = child(s, ENG, kid("8", "folder"));
        const d = setDest(
            toggle(s, emptyDraft(), folder),
            folder.key,
            "docs/f",
        );

        const have = review(s, d, "tok");

        expect(have.rows[0]?.error).toBe("");
        expect(have.configError).not.toBe("");
        expect(canSave(have)).toBe(false);
    });

    it("cannot save an empty draft", () => {
        expect(canSave(review(settings(), emptyDraft(), "tok"))).toBe(false);
    });
});

describe("rename", () => {
    const synced = (): docketSettings =>
        settings({
            spaces: { eng: "/wiki/spaces/ENG/overview" },
            pages: { "docs/FAQ.md": "/wiki/spaces/ENG/pages/5" },
            names: { "2": "Kept" },
        });

    it("tells what renaming a node edits", () => {
        const s = synced();
        const covered = child(s, ENG, kid("1", "page"));
        const root = child(s, ENG, kid("5", "page"));
        const folder = child(s, ENG, kid("8", "folder"));

        expect(renameKind(s, emptyDraft(), ENG)).toBe("root");
        expect(renameKind(s, emptyDraft(), root)).toBe("root");
        expect(renameKind(s, emptyDraft(), covered)).toBe("override");
        expect(renameKind(s, emptyDraft(), folder)).toBeNull();
        expect(renameKind(s, toggle(s, emptyDraft(), ENG), ENG)).toBeNull();
        const loose = child(settings(), ENG, kid("9", "page"));
        const added = toggle(settings(), emptyDraft(), loose);
        expect(renameKind(settings(), added, loose)).toBeNull();
    });

    it("reads a root's file or directory name and a page's override", () => {
        const s = synced();

        expect(currentName(s, ENG)).toBe("eng");
        expect(currentName(s, child(s, ENG, kid("5", "page")))).toBe("FAQ");
        expect(currentName(s, child(s, ENG, kid("2", "page")))).toBe("Kept");
        expect(currentName(s, child(s, ENG, kid("3", "page")))).toBe("");
    });

    it("drops a rename back to the current name or to empty for a root", () => {
        const s = synced();
        const page = child(s, ENG, kid("2", "page"));

        let d = setRename(s, emptyDraft(), page, " New ");
        expect(localName(s, d, page)).toBe("New");
        expect(changeCount(d)).toBe(1);
        d = setRename(s, d, page, "Kept");
        expect(changeCount(d)).toBe(0);
        expect(changeCount(setRename(s, emptyDraft(), ENG, ""))).toBe(0);
    });

    it("forgets a pending rename when the node is ticked or unticked", () => {
        const s = synced();
        const d = setRename(s, emptyDraft(), ENG, "engineering");

        expect(changeCount(toggle(s, d, ENG))).toBe(1); // the removal only
        expect(toggle(s, d, ENG).renames.size).toBe(0);
    });

    it("saves a covered page's name override", () => {
        const s = synced();
        const page = child(s, ENG, kid("1", "page", "Start Here"));
        const d = setRename(s, emptyDraft(), page, "Start");

        const have = review(s, d, "tok");

        expect(have.rows.map((r) => [r.op, r.pageId, r.location.dest])).toEqual(
            [["rename", "1", "Start.md"]],
        );
        expect(have.settings.names).toEqual({ "1": "Start", "2": "Kept" });
        expect(canSave(have)).toBe(true);
    });

    it("clears a name override renamed to empty", () => {
        const s = synced();
        const page = child(s, ENG, kid("2", "page"));

        const have = review(s, setRename(s, emptyDraft(), page, ""), "tok");

        expect(have.rows[0]?.location.dest).toBe("");
        expect(have.settings.names).toEqual({});
        expect(canSave(have)).toBe(true);
    });

    it("renames a synced root by editing its config key", () => {
        const s = synced();
        const root = child(s, ENG, kid("5", "page"));
        let d = setRename(s, emptyDraft(), root, "Questions");
        d = setRename(s, d, ENG, "engineering");

        const have = review(s, d, "tok");

        expect(have.rows.map((r) => [r.op, r.location.dest])).toEqual([
            ["rename", "docs/Questions.md"],
            ["rename", "engineering"],
        ]);
        expect(have.settings.pages).toEqual({
            "docs/Questions.md": "/wiki/spaces/ENG/pages/5",
        });
        expect(have.settings.spaces).toEqual({
            engineering: "/wiki/spaces/ENG/overview",
        });
        expect(canSave(have)).toBe(true);
    });

    it("refuses an invalid name and a root rename onto a taken path", () => {
        const s = synced();
        const page = child(s, ENG, kid("1", "page"));
        const root = child(s, ENG, kid("5", "page"));
        const taken = settings({
            ...s,
            pages: { ...s.pages, "docs/Taken.md": "/wiki/spaces/ENG/pages/6" },
        });

        const bad = review(s, setRename(s, emptyDraft(), page, "a/b"), "tok");
        const clash = review(
            taken,
            setRename(taken, emptyDraft(), root, "Taken"),
            "tok",
        );

        expect(bad.rows[0]?.error).toBe('name "a/b" must not contain "/"');
        expect(canSave(bad)).toBe(false);
        expect(clash.rows[0]?.error).toBe(
            "docs/Taken.md is already a synced location.",
        );
        expect(canSave(clash)).toBe(false);
    });
});
