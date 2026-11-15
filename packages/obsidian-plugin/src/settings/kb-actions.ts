// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// What a git knowledge base's buttons do, shared by its settings card and the
// Git tab: each runs through the plugin's KbWatch, asking first where it
// needs words (a commit message) or a yes (a pin update), and reports a
// failure as a notice. Clone is the settings card's own (it registers the
// folder afterwards). DOM glue.

import { type App, Notice } from "obsidian";
import { kbRepoId } from "../git/history.ts";
import type { ActionId } from "../git/kb-card.ts";
import type docketPlugin from "../main.ts";
import { commitMessageModal, resolveModal, updateModal } from "./kb-dialogs.ts";
import { remoteAdvice } from "./knowledge.ts";

/** runKbAction runs button `id` for the knowledge base `name`. */
export async function runKbAction(
    app: App,
    plugin: docketPlugin,
    name: string,
    id: ActionId,
): Promise<void> {
    const watch = plugin.kbWatch;
    try {
        switch (id) {
            case "clone":
                return;
            case "cancel":
                watch.cancel(name);
                return;
            case "retry":
                await watch.check(name);
                return;
            case "pull":
                await watch.pull(name);
                return;
            case "push":
                await watch.push(name);
                new Notice(`docket: pushed ${name}`);
                return;
            case "commitPush":
            case "commitPropose": {
                const propose = id === "commitPropose";
                const msg = await commitMessageModal(
                    app,
                    `Commit ${name}`,
                    watch.status(name)?.edited ?? 0,
                    plugin.commitHistory.get(kbRepoId(name)),
                    propose ? "Commit & propose" : "Commit & push",
                );
                if (msg === null) return;
                await watch.commit(name, msg);
                if (propose) await propose_(plugin, name);
                else await watch.push(name);
                return;
            }
            case "propose":
                await propose_(plugin, name);
                return;
            case "reviewPin": {
                const s = watch.status(name);
                if (s?.update === null || s?.update === undefined) return;
                const to = watch.upstream(name);
                if (
                    await updateModal(app, name, s.update, s.pin ?? s.head, to)
                ) {
                    await watch.acceptUpdate(name);
                }
                return;
            }
            case "movePin":
                await watch.movePin(name);
                return;
            case "resolve":
                await resolveModal(
                    app,
                    name,
                    () => watch.status(name)?.conflicts ?? [],
                    (path) => watch.markResolved(name, path),
                );
                return;
        }
    } catch (err) {
        new Notice(`docket: ${name}: ${remoteAdvice(err)}`, 10000);
    }
}

/** propose_ sends the knowledge base's commits as a pull request. */
async function propose_(plugin: docketPlugin, name: string): Promise<void> {
    const p = await plugin.kbWatch.propose(name);
    new Notice(
        p.url === null
            ? `docket: pushed ${p.branch}; open a pull request from it on the host`
            : `docket: pushed ${p.branch}; finish the pull request in the browser`,
        10000,
    );
}
