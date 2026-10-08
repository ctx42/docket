// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { RemoteBody } from "@docket/core";
import { describe, expect, it } from "vitest";
import type docketPlugin from "../../src/main.ts";
import { confluenceBase } from "../../src/ui/remote-diff.ts";
import { RemoteDiffFeature } from "../../src/ui/remote-diff-feature.ts";

/**
 * FakePlugin is the slice of the plugin the feature reaches: the workspace's
 * active file and events, event registration, and the controller's status,
 * subscription and touch.
 */
class FakePlugin {
    active: string | null = null;
    touches = 0;
    bodies = new Map<string, RemoteBody>();
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
function setup(): { p: FakePlugin; f: RemoteDiffFeature; refreshes: number[] } {
    const p = new FakePlugin();
    const f = new RemoteDiffFeature(p as unknown as docketPlugin);
    const refreshes = [0];
    f.load(() => {
        refreshes[0] = (refreshes[0] ?? 0) + 1;
    });
    return { p, f, refreshes };
}

describe("RemoteDiffFeature", () => {
    it("toggles the opened note into Confluence mode", () => {
        const { p, f } = setup();
        p.bodies.set("a.md", { body: "remote\n" });

        f.open("a.md");
        f.toggle("a.md");

        expect(f.opened).toBe("a.md");
        expect(f.isOn("a.md")).toBe(true);
        expect(f.base("a.md", "local\n")).toBe(
            confluenceBase("local\n", "remote\n"),
        );
        expect(p.touches).toBe(2);
    });

    it("compares against HEAD for another note or with the diff off", () => {
        const { p, f } = setup();
        p.bodies.set("a.md", { body: "remote\n" });
        f.open("a.md");

        expect(f.base("a.md", "local\n")).toBeNull();
        f.toggle("b.md");
        expect(f.base("b.md", "local\n")).toBeNull();
        expect(p.touches).toBe(1);
    });

    it("compares against HEAD when the remote body failed to load", () => {
        const { p, f } = setup();
        p.bodies.set("a.md", { error: "HTTP 500" });
        f.open("a.md");
        f.toggle("a.md");

        const have = f.base("a.md", "local\n");

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
