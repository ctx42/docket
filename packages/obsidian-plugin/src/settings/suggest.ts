// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Type-ahead for vault path fields: folders, or folders and notes, relative to
// a base folder (the sync root). Picking a value writes it into the field and
// fires `input` so the field's own handler runs. The matching itself is the
// pure `matchPaths` in locations.ts; this class is obsidian glue.

import { AbstractInputSuggest, type App, TFile, TFolder } from "obsidian";
import { matchPaths } from "./locations.ts";

/** SuggestMode picks what a field suggests. */
export type SuggestMode = "folders" | "notes";

export class VaultPathSuggest extends AbstractInputSuggest<string> {
    /**
     * `base` returns the folder paths are relative to; `pick`, when given,
     * turns a chosen suggestion into the field's value (e.g. a folder into a
     * note path inside it).
     */
    constructor(
        app: App,
        private readonly input: HTMLInputElement,
        private readonly mode: SuggestMode,
        private readonly base: () => string,
        private readonly pick: (value: string) => string = (v) => v,
    ) {
        super(app, input);
    }

    protected getSuggestions(query: string): string[] {
        const paths: string[] = [];
        for (const f of this.app.vault.getAllLoadedFiles()) {
            if (f instanceof TFolder && !f.isRoot()) paths.push(f.path);
            else if (
                this.mode === "notes" &&
                f instanceof TFile &&
                f.extension === "md"
            ) {
                paths.push(f.path);
            }
        }
        return matchPaths(paths, this.base(), query);
    }

    renderSuggestion(value: string, el: HTMLElement): void {
        el.setText(value);
    }

    override selectSuggestion(value: string): void {
        this.setValue(this.pick(value));
        this.input.dispatchEvent(new Event("input"));
        this.close();
    }
}
