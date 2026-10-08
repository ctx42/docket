// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The settings tab's Connection section: the Site, the account email, the
// per-device API token, and a live connection test against the Site via the
// requestUrl adapter and the core's ConfluenceClient. DOM glue; the result
// text is tab-model.ts.

import { ConfluenceClient, siteHost } from "@docket/core";
import { requestUrl, Setting, setIcon } from "obsidian";
import { RequestUrlHttpClient } from "../adapters/http.ts";
import type { SettingsCtx } from "./fields.ts";
import { connectedAs, errorMessage } from "./tab-model.ts";

/** TOKEN_URL is where an Atlassian account creates API tokens. */
const TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

/** connectionSection draws the Connection section into `el`. */
export function connectionSection(ctx: SettingsCtx, el: HTMLElement): void {
    const { plugin } = ctx;
    const s = plugin.settings;

    new Setting(el).setName("Connection").setHeading();

    new Setting(el)
        .setName("Site")
        .setDesc(
            "Your Atlassian site: the part before .atlassian.net, e.g. your-site.",
        )
        .addText((t) =>
            t
                .setPlaceholder("your-site")
                .setValue(s.site)
                .onChange((v) =>
                    ctx.commitScalar(() => {
                        s.site = v.trim();
                    }),
                ),
        );

    new Setting(el)
        .setName("Account email")
        .setDesc("The email you sign in to Atlassian with.")
        .addText((t) =>
            t
                .setPlaceholder("you@example.com")
                .setValue(s.account)
                .onChange((v) =>
                    ctx.commitScalar(() => {
                        s.account = v.trim();
                    }),
                ),
        );

    new Setting(el)
        .setName("API token")
        .setDesc(
            createFragment((f) => {
                f.appendText(
                    "Stored on this device only, never in data.json. ",
                );
                f.createEl("a", { text: "Create a token", href: TOKEN_URL });
            }),
        )
        .addText((t) => {
            t.inputEl.type = "password";
            t.setPlaceholder("Atlassian API token")
                .setValue(plugin.token)
                .onChange((v) => {
                    plugin.token = v.trim();
                    plugin.persistToken();
                    ctx.refreshValidation();
                });
        });

    const test = new Setting(el)
        .setName("Test connection")
        .setDesc("Sign in with the values above.");
    test.addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
            b.setDisabled(true);
            await testConnection(ctx, test);
            b.setDisabled(false);
        }),
    );
}

/**
 * testConnection signs in with the current form values and reports, in the
 * setting's description, who it signed in as or why it failed.
 */
async function testConnection(
    ctx: SettingsCtx,
    setting: Setting,
): Promise<void> {
    const show = (icon: string, cls: string, text: string): void => {
        setting.setDesc(
            createFragment((f) => {
                const span = f.createSpan({ cls: `docket-test ${cls}` });
                setIcon(span.createSpan({ cls: "docket-test-icon" }), icon);
                span.createSpan({ text });
            }),
        );
    };
    show("loader", "is-pending", "Connecting…");
    try {
        const client = new ConfluenceClient(
            new RequestUrlHttpClient(requestUrl),
            {
                host: siteHost(ctx.plugin.settings.site),
                account: ctx.plugin.settings.account,
                token: ctx.plugin.token,
            },
        );
        show("check", "is-ok", connectedAs(await client.currentUser()));
    } catch (err) {
        show("x", "is-err", errorMessage(err));
    }
}
