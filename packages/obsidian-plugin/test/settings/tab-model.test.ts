// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { DEFAULT_SETTINGS } from "@docket/core";
import { describe, expect, it } from "vitest";
import {
    connectedAs,
    errorMessage,
    syncFolderDesc,
    validation,
    wholeNumber,
} from "../../src/settings/tab-model.ts";

describe("wholeNumber", () => {
    it("reads a non-negative whole number, trimmed", () => {
        expect(wholeNumber(" 42 ")).toBe(42);
        expect(wholeNumber("0")).toBe(0);
    });

    it("rejects anything else", () => {
        expect(wholeNumber("")).toBeNull();
        expect(wholeNumber("-1")).toBeNull();
        expect(wholeNumber("1.5")).toBeNull();
        expect(wholeNumber("x")).toBeNull();
    });
});

describe("errorMessage", () => {
    it("reads an Error's message or stringifies anything else", () => {
        expect(errorMessage(new Error("boom"))).toBe("boom");
        expect(errorMessage("plain")).toBe("plain");
    });
});

describe("validation", () => {
    const connected = { ...DEFAULT_SETTINGS, site: "ex", account: "a@ex.com" };

    it("is clean for valid settings", () => {
        expect(validation(connected, "t")).toEqual({ message: "", dest: "" });
    });

    it("strips the config prefix and names the row an error points at", () => {
        const s = {
            ...connected,
            pages: { "a.txt": "/wiki/spaces/X/pages/1" },
        };

        const have = validation(s, "t");

        expect(have).toEqual({
            message: 'page destination "a.txt" must end in .md',
            dest: "a.txt",
        });
    });
});

describe("connectedAs", () => {
    it("names the user, falling back to the account id", () => {
        expect(connectedAs({ displayName: "Ann", accountId: "u1" })).toBe(
            "Connected as Ann",
        );
        expect(connectedAs({ displayName: "", accountId: "u1" })).toBe(
            "Connected as u1",
        );
    });
});

describe("syncFolderDesc", () => {
    it("names the manual steps to change a set sync folder", () => {
        expect(syncFolderDesc("confluence")).toBe(
            'The vault folder every location below is relative to, kept in its own git repository. It cannot be changed here. To change it: disable the docket plugin, edit "syncRoot" in its data.json, and move the folder by hand.',
        );
    });

    it("points an unset one to the setup step", () => {
        expect(syncFolderDesc("")).toBe(
            "Not set yet. Choose it in the docket panel's Sync tab.",
        );
    });
});
