// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The settings tab's MCP server section: this device's switch for the doc
// server, the shared config path, and the URL read from that config. DOM
// glue; the config read is ../mcp/config.ts.

import { NodeDocFs } from "@docket/docserver-node";
import { Setting, type TextComponent } from "obsidian";
import { readMcpConfig } from "../mcp/config.ts";
import { type Debounced, debounce } from "./debounce.ts";
import { type SettingsCtx, vaultBasePath } from "./fields.ts";
import { VaultPathSuggest } from "./suggest.ts";

export class McpSection {
    private url: { setting: Setting; text: TextComponent } | null = null;
    /** reads numbers URL reads so only the latest one is shown. */
    private reads = 0;
    /** refreshSoon rereads the server config once typing pauses. */
    private readonly refreshSoon: Debounced<[]>;

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
        const { app, plugin } = this.ctx;
        const s = plugin.settings;

        new Setting(el).setName("MCP server").setHeading();

        new Setting(el)
            .setName("Run the doc server")
            .setDesc(
                "Serve the documentation the config below names to MCP clients such as Claude Code. Applies to this device.",
            )
            .addToggle((t) =>
                t
                    .setValue(plugin.mcpEnabled)
                    .onChange((v) => plugin.setMcpEnabled(v)),
            );

        new Setting(el)
            .setName("Config")
            .setDesc(
                "Vault path of the server's project-config.md. Leave empty for the one at the vault root.",
            )
            .addText((t) => {
                t.setPlaceholder("project-config.md")
                    .setValue(s.mcpConfigPath)
                    .onChange((v) => {
                        this.ctx.commitScalar(() => {
                            s.mcpConfigPath = v.trim();
                        });
                        this.refreshSoon();
                    });
                new VaultPathSuggest(
                    app,
                    t.inputEl,
                    "notes",
                    () => "",
                    (v) => (v.endsWith(".md") ? v : `${v}/project-config.md`),
                );
                // The server restarts once the edit is done, not mid-typing.
                t.inputEl.addEventListener("blur", () => {
                    void plugin.mcp.configChanged();
                });
            });

        const urlSetting = new Setting(el).setName("URL");
        urlSetting.addText((t) => {
            t.inputEl.readOnly = true;
            this.url = { setting: urlSetting, text: t };
        });
        void this.refresh();
    }

    /** cancel drops a pending config reread. */
    cancel(): void {
        this.refreshSoon.cancel();
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
            this.ctx.plugin.settings.mcpConfigPath,
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
}
