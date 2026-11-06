// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    electronDialog,
    type OpenDialog,
    type OpenDialogOptions,
    pickFile,
    pickFolder,
} from "../../src/settings/native-picker.ts";

/** fakeDialog answers with `filePaths`, keeping the options it was given. */
function fakeDialog(filePaths: string[], canceled = false) {
    const seen: OpenDialogOptions[] = [];
    const dialog: OpenDialog = {
        showOpenDialog: async (opts) => {
            seen.push(opts);
            return { canceled, filePaths };
        },
    };
    return { dialog, seen };
}

describe("electronDialog", () => {
    it("returns the dialog Electron's remote module offers", () => {
        // --- Given ---
        const { dialog } = fakeDialog([]);

        // --- When ---
        const have = electronDialog(() => ({ remote: { dialog } }));

        // --- Then ---
        expect(have).toBe(dialog);
    });

    it("returns null without a remote module", () => {
        expect(electronDialog(() => ({}))).toBeNull();
    });

    it("returns null when Electron cannot be loaded", () => {
        // --- Given ---
        const load = (): unknown => {
            throw new Error("no electron");
        };

        // --- When ---
        const have = electronDialog(load);

        // --- Then ---
        expect(have).toBeNull();
    });
});

describe("pickFile", () => {
    it("returns the chosen file", async () => {
        // --- Given ---
        const { dialog } = fakeDialog(["/home/me/.docket.yaml"]);

        // --- When ---
        const have = await pickFile(dialog, "Import");

        // --- Then ---
        expect(have).toBe("/home/me/.docket.yaml");
    });

    it("shows hidden files, as .docket.yaml is one", async () => {
        // --- Given ---
        const { dialog, seen } = fakeDialog(["/a"]);

        // --- When ---
        await pickFile(dialog, "Import");

        // --- Then ---
        expect(seen[0]?.title).toBe("Import");
        expect(seen[0]?.properties).toEqual(["openFile", "showHiddenFiles"]);
    });

    it("returns null when cancelled", async () => {
        // --- Given ---
        const { dialog } = fakeDialog(["/a"], true);

        // --- When ---
        const have = await pickFile(dialog, "Import");

        // --- Then ---
        expect(have).toBeNull();
    });

    it("returns null when nothing is chosen", async () => {
        // --- Given ---
        const { dialog } = fakeDialog([]);

        // --- When ---
        const have = await pickFile(dialog, "Import");

        // --- Then ---
        expect(have).toBeNull();
    });
});

describe("pickFolder", () => {
    it("returns the chosen folder and allows a new one", async () => {
        // --- Given ---
        const { dialog, seen } = fakeDialog(["/home/me/out"]);

        // --- When ---
        const have = await pickFolder(dialog, "Export");

        // --- Then ---
        expect(have).toBe("/home/me/out");
        expect(seen[0]?.title).toBe("Export");
        expect(seen[0]?.properties).toEqual([
            "openDirectory",
            "createDirectory",
        ]);
    });

    it("returns null when cancelled", async () => {
        // --- Given ---
        const { dialog } = fakeDialog([], true);

        // --- When ---
        const have = await pickFolder(dialog, "Export");

        // --- Then ---
        expect(have).toBeNull();
    });
});
