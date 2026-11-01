// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The settings tab's MCP server section: this device's switch for the doc
// server, the shared config path, and the URL read from that config — reread
// whenever a server start settles, since a start may write the config. DOM
// glue; the config read is ../mcp/config.ts.

import { NodeDocFs } from "@docket/docserver-node";
import { Notice, Setting, type TextComponent } from "obsidian";
import { DEFAULT_CONFIG_PATH, readMcpConfig } from "../mcp/config.ts";
import {
    detectKeys,
    type FeatureKey,
    type Found,
    keyValue,
    setKeyLines,
} from "../mcp/feature-keys.ts";
import { rereadsConfig } from "../mcp/status.ts";
import { type Debounced, debounce } from "./debounce.ts";
import { type SettingsCtx, vaultBasePath } from "./fields.ts";

export class McpSection {
    private url: { setting: Setting; text: TextComponent } | null = null;
    /** reads numbers URL reads so only the latest one is shown. */
    private reads = 0;
    /** refreshSoon rereads the server config once typing pauses. */
    private readonly refreshSoon: Debounced<[]>;
    /** unwatch stops following the server's state; set while drawn. */
    private unwatch: (() => void) | null = null;

    constructor(
        private readonly ctx: SettingsCtx,
        delayMs: number,
    ) {
        this.refreshSoon = debounce(() => {
            void this.refresh();
        }, delayMs);
    }

    /** render draws the section into `el`. */
    render(el: HTMLElement): void {
        const { plugin } = this.ctx;

        new Setting(el).setName("MCP server").setHeading();

        new Setting(el)
            .setName("Run the doc server")
            .setDesc(
                "Serve the documentation the vault root's project-config.md names to MCP clients such as Claude Code. Applies to this device.",
            )
            .addToggle((t) =>
                t
                    .setValue(plugin.mcpEnabled)
                    .onChange((v) => plugin.setMcpEnabled(v)),
            );

        const urlSetting = new Setting(el).setName("URL");
        urlSetting.addText((t) => {
            t.inputEl.readOnly = true;
            this.url = { setting: urlSetting, text: t };
        });
        void this.refresh();
        this.unwatch?.();
        let prev = plugin.mcp.state;
        this.unwatch = plugin.mcp.subscribe((next) => {
            if (rereadsConfig(prev, next)) void this.refresh();
            prev = next;
        });
        this.features(el);
    }

    /** cancel drops a pending config reread and stops following the server. */
    cancel(): void {
        this.refreshSoon.cancel();
        this.unwatch?.();
        this.unwatch = null;
    }

    /**
     * refresh reads the configured server config and shows the URL it serves
     * at, or why it cannot be read.
     */
    private async refresh(): Promise<void> {
        const ui = this.url;
        if (ui === null) return;
        const read = ++this.reads;
        const state = await readMcpConfig(
            new NodeDocFs(),
            vaultBasePath(this.ctx.app),
            DEFAULT_CONFIG_PATH,
        );
        if (read !== this.reads) return;
        ui.text.setValue(state.ok ? state.url : "");
        ui.setting.descEl.toggleClass("mod-warning", !state.ok);
        ui.setting.setDesc(
            state.ok
                ? "Add this URL to the MCP client's configuration."
                : state.error,
        );
    }

    /**
     * features draws the doc server's feature keys: one field each, Detect
     * to fill them from the vault, and Save to write the edited ones into
     * project-config.md line by line. Nothing is written until Save.
     */
    private features(el: HTMLElement): void {
        const { app } = this.ctx;
        new Setting(el)
            .setName("Server features")
            .setHeading()
            .setDesc(
                "Keys the doc server reads from project-config.md for its glossary, gap, and trust tools. Detect proposes them; nothing is written until you save.",
            );
        const labels: [FeatureKey, string, string][] = [
            [
                "initiatives",
                "Drafts folder",
                "Folder whose documents get no rank and never fill a gap (initiatives).",
            ],
            [
                "glossary",
                "Glossary",
                "Markdown file or folder of glossary terms.",
            ],
            [
                "gaps",
                "Gap folder",
                "Folder for documentation gaps, outside every source.",
            ],
            [
                "precedence",
                "Trust order",
                "Folders inside the sources, most trusted first, comma-separated.",
            ],
        ];
        const fields = new Map<FeatureKey, TextComponent>();
        for (const [key, name, desc] of labels) {
            new Setting(el)
                .setName(name)
                .setDesc(desc)
                .addText((t) => {
                    fields.set(key, t);
                });
        }
        const show = (key: FeatureKey, v: string | string[] | undefined) =>
            fields
                .get(key)
                ?.setValue(Array.isArray(v) ? v.join(", ") : (v ?? ""));
        const file = () => app.vault.getFileByPath(DEFAULT_CONFIG_PATH);
        const current = file();
        if (current !== null) {
            void app.vault.read(current).then((text) => {
                for (const [key] of labels) show(key, keyValue(text, key));
            });
        }
        new Setting(el)
            .addButton((b) =>
                b.setButtonText("Detect").onClick(async () => {
                    const f = file();
                    const raw =
                        f === null
                            ? undefined
                            : keyValue(await app.vault.read(f), "sources");
                    const sources = Array.isArray(raw)
                        ? raw
                        : raw === undefined
                          ? []
                          : [raw];
                    const paths = app.vault
                        .getMarkdownFiles()
                        .map((m) => m.path);
                    const found = detectKeys(paths, sources);
                    for (const [key, hit] of Object.entries(found) as [
                        FeatureKey,
                        Found,
                    ][]) {
                        if ("value" in hit) show(key, hit.value);
                        else
                            new Notice(
                                `docket: no ${key} found${hit.candidates.length > 0 ? `; candidates: ${hit.candidates.join(", ")}` : ""}.`,
                            );
                    }
                }),
            )
            .addButton((b) =>
                b
                    .setButtonText("Save")
                    .setCta()
                    .onClick(async () => {
                        const f = file();
                        if (f === null) {
                            new Notice(
                                `docket: no ${DEFAULT_CONFIG_PATH}; turn on the server first.`,
                            );
                            return;
                        }
                        const before = await app.vault.read(f);
                        let text = before;
                        for (const [key] of labels) {
                            const raw =
                                fields.get(key)?.getValue().trim() ?? "";
                            if (raw === "") continue;
                            const value =
                                key === "precedence"
                                    ? raw
                                          .split(",")
                                          .map((v) => v.trim())
                                          .filter((v) => v !== "")
                                    : raw;
                            if (
                                JSON.stringify(keyValue(text, key)) ===
                                JSON.stringify(value)
                            )
                                continue;
                            text = setKeyLines(text, key, value);
                        }
                        // The controller restarts a running server on this edit.
                        if (text !== before) await app.vault.modify(f, text);
                    }),
            );
    }
}
