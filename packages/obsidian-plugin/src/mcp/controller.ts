// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's doc server: an McpHost running `docket mcp`'s server over the
// vault, started once the workspace layout is ready when this device has it
// switched on, stopped on unload and on switch-off, restarted when the
// config path changes. Vault create/modify/delete/rename events drive the
// server's rebuild loops in place of `fs.watch`. A run that fails (a config
// error, a port in use) shows a Notice and leaves the error state for the
// status display; it never throws into Obsidian. Every log line, and a
// mark for each start and stop, lands in {@link McpController.log} for the
// panel (and in the developer console at debug level). This file is Obsidian
// glue; the state machine and event filtering are in host.ts and
// vault-notifier.ts.

import { FsNotifier, NodeDocFs, run } from "@docket/docserver-node";
import {
    FileSystemAdapter,
    Notice,
    type Plugin,
    type TAbstractFile,
    TFolder,
} from "obsidian";

import { configDiskPath, configPath, readMcpConfig } from "./config.ts";
import { McpHost, type McpState, type RunRequest } from "./host.ts";
import { McpLog } from "./log.ts";
import { type Assigned, assignPort, NODE_PORT_DEPS } from "./port.ts";
import { listeningUrl, restartsOnConfig } from "./status.ts";
import { type VaultEventKind, VaultWatchers } from "./vault-notifier.ts";

/** McpPlugin is the part of the plugin the controller reads. */
export interface McpPlugin extends Plugin {
    /** mcpEnabled is this device's switch. */
    mcpEnabled: boolean;
    settings: { mcpConfigPath: string };
}

/** McpController runs the plugin's doc server; see the module comment. */
export class McpController {
    readonly host: McpHost;
    /** log is the server's log, kept across runs for the panel. */
    readonly log = new McpLog();
    private readonly watchers: VaultWatchers;
    private readonly listeners = new Set<(state: McpState) => void>();
    /** served is the config path the latest run was started on. */
    private served: string | undefined;
    private unloaded = false;

    constructor(private readonly plugin: McpPlugin) {
        this.watchers = new VaultWatchers(
            () => this.basePath(),
            (dirs, files) => new FsNotifier(dirs, files),
        );
        this.host = new McpHost({
            run: (req) => this.run(req),
            onState: (state) => this.changed(state),
            log: (line) => {
                console.debug(`docket mcp: ${line}`);
                this.log.add(line);
            },
        });
    }

    /** state is the server's current state. */
    get state(): McpState {
        return this.host.state;
    }

    /**
     * load wires the vault events and, once the layout is ready, starts the
     * server when this device has it switched on.
     */
    load(): void {
        const { app } = this.plugin;
        app.workspace.onLayoutReady(() => {
            // Layout-ready callbacks cannot be withdrawn; one queued before
            // an unload must not start a server nothing would stop.
            if (this.unloaded) return;
            const forward =
                (kind: VaultEventKind) =>
                (file: TAbstractFile, oldPath?: string) =>
                    this.vaultEvent(kind, file, oldPath);
            const vault = app.vault;
            this.plugin.registerEvent(vault.on("create", forward("create")));
            this.plugin.registerEvent(vault.on("modify", forward("modify")));
            this.plugin.registerEvent(vault.on("delete", forward("delete")));
            this.plugin.registerEvent(vault.on("rename", forward("rename")));
            if (this.plugin.mcpEnabled) void this.host.start();
        });
    }

    /** unload stops the server for good. */
    unload(): void {
        this.unloaded = true;
        this.listeners.clear();
        void this.host.dispose();
    }

    /**
     * setEnabled starts or stops the server to follow the switch, and tells
     * subscribers, whose display depends on the switch too.
     */
    setEnabled(on: boolean): Promise<void> {
        const done = on ? this.host.start() : this.host.stop();
        this.notify(this.host.state);
        return done;
    }

    /**
     * configChanged restarts the server on a config path other than the
     * one its latest run started on: a running server however it was
     * started, and, while the switch is on, a failed one or one that has
     * not run yet. A server stopped from a command stays stopped.
     */
    configChanged(): Promise<void> {
        const restart = restartsOnConfig({
            path: configPath(this.plugin.settings.mcpConfigPath),
            served: this.served,
            enabled: this.plugin.mcpEnabled,
            running: this.host.running,
            state: this.host.state,
        });
        return restart ? this.host.restart() : Promise.resolve();
    }

    /**
     * url returns the URL clients reach the server at: the one it listens
     * on, else the one its config names; it throws why there is none.
     */
    async url(): Promise<string> {
        const live = listeningUrl(this.host.state);
        if (live !== undefined) return live;
        const cfg = await readMcpConfig(
            new NodeDocFs(),
            this.basePath(),
            this.plugin.settings.mcpConfigPath,
        );
        if (!cfg.ok) throw new Error(cfg.error);
        return cfg.url;
    }

    /** copyUrl copies {@link url} to the clipboard and says so. */
    async copyUrl(): Promise<void> {
        try {
            const url = await this.url();
            await navigator.clipboard.writeText(url);
            new Notice(`docket: copied ${url}`);
        } catch (err) {
            new Notice(`docket: no MCP URL to copy: ${(err as Error).message}`);
        }
    }

    /** subscribe calls fn on every state change until the returned undo. */
    subscribe(fn: (state: McpState) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /**
     * run serves the configured project until the request aborts, on the
     * port {@link assignPort} settles: the note's own when free, else a
     * free one written back to the note and its `.mcp.json`.
     */
    private async run(req: RunRequest): Promise<void> {
        this.served = configPath(this.plugin.settings.mcpConfigPath);
        const base = this.basePath();
        if (base === "") {
            throw new Error("the vault has no folder on disk to serve from");
        }
        const config = configDiskPath(base, this.plugin.settings.mcpConfigPath);
        const assigned = await assignPort(NODE_PORT_DEPS, config);
        if (assigned?.written) this.moved(assigned, req);
        if (req.signal.aborted) return;
        return run({
            config,
            version: this.plugin.manifest.version,
            stderr: req.stderr,
            signal: req.signal,
            fs: new NodeDocFs(),
            newWatcher: this.watchers.factory,
        });
    }

    /** moved tells the user and the log that the server took another port. */
    private moved(a: Assigned, req: RunRequest): void {
        const why =
            a.moved === undefined
                ? "the config set no port"
                : `port ${a.moved} is in use`;
        req.stderr.write(
            `${why}: using port ${a.port}, written to the config and .mcp.json\n`,
        );
        new Notice(
            `docket: ${why}, so the MCP server uses port ${a.port}; ` +
                "project-config.md and .mcp.json now name it. Reconnect MCP clients.",
        );
    }

    private changed(state: McpState): void {
        if (state.kind === "starting") this.log.add("server starting");
        if (state.kind === "stopped") this.log.add("server stopped");
        if (state.kind === "error") {
            this.log.add(`server stopped: ${state.message}`, "err");
            new Notice(`docket: MCP server stopped: ${state.message}`);
        }
        this.notify(state);
    }

    private notify(state: McpState): void {
        for (const fn of this.listeners) fn(state);
    }

    private vaultEvent(
        kind: VaultEventKind,
        file: TAbstractFile,
        oldPath?: string,
    ): void {
        this.watchers.event({
            kind,
            path: file.path,
            folder: file instanceof TFolder,
            ...(oldPath === undefined ? {} : { oldPath }),
        });
    }

    /** basePath is the vault's disk path, or "" when it has none. */
    private basePath(): string {
        const adapter = this.plugin.app.vault.adapter;
        return adapter instanceof FileSystemAdapter
            ? adapter.getBasePath()
            : "";
    }
}
