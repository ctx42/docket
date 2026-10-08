// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The panel's MCP tab: the doc server's state line, with a copy button while
// it listens, over its log, which follows its newest line unless the user
// scrolled up. DOM shell; the state text is mcp/status.ts.

import { setIcon } from "obsidian";
import type docketPlugin from "../main.ts";
import { clock } from "../mcp/log.ts";
import { panelLine } from "../mcp/status.ts";
import { followsEnd } from "./panel-model.ts";

export class McpTab {
    /**
     * logScroll is where the user scrolled the server log to, or null to
     * follow its newest line.
     */
    private logScroll: number | null = null;

    constructor(private readonly plugin: docketPlugin) {}

    /** render draws the state line over the log into `body`. */
    render(body: HTMLElement): void {
        this.renderLine(body);
        const lines = this.plugin.mcp.log.lines;
        if (lines.length === 0) {
            body.createDiv({ cls: "docket-muted", text: "No log lines yet" });
            return;
        }
        const log = body.createDiv({ cls: "docket-log" });
        for (const l of lines) {
            log.createDiv({
                cls: `docket-log-row is-${l.kind}`,
                text: `${clock(l.at)} ${l.text}`,
            });
        }
        log.scrollTop = this.logScroll ?? log.scrollHeight;
        log.onscroll = () => {
            this.logScroll = followsEnd(
                log.scrollTop,
                log.scrollHeight,
                log.clientHeight,
            )
                ? null
                : log.scrollTop;
        };
    }

    /** renderLine draws the server's state, with a copy button while it listens. */
    private renderLine(root: HTMLElement): void {
        const mcp = this.plugin.mcp;
        const state = mcp.state;
        const line = root.createDiv({ cls: "docket-mcp-line" });
        line.toggleClass("mod-error", state.kind === "error");
        setIcon(line.createSpan({ cls: "docket-mcp-icon" }), "plug");
        line.createSpan({ cls: "docket-mcp-text", text: panelLine(state) });
        if (state.kind !== "listening") return;
        const copy = line.createEl("button", {
            cls: "clickable-icon docket-mcp-copy",
            attr: { "aria-label": "Copy MCP URL" },
        });
        setIcon(copy, "copy");
        copy.onclick = () => void mcp.copyUrl();
    }
}
