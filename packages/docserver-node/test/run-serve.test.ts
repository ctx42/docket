// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import {
    createServer,
    get,
    request as httpRequest,
    type Server,
} from "node:http";
import { type AddressInfo, connect as netConnect } from "node:net";
import { networkInterfaces } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
    isLoopback,
    type Route,
    refusal,
    router,
    serve,
    serveHTTP,
    shutdown,
    splitHostPort,
} from "../src/run.ts";

const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
});

/** Lines collects log lines, like the Go tests' stderr buffer. */
class Lines {
    readonly lines: string[] = [];
    readonly log = (line: string): void => {
        this.lines.push(line);
    };
}

/** waitFor polls cond every 10 ms until it holds, failing after 5 s. */
async function waitFor<T>(cond: () => T | undefined, what: string) {
    const end = Date.now() + 5_000;
    for (;;) {
        const have = cond();
        if (have !== undefined) return have;
        if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** waitListening returns the address of the "listening on" log line. */
function waitListening(stderr: Lines): Promise<string> {
    return waitFor(() => {
        for (const line of stderr.lines) {
            const m = /^listening on (.+)$/.exec(line);
            if (m !== null) return m[1];
        }
        return undefined;
    }, "listening on");
}

/** deferred returns a promise with its resolve function. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = () => {};
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

/** request GETs url with a fresh connection and resolves to its body. */
function request(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const req = get(url, { agent: false }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
                body += chunk;
            });
            res.on("end", () => resolve(body));
            res.on("error", reject);
        });
        req.on("error", reject);
    });
}

describe("serveHTTP", () => {
    // go: Test_serveHTTP_drains_in_flight_request
    it("drains an in-flight request", async () => {
        // --- Given ---
        const started = deferred();
        const release = deferred();
        closers.push(() => release.resolve());
        const handler: Route = async (_req, res) => {
            started.resolve();
            await release.promise;
            res.end("done");
        };
        const stderr = new Lines();
        const ctl = new AbortController();
        closers.push(() => ctl.abort());
        let returned = false;
        const served = serveHTTP(
            "127.0.0.1:0",
            handler,
            stderr.log,
            ctl.signal,
        ).finally(() => {
            returned = true;
        });
        const base = `http://${await waitListening(stderr)}`;
        const body = request(`${base}/`);
        await started.promise;

        // --- When ---
        ctl.abort();

        // --- Then ---
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(returned).toBe(false);

        release.resolve();
        const have = await body;
        expect(have).toBe("done");
        await expect(served).resolves.toBeUndefined();
    });

    // go: Test_serveHTTP_error_listen
    it("fails on a bad listen address", async () => {
        // --- Given ---
        const addr = "127.0.0.1:-1";
        const stderr = new Lines();

        // --- When ---
        const have = serveHTTP(addr, () => {}, stderr.log);

        // --- Then ---
        await expect(have).rejects.toThrow(
            "listen: listen tcp: address -1: invalid port",
        );
        expect(stderr.lines).toEqual([]);
    });
});

describe("serve", () => {
    // go: Test_serve_error_accept
    it("ends with an accept error, without a shutdown", async () => {
        // --- Given --- a listening server whose next accept fails.
        const srv: Server = createServer(() => {});
        await new Promise<void>((resolve) =>
            srv.listen(0, "127.0.0.1", resolve),
        );
        closers.push(() => {
            srv.closeAllConnections();
            srv.close();
        });
        const ctl = new AbortController();
        const want = Object.assign(
            new Error("accept tcp: too many open files"),
            {
                code: "EMFILE",
            },
        );

        // --- When ---
        const have = serve(srv, ctl.signal);
        srv.emit("error", want);

        // --- Then ---
        await expect(have).rejects.toBe(want);
        expect(srv.listening).toBe(false);
    });

    it("shuts down at once for an aborted signal", async () => {
        // --- Given ---
        const srv: Server = createServer(() => {});
        await new Promise<void>((resolve) =>
            srv.listen(0, "127.0.0.1", resolve),
        );

        // --- When ---
        const have = serve(srv, AbortSignal.abort(), 50);

        // --- Then ---
        await expect(have).resolves.toBeUndefined();
        expect(srv.listening).toBe(false);
    });

    it("words a taken address as Go does", async () => {
        // --- Given ---
        const srv: Server = createServer(() => {});
        await new Promise<void>((resolve) =>
            srv.listen(0, "127.0.0.1", resolve),
        );
        closers.push(() => {
            srv.close();
        });
        const { port } = srv.address() as AddressInfo;
        const addr = `127.0.0.1:${port}`;

        // --- When ---
        const have = serveHTTP(
            addr,
            () => {},
            () => {},
        );

        // --- Then ---
        await expect(have).rejects.toThrow(
            `listen: listen tcp ${addr}: bind: address already in use`,
        );
    });
});

describe("splitHostPort", () => {
    it.each([
        [":7777", { host: "", port: 7777 }],
        ["127.0.0.1:0", { host: "127.0.0.1", port: 0 }],
        ["[::1]:80", { host: "::1", port: 80 }],
        ["h:", { host: "h", port: 0 }],
    ])("parses %j", (addr, want) => {
        expect(splitHostPort(addr)).toEqual(want);
    });

    it.each([
        [
            "localhost",
            "listen: listen tcp: address localhost: missing port in address",
        ],
        ["h:99999", "listen: listen tcp: address 99999: invalid port"],
        ["h:x", "listen: listen tcp: address x: invalid port"],
    ])("refuses %j", (addr, want) => {
        expect(() => splitHostPort(addr)).toThrow(want);
    });
});

describe("shutdown", () => {
    // go: Test_shutdown_closes_stuck_connection
    it("closes a stuck connection", async () => {
        // --- Given ---
        const release = deferred();
        closers.push(() => release.resolve());
        const started = deferred();
        const srv: Server = createServer(async () => {
            started.resolve();
            await release.promise;
        });
        await new Promise<void>((resolve) =>
            srv.listen(0, "127.0.0.1", resolve),
        );
        closers.push(() => srv.closeAllConnections());
        const { port } = srv.address() as AddressInfo;
        const body = request(`http://127.0.0.1:${port}/`);
        body.catch(() => {});
        await started.promise;

        // --- When ---
        const have = shutdown(srv, 50);

        // --- Then ---
        await expect(have).resolves.toBeUndefined();
        await expect(body).rejects.toThrow();
        expect(srv.listening).toBe(false);
    });
});

describe("router", () => {
    it.each([
        ["exact route", "/mcp", "mcp /mcp"],
        ["exact route with a query", "/mcp?x=1", "mcp /mcp?x=1"],
        ["prefix route", "/api/v1", "api /api/v1"],
        ["dot segment", "/./mcp", "rest /./mcp"],
        ["double slash", "//mcp", "rest //mcp"],
        ["dot-dot segment", "/x/../mcp", "rest /x/../mcp"],
        ["other path", "/healthz", "rest /healthz"],
    ])("%s", async (_name, target, want) => {
        // --- Given --- an unclean path must reach the fallback, which
        // redirects it as Go's mux does.
        const reply =
            (name: string): Route =>
            (req, res) => {
                res.end(`${name} ${req.url}`);
            };
        const routes = new Map<string, Route>([
            ["/mcp", reply("mcp")],
            ["/api/", reply("api")],
        ]);
        const srv: Server = createServer((req, res) => {
            void router(routes, () => {}, reply("rest"))(req, res);
        });
        await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
        closers.push(() => new Promise<void>((r) => srv.close(() => r())));
        const { port } = srv.address() as AddressInfo;

        // --- When ---
        const have = await new Promise<string>((resolve, reject) => {
            const req = httpRequest(
                { host: "127.0.0.1", port, path: target },
                (res) => {
                    let body = "";
                    res.on("data", (b: Buffer) => {
                        body += b.toString();
                    });
                    res.on("end", () => resolve(body));
                },
            );
            req.on("error", reject);
            req.end();
        });

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("isLoopback", () => {
    it.each<[string, boolean]>([
        ["localhost", true],
        ["LOCALHOST", true],
        ["127.0.0.1", true],
        ["127.1.2.3", true],
        ["::1", true],
        ["[::1]", true],
        ["0.0.0.0", false],
        ["192.168.1.5", false],
        ["example.com", false],
        ["localhost.example.com", false],
        ["", false],
    ])("%s", (host, want) => {
        // --- When ---
        const have = isLoopback(host);

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("refusal", () => {
    /** req is a request with the given headers. */
    const req = (headers: Record<string, string>) =>
        ({ headers }) as unknown as Parameters<typeof refusal>[0];

    it.each<[string, Record<string, string>, boolean, string | undefined]>([
        ["local host", { host: "localhost:7777" }, true, undefined],
        ["IPv6 host", { host: "[::1]:7777" }, true, undefined],
        [
            "other host",
            { host: "evil.example:7777" },
            true,
            "host evil.example:7777 is not local",
        ],
        ["no host header", {}, true, "host  is not local"],
        ["other host, not local", { host: "evil.example" }, false, undefined],
        [
            "local origin",
            { host: "localhost", origin: "http://localhost:3000" },
            true,
            undefined,
        ],
        [
            "other origin",
            { host: "localhost", origin: "https://evil.example" },
            true,
            "origin https://evil.example is not local",
        ],
        [
            "null origin",
            { host: "localhost", origin: "null" },
            true,
            "origin null is not local",
        ],
        [
            "other origin, not local",
            { host: "x", origin: "https://evil.example" },
            false,
            "origin https://evil.example is not local",
        ],
    ])("%s", (_name, headers, local, want) => {
        // --- When ---
        const have = refusal(req(headers), local);

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("serveHTTP on loopback", () => {
    /** status sends GET path to port with headers and returns the status. */
    function status(
        port: number,
        headers: Record<string, string>,
        host = "127.0.0.1",
    ): Promise<number> {
        return new Promise((resolve, reject) => {
            const r = httpRequest(
                { host, port, path: "/x", headers },
                (res) => {
                    res.resume();
                    resolve(res.statusCode ?? 0);
                },
            );
            r.on("error", reject);
            r.end();
        });
    }

    /** start serves an OK handler on addr and returns the bound port. */
    async function start(
        addr: string,
    ): Promise<{ port: number; lines: string[] }> {
        const lines = new Lines();
        const ctl = new AbortController();
        const done = serveHTTP(
            addr,
            (_req, res) => {
                res.end("ok");
            },
            lines.log,
            ctl.signal,
        );
        closers.push(async () => {
            ctl.abort();
            await done;
        });
        const line = await waitFor(
            () => lines.lines.find((l) => l.startsWith("listening on ")),
            "listening",
        );
        return {
            port: Number(line.slice(line.lastIndexOf(":") + 1)),
            lines: lines.lines,
        };
    }

    it("binds the loopback interfaces for an address without a host", async () => {
        // --- When ---
        const { port, lines } = await start(":0");

        // --- Then ---
        expect(lines[0]).toBe(`listening on 127.0.0.1:${port}`);
        expect(
            lines.slice(1).every((l) => l === `listening on [::1]:${port}`),
        ).toBe(true);
        expect(await status(port, { host: `localhost:${port}` })).toBe(200);
        const other = Object.values(networkInterfaces())
            .flat()
            .find((a) => a !== undefined && a.family === "IPv4" && !a.internal);
        if (other !== undefined) {
            const reached = await new Promise<boolean>((resolve) => {
                const sock = netConnect({ host: other.address, port });
                sock.once("connect", () => {
                    sock.destroy();
                    resolve(true);
                });
                sock.once("error", () => resolve(false));
            });
            expect(reached).toBe(false);
        }
    });

    it("refuses a request naming another host or origin", async () => {
        // --- Given ---
        const { port } = await start(":0");

        // --- When ---
        const have = [
            await status(port, { host: "evil.example" }),
            await status(port, {
                host: `localhost:${port}`,
                origin: "https://evil.example",
            }),
            await status(port, {
                host: `127.0.0.1:${port}`,
                origin: "http://localhost:3000",
            }),
        ];

        // --- Then ---
        expect(have).toEqual([403, 403, 200]);
    });

    it("checks only the origin on an explicit wider address", async () => {
        // --- Given ---
        const { port } = await start("0.0.0.0:0");

        // --- When ---
        const have = [
            await status(port, { host: "server.example" }),
            await status(port, {
                host: "server.example",
                origin: "https://evil.example",
            }),
        ];

        // --- Then ---
        expect(have).toEqual([200, 403]);
    });
});
