// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { DEFAULT_SETTINGS } from "@docket/core";
import { describe, expect, it } from "vitest";
import {
    bulkAction,
    cardButtons,
    cardDetail,
    changeTooltip,
    destOf,
    followsEnd,
    logLink,
    progressPercent,
    SYNC_FOLDER_SUGGESTION,
    setupStep,
} from "../../src/ui/panel-model.ts";

describe("setupStep", () => {
    const connected = {
        ...DEFAULT_SETTINGS,
        site: "ex",
        account: "a@ex.com",
    };
    const withFolder = { ...connected, syncRoot: "confluence" };
    const absent = (): boolean => false;
    const present = (): boolean => true;

    it("asks to connect while the site, account or token is missing", () => {
        expect(setupStep(DEFAULT_SETTINGS, "t", absent)?.cta).toBe(
            "Connect to Confluence",
        );
        expect(setupStep(connected, "", absent)?.action).toBe("settings");
    });

    it("asks for the sync folder once connected", () => {
        const have = setupStep(connected, "t", absent);

        expect(have).toEqual({
            icon: "folder-plus",
            text: "Choose the top-level folder docket syncs Confluence pages into. Docket keeps it in its own git repository, apart from your notes.",
            cta: "Create folder",
            action: "folder",
        });
        expect(SYNC_FOLDER_SUGGESTION).toBe("confluence");
    });

    it("asks for the sync folder when no location is on disk yet", () => {
        const s = {
            ...connected,
            pages: { "a.md": "/wiki/x/1" },
            spaces: { docs: "/wiki/spaces/D/overview" },
        };

        expect(setupStep(s, "t", absent)?.action).toBe("folder");
    });

    it("offers to move a location already on disk", () => {
        const pages = { ...connected, pages: { "a.md": "/wiki/x/1" } };
        const folders = { ...connected, folders: { team: "/wiki/x/2" } };
        const spaces = { ...connected, spaces: { docs: "/wiki/x/3" } };

        expect(setupStep(pages, "t", present)).toEqual({
            icon: "folder-input",
            text: "This vault syncs pages but has no sync folder, so docket does not pull or push. Choose a top-level folder and docket moves the synced pages into it.",
            cta: "Move pages",
            action: "move",
        });
        expect(setupStep(folders, "t", (d) => d === "team")?.action).toBe(
            "move",
        );
        expect(setupStep(spaces, "t", (d) => d === "docs")?.action).toBe(
            "move",
        );
    });

    it("leaves a location at the vault root to be moved by hand", () => {
        const s = { ...connected, spaces: { ".": "/wiki/x/1" } };

        expect(setupStep(s, "t", absent)).toEqual({
            icon: "alert-triangle",
            text: 'A location syncs into the vault root, so docket cannot move it. Move the synced pages by hand into one top-level folder, set "syncRoot" in the plugin\'s data.json to it, and reload the plugin.',
            cta: "",
            action: "none",
        });
    });

    it("asks for a location once the sync folder is set", () => {
        const have = setupStep(withFolder, "t", absent);

        expect(have).toEqual({
            icon: "file-plus",
            text: "Choose the Confluence pages, folders, or spaces to sync into this vault.",
            cta: "Add a location",
            action: "location",
        });
    });

    it("is done once a location exists", () => {
        const s = { ...withFolder, spaces: { team: "/wiki/spaces/T" } };

        expect(setupStep(s, "t", absent)).toBeNull();
    });
});

describe("cardDetail", () => {
    it("joins the detail and the version, skipping an absent one", () => {
        expect(cardDetail("Local edits", 3)).toBe("Local edits · v3");
        expect(cardDetail("", 3)).toBe("v3");
        expect(cardDetail("Local edits", 0)).toBe("Local edits");
        expect(cardDetail("", 0)).toBe("");
    });
});

describe("cardButtons", () => {
    it("drops discard and leads with the primary action", () => {
        const have = cardButtons(["pull", "push", "discard"], "push");

        expect(have).toEqual(["push", "pull"]);
    });

    it("keeps the order without a shown primary", () => {
        expect(cardButtons(["pull", "push"], null)).toEqual(["pull", "push"]);
        expect(cardButtons(["pull"], "discard")).toEqual(["pull"]);
    });
});

describe("progressPercent", () => {
    it("rounds the share and caps it at 100", () => {
        expect(progressPercent(1, 3)).toBe(33);
        expect(progressPercent(5, 4)).toBe(100);
        expect(progressPercent(0, 0)).toBe(0);
    });
});

describe("bulkAction", () => {
    it("pushes outgoing, diverged and new groups and pulls incoming", () => {
        expect(bulkAction("outgoing")?.op).toBe("push");
        expect(bulkAction("diverged")?.label).toBe("Push all…");
        expect(bulkAction("new")?.label).toBe("Review new pages…");
        expect(bulkAction("incoming")).toEqual({
            icon: "arrow-down",
            label: "Pull all",
            op: "pull",
        });
    });

    it("offers nothing for the other groups", () => {
        expect(bulkAction("conflicts")).toBeNull();
        expect(bulkAction("problems")).toBeNull();
        expect(bulkAction("ignored")).toBeNull();
    });
});

describe("changeTooltip", () => {
    it("names the note and its detail", () => {
        expect(changeTooltip("a.md", "v3 → v5", null)).toBe("a.md\nv3 → v5");
        expect(changeTooltip("a.md", "", { body: "x" })).toBe("a.md");
    });

    it("says why there is no Confluence diff", () => {
        const have = changeTooltip("a.md", "", { error: "HTTP 500" });

        expect(have).toBe("a.md\nNo Confluence diff: HTTP 500");
    });
});

describe("logLink", () => {
    it("splits a line around the page name", () => {
        expect(logLink("pulled a.md (v3)", "a.md")).toEqual({
            before: "pulled ",
            after: " (v3)",
        });
    });

    it("is null when the line lacks the name", () => {
        expect(logLink("pulled b.md", "a.md")).toBeNull();
    });
});

describe("destOf", () => {
    it("joins a name onto the sync root, if any", () => {
        expect(destOf("", "a.md")).toBe("a.md");
        expect(destOf(".", "a.md")).toBe("a.md");
        expect(destOf("wiki", "a.md")).toBe("wiki/a.md");
    });
});

describe("followsEnd", () => {
    it("follows within two pixels of the end", () => {
        expect(followsEnd(98, 200, 100)).toBe(true);
        expect(followsEnd(97, 200, 100)).toBe(false);
    });
});
