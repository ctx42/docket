// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Watcher } from "@docket/docserver-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    NODE_PROBE,
    type PathProbe,
    underVault,
    type VaultEvent,
    VaultNotifier,
    VaultWatchers,
} from "../../src/mcp/vault-notifier.ts";

/** Probe counts what a notifier delivers. */
class Probe {
    changes = 0;
    closed = 0;

    constructor(ntf: Watcher) {
        ntf.listen({
            change: () => {
                this.changes++;
            },
            error: () => {},
            closed: () => {
                this.closed++;
            },
        });
    }
}

/** signals reports whether ev signals a notifier over /v/docs and /v/a.md. */
function signals(ev: VaultEvent): boolean {
    const ntf = new VaultNotifier(["/v/docs"], ["/v/a.md"]);
    const probe = new Probe(ntf);
    ntf.event(ev);
    return probe.changes > 0;
}

describe("VaultNotifier", () => {
    it.each<[string, VaultEvent, boolean]>([
        [
            "modified note",
            { kind: "modify", path: "/v/docs/x.md", folder: false },
            true,
        ],
        [
            "modified other file",
            { kind: "modify", path: "/v/docs/x.png", folder: false },
            false,
        ],
        [
            "created note",
            { kind: "create", path: "/v/docs/sub/x.md", folder: false },
            true,
        ],
        [
            "created other file",
            { kind: "create", path: "/v/docs/notes.txt", folder: false },
            false,
        ],
        [
            "created folder",
            { kind: "create", path: "/v/docs/sub", folder: true },
            true,
        ],
        [
            "deleted other file",
            { kind: "delete", path: "/v/docs/x.png", folder: false },
            true,
        ],
        [
            "deleted folder",
            { kind: "delete", path: "/v/docs/sub", folder: true },
            true,
        ],
        [
            "renamed within",
            {
                kind: "rename",
                path: "/v/docs/b.txt",
                folder: false,
                oldPath: "/v/docs/a.txt",
            },
            true,
        ],
        [
            "renamed out",
            {
                kind: "rename",
                path: "/v/out/x.md",
                folder: false,
                oldPath: "/v/docs/x.md",
            },
            true,
        ],
        [
            "renamed in",
            {
                kind: "rename",
                path: "/v/docs/x.md",
                folder: false,
                oldPath: "/v/out/x.md",
            },
            true,
        ],
        [
            "source folder itself deleted",
            { kind: "delete", path: "/v/docs", folder: true },
            true,
        ],
        [
            "sibling with the prefix",
            { kind: "modify", path: "/v/docs2/x.md", folder: false },
            false,
        ],
        [
            "note outside",
            { kind: "modify", path: "/v/out/x.md", folder: false },
            false,
        ],
        [
            "file source modified",
            { kind: "modify", path: "/v/a.md", folder: false },
            true,
        ],
        [
            "file source replaced by rename",
            {
                kind: "rename",
                path: "/v/a.md",
                folder: false,
                oldPath: "/v/a.tmp",
            },
            true,
        ],
        [
            "file source sibling",
            { kind: "modify", path: "/v/b.md", folder: false },
            false,
        ],
    ])("%s", (_name, ev, want) => {
        // --- When ---
        const have = signals(ev);

        // --- Then ---
        expect(have).toBe(want);
    });

    it("stops signalling once closed", () => {
        // --- Given ---
        const closed: VaultNotifier[] = [];
        const ntf = new VaultNotifier(["/v/docs"], [], (n) => closed.push(n));
        const probe = new Probe(ntf);

        // --- When ---
        ntf.close();
        ntf.close();
        ntf.event({ kind: "modify", path: "/v/docs/x.md", folder: false });

        // --- Then ---
        expect(probe.changes).toBe(0);
        expect(probe.closed).toBe(1);
        expect(closed).toEqual([ntf]);
    });

    it("coalesces changes until the sink listens", () => {
        // --- Given ---
        const ntf = new VaultNotifier(["/v/docs"]);
        const ev: VaultEvent = {
            kind: "modify",
            path: "/v/docs/x.md",
            folder: false,
        };
        ntf.event(ev);
        ntf.event(ev);

        // --- When ---
        const probe = new Probe(ntf);

        // --- Then ---
        expect(probe.changes).toBe(1);
    });
});

describe("underVault", () => {
    it.each<[string, string, string[], boolean]>([
        ["inside", "/v", ["/v/docs", "/v/a.md"], true],
        ["the vault itself", "/v", ["/v"], true],
        ["outside", "/v", ["/v/docs", "/elsewhere"], false],
        ["sibling prefix", "/v", ["/v2/docs"], false],
        ["dot folder", "/v", ["/v/.hidden/docs"], false],
        ["dot file", "/v", ["/v/docs/.a.md"], false],
        ["no disk path", "", ["/v/docs"], false],
        ["trailing slash base", "/v/", ["/v/docs"], true],
    ])("%s", (_name, base, paths, want) => {
        // --- When ---
        const have = underVault(base, paths);

        // --- Then ---
        expect(have).toBe(want);
    });
});

/** probe is a {@link PathProbe} over a map of canonical spellings. */
function probe(
    canonical: Record<string, string> = {},
    hidden: string[] = [],
): PathProbe {
    return {
        canonical: async (path) => {
            if (path.includes("missing")) throw new Error("ENOENT");
            return canonical[path] ?? path;
        },
        hidden: async (dir) => hidden.includes(dir),
    };
}

/** noFallback is a fallback factory that must not be used. */
const noFallback = (): never => {
    throw new Error("fallback used");
};

describe("VaultWatchers", () => {
    it("feeds vault notifiers from events and forgets closed ones", async () => {
        // --- Given ---
        const ws = new VaultWatchers(() => "/v", noFallback, probe());
        const ntf = await ws.factory(["/v/docs"], []);
        const p = new Probe(ntf);

        // --- When ---
        ws.event({ kind: "modify", path: "docs/x.md", folder: false });

        // --- Then ---
        expect(p.changes).toBe(1);
        expect(ws.size).toBe(1);
        ntf.close();
        expect(ws.size).toBe(0);
    });

    it("matches paths as the disk spells them", async () => {
        // --- Given --- a symlinked vault and a source spelled in other case.
        const ws = new VaultWatchers(
            () => "/link/v",
            noFallback,
            probe({ "/link/v": "/real/v", "/link/v/Docs": "/real/v/docs" }),
        );
        const p = new Probe(await ws.factory(["/link/v/Docs"], []));

        // --- When ---
        ws.event({
            kind: "rename",
            path: "out.md",
            folder: false,
            oldPath: "docs/x.md",
        });

        // --- Then ---
        expect(p.changes).toBe(1);
    });

    it("ignores events while no notifier is open", () => {
        // --- Given ---
        const ws = new VaultWatchers(() => "/v", noFallback, probe());

        // --- When ---
        ws.event({ kind: "modify", path: "docs/x.md", folder: false });

        // --- Then ---
        expect(ws.size).toBe(0);
    });

    it.each<[string, string, string[], string[], PathProbe]>([
        ["outside the vault", "/v", ["/v/docs", "/elsewhere"], [], probe()],
        ["no disk path", "", ["/v/docs"], [], probe()],
        ["hidden entry", "/v", ["/v/docs"], [], probe({}, ["/v/docs"])],
        ["unresolvable", "/v", ["/v/missing"], [], probe()],
        ["dot-named file", "/v", [], ["/v/.a.md"], probe()],
    ])("falls back for %s", async (_name, base, dirs, files, prb) => {
        // --- Given ---
        const calls: [string[], string[]][] = [];
        const fallback = new VaultNotifier([]);
        const ws = new VaultWatchers(
            () => base,
            (d, f) => {
                calls.push([d, f]);
                return fallback;
            },
            prb,
        );

        // --- When ---
        const have = await ws.factory(dirs, files);

        // --- Then ---
        expect(have).toBe(fallback);
        expect(calls).toEqual([[dirs, files]]);
        expect(ws.size).toBe(0);
    });
});

describe("NODE_PROBE", () => {
    let dir = "";

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "probe-")));
        fs.mkdirSync(join(dir, "docs/sub"), { recursive: true });
        fs.writeFileSync(join(dir, "docs/sub/a.md"), "x");
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("resolves a symlink", async () => {
        // --- Given ---
        fs.symlinkSync(join(dir, "docs"), join(dir, "link"));

        // --- When ---
        const have = await NODE_PROBE.canonical(join(dir, "link"));

        // --- Then ---
        expect(have).toBe(join(dir, "docs"));
    });

    it("ignores dot files other than notes", async () => {
        // --- Given ---
        fs.writeFileSync(join(dir, "docs/sub/.gitignore"), "*.tmp\n");

        // --- When ---
        const have = await NODE_PROBE.hidden(join(dir, "docs"));

        // --- Then ---
        expect(have).toBe(false);
    });

    it.each([["docs/sub/.git/"], ["docs/.trash/"], ["docs/sub/.draft.md"]])(
        "finds a hidden entry at %s",
        async (rel) => {
            // --- Given ---
            if (rel.endsWith("/")) fs.mkdirSync(join(dir, rel));
            else fs.writeFileSync(join(dir, rel), "x");

            // --- When ---
            const have = await NODE_PROBE.hidden(join(dir, "docs"));

            // --- Then ---
            expect(have).toBe(true);
        },
    );
});

describe("Windows vault paths", () => {
    it.each<[string, string[], boolean]>([
        ["inside", ["C:/Vault/docs", "C:/Vault/a.md"], true],
        ["other drive", ["D:/Vault/docs"], false],
        ["dot folder", ["C:/Vault/.obsidian"], false],
    ])("underVault %s", (_name, paths, want) => {
        // --- When ---
        const have = underVault("C:/Vault", paths);

        // --- Then ---
        expect(have).toBe(want);
    });

    it("signals a note change under a drive source", async () => {
        // --- Given ---
        const ws = new VaultWatchers(() => "C:/Vault", noFallback, probe());
        const p = new Probe(await ws.factory(["C:/Vault/docs"], []));

        // --- When ---
        ws.event({ kind: "modify", path: "docs/a.md", folder: false });

        // --- Then ---
        expect(p.changes).toBe(1);
    });
});
