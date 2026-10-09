// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { RemoteBody } from "@docket/core";
import { describe, expect, it } from "vitest";
import type docketPlugin from "../../src/main.ts";
import { BarBaseFeature } from "../../src/ui/bar-base-feature.ts";
import { confluenceBase } from "../../src/ui/remote-diff.ts";

/**
 * FakePlugin is the slice of the plugin the feature reaches: the workspace's
 * active file and events, event registration, the controller's status,
 * subscription and touch, and git's text at a commit.
 */
class FakePlugin {
    active: string | null = null;
    touches = 0;
    bodies = new Map<string, RemoteBody>();
    /** Commit texts by `hash:path`; a missing one fails the read. */
    texts = new Map<string, string>();
    reads = 0;
    private readonly events = new Map<string, () => void>();
    private listener: () => void = () => {};

    readonly app = {
        workspace: {
            getActiveFile: () =>
                this.active === null ? null : { path: this.active },
            on: (name: string, fn: () => void) => {
                this.events.set(name, fn);
                return name;
            },
        },
    };

    readonly controller = {
        status: { bodies: this.bodies } as { bodies: Map<string, RemoteBody> },
        subscribe: (fn: () => void) => {
            this.listener = fn;
            return () => {};
        },
        touch: () => {
            this.touches++;
        },
    };

    readonly git = {
        textAt: (hash: string, path: string): Promise<string> => {
            this.reads++;
            const text = this.texts.get(`${hash}:${path}`);
            return text === undefined
                ? Promise.reject(new Error("bad revision"))
                : Promise.resolve(text);
        },
    };

    registerEvent(): void {}
    register(): void {}

    /** fire triggers a workspace event the feature registered for. */
    fire(name: string): void {
        this.events.get(name)?.();
    }

    /** notify runs the controller subscription, as a status check does. */
    notify(): void {
        this.listener();
    }
}

/** setup loads a feature over a fake plugin, counting bar refreshes. */
function setup(): { p: FakePlugin; f: BarBaseFeature; refreshes: number[] } {
    const p = new FakePlugin();
    const f = new BarBaseFeature(p as unknown as docketPlugin);
    const refreshes = [0];
    f.load(() => {
        refreshes[0] = (refreshes[0] ?? 0) + 1;
    });
    return { p, f, refreshes };
}

describe("BarBaseFeature", () => {
    it("toggles the opened note into Confluence mode", async () => {
        const { p, f } = setup();
        p.bodies.set("a.md", { body: "remote\n" });

        f.open("a.md");
        f.toggle("a.md");

        expect(f.opened).toBe("a.md");
        expect(f.isOn("a.md")).toBe(true);
        expect(await f.base("a.md", "local\n")).toEqual({
            source: { kind: "confluence" },
            text: confluenceBase("local\n", "remote\n"),
        });
        expect(p.touches).toBe(2);
    });

    it("compares against HEAD for another note or with the diff off", async () => {
        const { p, f } = setup();
        p.bodies.set("a.md", { body: "remote\n" });
        f.open("a.md");

        expect(await f.base("a.md", "local\n")).toBeNull();
        f.toggle("b.md");
        expect(await f.base("b.md", "local\n")).toBeNull();
        expect(p.touches).toBe(1);
    });

    it("compares against HEAD when the remote body failed to load", async () => {
        const { p, f } = setup();
        p.bodies.set("a.md", { error: "HTTP 500" });
        f.open("a.md");
        f.toggle("a.md");

        const have = await f.base("a.md", "local\n");

        expect(have).toBeNull();
    });

    it("forgets the opened note when another note is focused", () => {
        const { p, f } = setup();
        f.open("a.md");
        p.active = "a.md";
        p.fire("file-open");
        expect(f.opened).toBe("a.md");

        p.active = "b.md";
        p.fire("active-leaf-change");

        expect(f.opened).toBeNull();
        expect(p.touches).toBe(2);
    });

    it("compares against the picked commit, not Confluence", async () => {
        const { p, f } = setup();
        p.bodies.set("a.md", { body: "remote\n" });
        p.texts.set("h1:old.md", "then\n");
        f.open("a.md");
        f.toggle("a.md");

        f.pick({ note: "a.md", hash: "h1", path: "old.md", at: 7 });

        expect(f.commit?.hash).toBe("h1");
        expect(await f.base("a.md", "local\n")).toEqual({
            source: { kind: "commit", at: 7 },
            text: "then\n",
        });
        expect(p.touches).toBe(3);
    });

    it("reads a picked commit's text once", async () => {
        const { p, f } = setup();
        p.texts.set("h1:a.md", "then\n");
        f.pick({ note: "a.md", hash: "h1", path: "a.md", at: 0 });

        await f.base("a.md", "");
        await f.base("a.md", "");

        expect(p.reads).toBe(1);
    });

    it("shows no bars when the commit cannot be read", async () => {
        const { f } = setup();
        f.pick({ note: "a.md", hash: "gone", path: "a.md", at: 0 });

        const have = await f.base("a.md", "");

        expect(have).toEqual({
            source: { kind: "commit", at: 0 },
            text: undefined,
        });
    });

    it("forgets the pick when another note is focused", () => {
        const { p, f } = setup();
        f.pick({ note: "a.md", hash: "h1", path: "a.md", at: 0 });

        p.active = "b.md";
        p.fire("file-open");

        expect(f.commit).toBeNull();
    });

    it("turns the diff off when a status check drops the body", () => {
        const { p, f, refreshes } = setup();
        p.bodies.set("a.md", { body: "remote\n" });
        f.open("a.md");
        f.toggle("a.md");

        p.bodies.delete("a.md");
        p.notify();

        expect(f.isOn("a.md")).toBe(false);
        expect(refreshes[0]).toBe(1);
    });
});
