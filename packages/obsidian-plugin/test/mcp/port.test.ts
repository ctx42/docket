// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { createServer, type Server } from "node:net";

import { describe, expect, it } from "vitest";

import {
    assignPort,
    BASE_PORT,
    isFreePort,
    notePort,
    noteServer,
    type PortDeps,
    pickPort,
    SCAN_PORTS,
    setMcpJsonPort,
    setNotePort,
    systemPort,
} from "../../src/mcp/port.ts";

/** NOTE is a project note as the bookshop example writes it. */
const NOTE =
    "---\nmcp-server: srd\nmcp-port: 7777\nsources:\n  - docs\n---\n\n# Project\n";

describe("notePort", () => {
    it.each<[string, string, number | undefined]>([
        ["set", NOTE, 7777],
        ["quoted", '---\nmcp-port: "8080"\n---\n', 8080],
        ["missing", "---\nmcp-server: srd\n---\n", undefined],
        ["zero", "---\nmcp-port: 0\n---\n", undefined],
        ["out of range", "---\nmcp-port: 70000\n---\n", undefined],
        ["not a number", "---\nmcp-port: auto\n---\n", undefined],
        ["only in the body", "---\nx: 1\n---\nmcp-port: 1\n", undefined],
        ["no front matter", "mcp-port: 7777\n", undefined],
    ])("%s", (_name, text, want) => {
        // --- When ---
        const have = notePort(text);

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("noteServer", () => {
    it.each([
        ["plain", NOTE, "srd"],
        ["quoted", "---\nmcp-server: 'docs'\n---\n", "docs"],
        ["missing", "---\nx: 1\n---\n", ""],
    ])("%s", (_name, text, want) => {
        // --- When ---
        const have = noteServer(text);

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("setNotePort", () => {
    it("replaces the port line and keeps every other byte", () => {
        // --- When ---
        const have = setNotePort(NOTE, 7778);

        // --- Then ---
        expect(have).toBe(NOTE.replace("mcp-port: 7777", "mcp-port: 7778"));
    });

    it("adds a missing port line at the end of the block", () => {
        // --- When ---
        const have = setNotePort("---\nmcp-server: srd\n---\nbody\n", 7778);

        // --- Then ---
        expect(have).toBe("---\nmcp-server: srd\nmcp-port: 7778\n---\nbody\n");
    });

    it("keeps CRLF line ends", () => {
        // --- When ---
        const have = setNotePort("---\r\nmcp-server: srd\r\n---\r\n", 7778);

        // --- Then ---
        expect(have).toBe(
            "---\r\nmcp-server: srd\r\nmcp-port: 7778\r\n---\r\n",
        );
    });

    it("leaves a port line in the body alone", () => {
        // --- Given ---
        const text = "---\nmcp-port: 1\n---\nmcp-port: 1\n";

        // --- When ---
        const have = setNotePort(text, 2);

        // --- Then ---
        expect(have).toBe("---\nmcp-port: 2\n---\nmcp-port: 1\n");
    });

    it("error - no front matter", () => {
        // --- When ---
        const have = () => setNotePort("# Project\n", 1);

        // --- Then ---
        expect(have).toThrow("the config note has no front matter");
    });
});

describe("setMcpJsonPort", () => {
    it("moves the server's URL and keeps the rest", () => {
        // --- Given ---
        const raw = JSON.stringify({
            mcpServers: {
                srd: { type: "http", url: "http://127.0.0.1:7777/mcp" },
                other: { type: "http", url: "http://localhost:9000/x" },
            },
            extra: true,
        });

        // --- When ---
        const have = JSON.parse(setMcpJsonPort(raw, "srd", 7778));

        // --- Then ---
        expect(have).toEqual({
            mcpServers: {
                srd: { type: "http", url: "http://127.0.0.1:7778/mcp" },
                other: { type: "http", url: "http://localhost:9000/x" },
            },
            extra: true,
        });
    });

    it("creates a missing file", () => {
        // --- When ---
        const have = setMcpJsonPort(undefined, "srd", 7778);

        // --- Then ---
        expect(have).toBe(
            '{\n  "mcpServers": {\n    "srd": {\n      "type": "http",\n' +
                '      "url": "http://localhost:7778/mcp"\n    }\n  }\n}\n',
        );
    });

    it.each([
        ["missing entry", { mcpServers: {} }],
        ["missing url", { mcpServers: { srd: { type: "http" } } }],
        ["bad url", { mcpServers: { srd: { type: "http", url: "nope" } } }],
    ])("adds the localhost endpoint for a %s", (_name, top) => {
        // --- When ---
        const have = JSON.parse(setMcpJsonPort(JSON.stringify(top), "srd", 1));

        // --- Then ---
        expect(have.mcpServers.srd).toEqual({
            type: "http",
            url: "http://localhost:1/mcp",
        });
    });

    it("matches the mcpServers key case-insensitively", () => {
        // --- When ---
        const have = JSON.parse(
            setMcpJsonPort(
                '{"MCPServers":{"srd":{"url":"http://h:1/m"}}}',
                "srd",
                2,
            ),
        );

        // --- Then ---
        expect(have).toEqual({
            MCPServers: { srd: { url: "http://h:2/m", type: "http" } },
        });
    });

    it.each([
        ["not JSON", "{", "parse .mcp.json: "],
        ["not an object", "[1]", "parse .mcp.json: not a JSON object"],
    ])("error - %s", (_name, raw, want) => {
        // --- When ---
        const have = () => setMcpJsonPort(raw, "srd", 1);

        // --- Then ---
        expect(have).toThrow(want);
    });
});

/** fakeDeps is a {@link PortDeps} over files in a map and taken ports. */
function fakeDeps(files: Record<string, string>, taken: number[]) {
    const writes: string[] = [];
    const deps: PortDeps = {
        readText: async (p) => {
            const text = files[p];
            if (text === undefined) throw new Error(`ENOENT ${p}`);
            return text;
        },
        readOptional: async (p) => files[p],
        writeText: async (p, text) => {
            files[p] = text;
            writes.push(p);
        },
        isFree: async (port) => !taken.includes(port),
        anyPort: async () => 49152,
    };
    return { deps, files, writes };
}

describe("pickPort", () => {
    it("takes the first free port from the start", async () => {
        // --- Given ---
        const { deps } = fakeDeps({}, [7777, 7778]);

        // --- When ---
        const have = await pickPort(deps, 7777);

        // --- Then ---
        expect(have).toBe(7779);
    });

    it("lets the system pick when the scan finds none", async () => {
        // --- Given ---
        const taken = Array.from({ length: SCAN_PORTS }, (_, i) => 7777 + i);
        const { deps } = fakeDeps({}, taken);

        // --- When ---
        const have = await pickPort(deps, 7777);

        // --- Then ---
        expect(have).toBe(49152);
    });

    it("stops the scan at 65535", async () => {
        // --- Given ---
        const { deps } = fakeDeps({}, [65534, 65535]);

        // --- When ---
        const have = await pickPort(deps, 65534);

        // --- Then ---
        expect(have).toBe(49152);
    });
});

describe("assignPort", () => {
    const CFG = "/v/project-config.md";
    const MCP = "/v/.mcp.json";

    it("keeps a free configured port and writes nothing", async () => {
        // --- Given ---
        const { deps, writes } = fakeDeps({ [CFG]: NOTE }, []);

        // --- When ---
        const have = await assignPort(deps, CFG);

        // --- Then ---
        expect(have).toEqual({ port: 7777, written: false });
        expect(writes).toEqual([]);
    });

    it("moves off a taken port and writes both files", async () => {
        // --- Given ---
        const { deps, files, writes } = fakeDeps(
            {
                [CFG]: NOTE,
                [MCP]: '{"mcpServers":{"srd":{"type":"http","url":"http://localhost:7777/mcp"}}}',
            },
            [7777],
        );

        // --- When ---
        const have = await assignPort(deps, CFG);

        // --- Then ---
        expect(have).toEqual({ port: 7778, moved: 7777, written: true });
        expect(writes).toEqual([CFG, MCP]);
        expect(notePort(files[CFG] as string)).toBe(7778);
        expect(JSON.parse(files[MCP] as string).mcpServers.srd.url).toBe(
            "http://localhost:7778/mcp",
        );
    });

    it("picks from the base port for a note without one", async () => {
        // --- Given ---
        const { deps, files } = fakeDeps(
            { [CFG]: "---\nmcp-server: srd\nsources: [docs]\n---\n" },
            [BASE_PORT],
        );

        // --- When ---
        const have = await assignPort(deps, CFG);

        // --- Then ---
        expect(have).toEqual({ port: BASE_PORT + 1, written: true });
        expect(notePort(files[CFG] as string)).toBe(BASE_PORT + 1);
        expect(files[MCP]).toContain(
            `"url": "http://localhost:${BASE_PORT + 1}/mcp"`,
        );
    });

    it("leaves a YAML config alone", async () => {
        // --- Given ---
        const { deps, writes } = fakeDeps({}, []);

        // --- When ---
        const have = await assignPort(deps, "/v/srd.yaml");

        // --- Then ---
        expect(have).toBeUndefined();
        expect(writes).toEqual([]);
    });

    it("error - unreadable .mcp.json writes nothing", async () => {
        // --- Given ---
        const { deps, writes } = fakeDeps({ [CFG]: NOTE, [MCP]: "{" }, [7777]);

        // --- When ---
        const have = assignPort(deps, CFG);

        // --- Then ---
        await expect(have).rejects.toThrow("parse .mcp.json: ");
        expect(writes).toEqual([]);
    });
});

describe("isFreePort and systemPort", () => {
    it("tells a taken port from a free one", async () => {
        // --- Given ---
        const port = await systemPort();
        const blocker: Server = createServer();
        await new Promise<void>((r) => blocker.listen(port, r));

        try {
            // --- When ---
            const taken = await isFreePort(port);
            blocker.close();
            await new Promise((r) => blocker.once("close", r));
            const free = await isFreePort(port);

            // --- Then ---
            expect(port).toBeGreaterThan(0);
            expect([taken, free]).toEqual([false, true]);
        } finally {
            blocker.close();
        }
    });
});
