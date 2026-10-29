// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { connect } from "node:net";

/** RawReply is an HTTP answer as {@link rawGet} reads it off the wire. */
export interface RawReply {
    status: number;
    /** headers maps each lowercased header name to its value. */
    headers: Map<string, string>;
    body: string;
}

/**
 * rawGet sends "GET target HTTP/1.0" to 127.0.0.1:port as raw bytes and
 * reads the answer until the server closes the connection. Bun's fetch and
 * http.request clean dot segments and double slashes out of a path before
 * sending it, so a test of how the server treats an unclean path sends it
 * with rawGet.
 */
export function rawGet(port: number, target: string): Promise<RawReply> {
    return new Promise<RawReply>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const sock = connect(port, "127.0.0.1", () => {
            sock.write(
                `GET ${target} HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
            );
        });
        sock.on("data", (b: Buffer) => chunks.push(b));
        sock.on("error", reject);
        sock.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            const at = text.indexOf("\r\n\r\n");
            const [first = "", ...lines] = text.slice(0, at).split("\r\n");
            const headers = new Map<string, string>();
            for (const line of lines) {
                const colon = line.indexOf(":");
                headers.set(
                    line.slice(0, colon).trim().toLowerCase(),
                    line.slice(colon + 1).trim(),
                );
            }
            resolve({
                status: Number(first.split(" ")[1]),
                headers,
                body: text.slice(at + 4),
            });
        });
    });
}
