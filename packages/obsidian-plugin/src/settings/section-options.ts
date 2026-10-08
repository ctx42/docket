// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The settings tab's option sections: Notes (comments, hidden properties, the
// Markdown flavor), Git (the git path, change bars, commit message history)
// and the collapsed Advanced block (wrap margin, request timeout). DOM glue.

import { flavorIds } from "@docket/core";
import { Setting } from "obsidian";
import { DEFAULT_GIT } from "../adapters/git.ts";
import {
    HISTORY_CAP,
    HISTORY_CAP_MAX,
    parseHistoryCap,
} from "../git/history.ts";
import { numberSetting, type SettingsCtx } from "./fields.ts";

/** notesSection draws the Notes section into `el`. */
export function notesSection(ctx: SettingsCtx, el: HTMLElement): void {
    const { plugin } = ctx;
    const s = plugin.settings;

    new Setting(el).setName("Notes").setHeading();

    new Setting(el)
        .setName("Comments")
        .setDesc(
            "Pull Confluence comments as [!comment] callouts, and push " +
                "replies and resolutions back.",
        )
        .addToggle((t) =>
            t.setValue(s.comments).onChange((v) =>
                ctx.commitScalar(() => {
                    s.comments = v;
                }),
            ),
        );

    new Setting(el)
        .setName("Hide docket properties")
        .setDesc(
            "Hide the docket_* bookkeeping properties in the Properties view. They stay in the file. Applies to this device.",
        )
        .addToggle((t) =>
            t
                .setValue(plugin.hideProps)
                .onChange((v) => plugin.setHideProps(v)),
        );

    // Only worth a choice once there is more than one dialect.
    const flavors = flavorIds();
    if (flavors.length > 1) {
        new Setting(el)
            .setName("Markdown flavor")
            .setDesc("The Markdown dialect pulled and pushed notes use.")
            .addDropdown((d) => {
                for (const id of flavors) {
                    d.addOption(id, id);
                }
                d.setValue(s.flavor).onChange((v) =>
                    ctx.commitScalar(() => {
                        s.flavor = v;
                    }),
                );
            });
    }
}

/** gitSection draws the Git section into `el`. */
export function gitSection(ctx: SettingsCtx, el: HTMLElement): void {
    const { plugin } = ctx;

    new Setting(el).setName("Git").setHeading();

    new Setting(el)
        .setName("Git path")
        .setDesc(
            "The git program docket runs for the Git and History tabs. Leave empty to use the one on your PATH. Applies to this device.",
        )
        .addText((t) => {
            t.setPlaceholder(DEFAULT_GIT)
                .setValue(plugin.gitPath)
                .onChange((v) => plugin.setGitPath(v));
        });

    new Setting(el)
        .setName("Change bars")
        .setDesc(
            "Mark lines added, changed, and deleted since the last commit in the editor gutter. Applies to this device.",
        )
        .addToggle((t) =>
            t
                .setValue(plugin.diffSigns)
                .onChange((v) => plugin.setDiffSigns(v)),
        );

    numberSetting(
        el,
        "Commit message history",
        `How many committed messages the Git tab offers again, from 0 (none) to ${HISTORY_CAP_MAX}. Applies to this device.`,
        String(HISTORY_CAP),
        plugin.historyCap,
        (n) => plugin.setHistoryCap(n),
        parseHistoryCap,
    );
}

/** advancedSection draws the collapsed Advanced block into `el`. */
export function advancedSection(ctx: SettingsCtx, el: HTMLElement): void {
    const s = ctx.plugin.settings;
    const advanced = el.createEl("details", { cls: "docket-advanced" });
    advanced.createEl("summary", {
        cls: "setting-item-heading",
        text: "Advanced",
    });

    numberSetting(
        advanced,
        "Wrap margin",
        "Hard-wrap paragraphs at this column. 0 turns wrapping off.",
        "0",
        s.margin,
        (n) =>
            ctx.commitScalar(() => {
                s.margin = n;
            }),
    );
    numberSetting(
        advanced,
        "Request timeout",
        "Seconds to wait for each request to Confluence.",
        "30",
        s.timeoutSeconds,
        (n) =>
            ctx.commitScalar(() => {
                s.timeoutSeconds = n;
            }),
    );
}
