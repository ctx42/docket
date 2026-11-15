// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    CommitHistory,
    capHistory,
    firstLine,
    HISTORY_CAP,
    kbName,
    kbRepoId,
    parseHistoryCap,
    type RepoId,
    recordMessage,
} from "../../src/git/history.ts";

describe("kbRepoId and kbName", () => {
    it("round-trip a knowledge base's folder name", () => {
        const id = kbRepoId("kb-team");

        expect(id).toBe("kb:kb-team");
        expect(kbName(id)).toBe("kb-team");
    });

    it("give no name for the vault and sync repositories", () => {
        expect(kbName("vault")).toBeNull();
        expect(kbName("sync")).toBeNull();
    });
});

/** memStore is CommitHistory's storage over a map, counting loads. */
function memStore(seed: Partial<Record<RepoId, string[]>> = {}) {
    const lists = new Map<RepoId, string[]>(
        Object.entries(seed) as [RepoId, string[]][],
    );
    const loads: RepoId[] = [];
    return {
        lists,
        loads,
        load: (repo: RepoId): string[] => {
            loads.push(repo);
            return lists.get(repo) ?? [];
        },
        save: (repo: RepoId, list: string[]): void => {
            lists.set(repo, list);
        },
    };
}

describe("CommitHistory", () => {
    it("loads a repository's messages once, on first use, cut to the cap", () => {
        const store = memStore({ "kb:kb": ["c", "b", "a"] });
        const h = new CommitHistory(store.load, store.save, 2);

        const first = h.get("kb:kb");
        const again = h.get("kb:kb");

        expect(first).toEqual(["c", "b"]);
        expect(again).toEqual(["c", "b"]);
        expect(store.loads).toEqual(["kb:kb"]);
    });

    it("records and saves a message for its repository only", () => {
        const store = memStore({ vault: ["v"] });
        const h = new CommitHistory(store.load, store.save, HISTORY_CAP);

        h.record("kb:kb", "docs: add");

        expect(h.get("kb:kb")).toEqual(["docs: add"]);
        expect(store.lists.get("kb:kb")).toEqual(["docs: add"]);
        expect(h.get("vault")).toEqual(["v"]);
    });

    it("trims and saves every loaded list on a new cap", () => {
        const store = memStore({ vault: ["b", "a"], "kb:kb": ["d", "c"] });
        const h = new CommitHistory(store.load, store.save, HISTORY_CAP);
        h.get("vault");
        h.get("kb:kb");

        h.setCap(1);

        expect(store.lists.get("vault")).toEqual(["b"]);
        expect(store.lists.get("kb:kb")).toEqual(["d"]);
        expect(h.get("sync")).toEqual([]);
    });
});

describe("recordMessage", () => {
    it("puts the trimmed message first and drops its older copy", () => {
        let have: string[] = [];
        for (const m of ["a", "b", " a "]) {
            have = recordMessage(have, m, HISTORY_CAP);
        }

        expect(have).toEqual(["a", "b"]);
    });

    it("drops the oldest entries past the cap", () => {
        let have: string[] = [];
        for (const m of ["a", "b", "c", "d"]) have = recordMessage(have, m, 3);

        expect(have).toEqual(["d", "c", "b"]);
    });

    it("records nothing with a cap of 0", () => {
        expect(recordMessage([], "a", 0)).toEqual([]);
    });

    it("ignores a blank message", () => {
        expect(recordMessage(["a"], "  \n", HISTORY_CAP)).toEqual(["a"]);
    });
});

describe("capHistory", () => {
    it("keeps the newest entries", () => {
        const list = ["8", "7", "6", "5", "4", "3", "2", "1"];

        expect(capHistory(list, 5)).toEqual(["8", "7", "6", "5", "4"]);
        expect(capHistory(list, 0)).toEqual([]);
    });
});

describe("parseHistoryCap", () => {
    it("accepts whole numbers from 0 to 100", () => {
        expect(parseHistoryCap("0")).toBe(0);
        expect(parseHistoryCap(" 20 ")).toBe(20);
        expect(parseHistoryCap("100")).toBe(100);
    });

    it("rejects anything else", () => {
        for (const v of ["abc", "2.5", "-1", "101", ""]) {
            expect(parseHistoryCap(v)).toBeNull();
        }
    });
});

describe("firstLine", () => {
    it("returns a message's first line", () => {
        expect(firstLine("docs: x\n\nbody")).toBe("docs: x");
        expect(firstLine("one\r\ntwo")).toBe("one");
        expect(firstLine("")).toBe("");
    });
});
