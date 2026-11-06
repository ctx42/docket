// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The system's file and folder pickers, for importing and exporting a config
// outside the vault. Obsidian's desktop app reaches them through Electron's
// remote module. The types are local, as the plugin does not depend on Electron.

/** OpenDialogOptions are the picker settings this module uses. */
export interface OpenDialogOptions {
    title: string;
    properties: string[];
    filters?: { name: string; extensions: string[] }[];
}

/** OpenDialog is the part of Electron's `dialog` this module uses. */
export interface OpenDialog {
    showOpenDialog(
        opts: OpenDialogOptions,
    ): Promise<{ canceled: boolean; filePaths: string[] }>;
}

/**
 * electronDialog returns Electron's dialog through `load`, the host's module
 * loader, or null when this Obsidian build does not offer it.
 */
export function electronDialog(
    load: (id: string) => unknown,
): OpenDialog | null {
    try {
        const electron = load("electron") as {
            remote?: { dialog?: OpenDialog };
        };
        return electron.remote?.dialog ?? null;
    } catch {
        return null;
    }
}

/**
 * pickFile asks for one file and returns its path, or null when cancelled. It
 * shows hidden files, because `.docket.yaml` is one on Linux and macOS.
 */
export function pickFile(
    dialog: OpenDialog,
    title: string,
): Promise<string | null> {
    return pick(dialog, {
        title,
        properties: ["openFile", "showHiddenFiles"],
        filters: [
            { name: "YAML", extensions: ["yaml", "yml"] },
            { name: "All files", extensions: ["*"] },
        ],
    });
}

/** pickFolder asks for one folder and returns its path, or null when cancelled. */
export function pickFolder(
    dialog: OpenDialog,
    title: string,
): Promise<string | null> {
    return pick(dialog, {
        title,
        properties: ["openDirectory", "createDirectory"],
    });
}

/** pick opens the dialog and returns the first chosen path, or null. */
async function pick(
    dialog: OpenDialog,
    opts: OpenDialogOptions,
): Promise<string | null> {
    const { canceled, filePaths } = await dialog.showOpenDialog(opts);
    return canceled ? null : (filePaths[0] ?? null);
}
