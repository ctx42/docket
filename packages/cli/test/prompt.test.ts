// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type {
    CreateInput,
    PublishPlan,
    ReplyCandidate,
    StaleItem,
} from "@docket/core";
import { describe, expect, it } from "vitest";
import {
    confirmCreates,
    confirmOverwrite,
    confirmPublish,
    confirmReplies,
    confirmStale,
    type PromptOptions,
} from "../src/prompt.ts";
import type { KeySource } from "../src/select.ts";

/** scripted is a KeySource replaying `keys`, then failing like a closed stdin. */
function scripted(keys: string[]): KeySource & { closed: boolean } {
    let i = 0;
    const src = {
        closed: false,
        next: () =>
            i < keys.length
                ? Promise.resolve(keys[i++] ?? "")
                : Promise.reject(new Error("prompt: input closed")),
        close: () => {
            src.closed = true;
        },
    };
    return src;
}

const cand = (dest: string): CreateInput => ({
    dest,
    title: dest,
    spaceId: "9",
    parentId: "",
    folders: [],
});

/** opts builds PromptOptions with an ask driven by a scripted answer list. */
function opts(
    over: Partial<PromptOptions>,
    answers: string[] = [],
): PromptOptions {
    let i = 0;
    return {
        syncRoot: "/v",
        isTTY: true,
        yes: false,
        err: () => {},
        ask: () => Promise.resolve(answers[i++] ?? ""),
        keys: () => scripted([]),
        markNever: () => Promise.resolve(),
        ...over,
    };
}

describe("confirmCreates", () => {
    it("accepts every candidate with --yes and never prompts", async () => {
        let asked = 0;
        const decided = await confirmCreates(
            [cand("/v/a.md"), cand("/v/b.md")],
            opts({
                yes: true,
                ask: () => {
                    asked++;
                    return Promise.resolve("");
                },
            }),
        );
        expect([...decided.values()]).toEqual([true, true]);
        expect(asked).toBe(0);
    });

    it("creates nothing when enter is pressed straight away", async () => {
        const marked: string[] = [];
        const decided = await confirmCreates(
            [cand("/v/a.md"), cand("/v/b.md")],
            opts({
                keys: () => scripted(["\r"]),
                markNever: (d) => {
                    marked.push(d);
                    return Promise.resolve();
                },
            }),
        );
        expect([...decided.values()]).toEqual([false, false]);
        expect(marked).toEqual([]);
    });

    it("creates ticked pages, marks never ones, and skips the rest", async () => {
        const marked: string[] = [];
        const keys = scripted([
            "c",
            "\x1b[B",
            "n",
            "\x1b[B",
            " ",
            " ",
            " ",
            "\r",
        ]);
        const decided = await confirmCreates(
            [cand("/v/a.md"), cand("/v/b.md"), cand("/v/c.md")],
            opts({
                keys: () => keys,
                markNever: (d) => {
                    marked.push(d);
                    return Promise.resolve();
                },
            }),
        );
        expect(decided.get("/v/a.md")).toBe(true);
        expect(decided.get("/v/b.md")).toBe(false);
        expect(decided.get("/v/c.md")).toBe(false);
        expect(marked).toEqual(["/v/b.md"]);
        expect(keys.closed).toBe(true);
    });

    it("aborts on cancel without marking anything", async () => {
        const marked: string[] = [];
        await expect(
            confirmCreates(
                [cand("/v/a.md")],
                opts({
                    keys: () => scripted(["n", "q"]),
                    markNever: (d) => {
                        marked.push(d);
                        return Promise.resolve();
                    },
                }),
            ),
        ).rejects.toThrow("push cancelled");
        expect(marked).toEqual([]);
    });

    it("refuses to prompt without a terminal", async () => {
        await expect(
            confirmCreates([cand("/v/a.md")], opts({ isTTY: false })),
        ).rejects.toThrow("re-run with --yes");
    });
});

describe("confirmStale", () => {
    const items: StaleItem[] = [
        { path: "/v/a.md", isDir: false },
        { path: "/v/sub", isDir: true },
    ];

    it("removes all with --yes", async () => {
        expect(await confirmStale(items, opts({ yes: true }))).toEqual(items);
    });

    it("removes on y and nothing on n", async () => {
        expect(await confirmStale(items, opts({}, ["y"]))).toEqual(items);
        expect(await confirmStale(items, opts({}, ["n"]))).toEqual([]);
    });

    it("refuses to prompt without a terminal", async () => {
        await expect(
            confirmStale(items, opts({ isTTY: false })),
        ).rejects.toThrow("re-run with --yes");
    });
});

describe("confirmOverwrite", () => {
    it("lists the notes and goes on only on yes", async () => {
        let shown = "";
        const o = opts({ err: (t) => (shown += t) }, ["y"]);

        expect(await confirmOverwrite(["a.md", "b.md"], o)).toBe(true);
        expect(shown).toContain("  a.md\n  b.md\n");
        expect(await confirmOverwrite(["a.md"], opts({}, [""]))).toBe(false);
    });

    it("accepts with --yes and refuses without a terminal", async () => {
        expect(await confirmOverwrite(["a.md"], opts({ yes: true }))).toBe(
            true,
        );
        await expect(
            confirmOverwrite(["a.md"], opts({ isTTY: false })),
        ).rejects.toThrow("re-run with --yes");
    });
});

describe("confirmPublish", () => {
    const plan: PublishPlan = {
        dest: "/v/docs/p.md",
        accountId: "me",
        items: [
            { id: "F1", kind: "folder", title: "Docs" },
            { id: "555", kind: "page", title: "Page" },
        ],
        warning: "",
    };

    it("lists what becomes visible and goes on only on yes", async () => {
        let shown = "";
        const o = opts({ err: (t) => (shown += t) }, ["yes"]);

        expect(await confirmPublish(plan, o)).toBe(true);
        expect(shown).toBe(
            "docket: publishing docs/p.md lifts your restriction from:\n" +
                '  folder "Docs"\n  page "Page"\n',
        );
        expect(await confirmPublish(plan, opts({}, ["n"]))).toBe(false);
    });

    it("accepts with --yes and refuses without a terminal", async () => {
        let asked = 0;
        const o = opts({
            yes: true,
            ask: () => {
                asked++;
                return Promise.resolve("");
            },
        });

        expect(await confirmPublish(plan, o)).toBe(true);
        expect(asked).toBe(0);
        await expect(
            confirmPublish(plan, opts({ isTTY: false })),
        ).rejects.toThrow("re-run with --yes");
    });
});

describe("confirmReplies", () => {
    const reply = (key: string, mark = ""): ReplyCandidate => ({
        dest: "/v/p.md",
        key,
        to: "Jane Doe",
        text: `text ${key}`,
        mark,
    });

    it("sends every draft with --yes, holding only those that cannot go", async () => {
        const lines: string[] = [];

        const have = await confirmReplies(
            [reply("C1#1"), reply("C9#1", "thread id:C9 is gone")],
            opts({ yes: true, err: (t) => lines.push(t) }),
        );

        expect(have).toEqual(new Map([["/v/p.md", new Set(["C9#1"])]]));
        expect(lines.join("")).toBe(
            "docket: 1 reply draft(s) to send:\n" +
                '  p.md — Reply to Jane Doe: "text C1#1"\n',
        );
    });

    it("sends every draft when enter is pressed straight away", async () => {
        const have = await confirmReplies(
            [reply("C1#1"), reply("C2#1")],
            opts({ keys: () => scripted(["\r"]) }),
        );

        expect(have).toEqual(new Map());
    });

    it("holds the drafts marked hold", async () => {
        const keys = scripted(["\x1b[B", "h", "\r"]);

        const have = await confirmReplies(
            [reply("C1#1"), reply("C2#1")],
            opts({ keys: () => keys }),
        );

        expect(have).toEqual(new Map([["/v/p.md", new Set(["C2#1"])]]));
        expect(keys.closed).toBe(true);
    });

    it("asks nothing when no draft can go", async () => {
        const have = await confirmReplies(
            [reply("C9#1", "thread id:C9 is gone")],
            opts({ isTTY: false }),
        );

        expect(have).toEqual(new Map([["/v/p.md", new Set(["C9#1"])]]));
    });

    it("refuses to prompt without a terminal", async () => {
        await expect(
            confirmReplies([reply("C1#1")], opts({ isTTY: false })),
        ).rejects.toThrow("re-run with --yes");
    });

    it("cancels the push on cancel", async () => {
        await expect(
            confirmReplies(
                [reply("C1#1")],
                opts({ keys: () => scripted(["\x1b"]) }),
            ),
        ).rejects.toThrow("push cancelled");
    });
});
