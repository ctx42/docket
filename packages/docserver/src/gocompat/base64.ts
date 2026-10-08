// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

const ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * goBase64Decode is Go's `base64.StdEncoding.DecodeString`: the padded
 * standard alphabet, CR and LF skipped anywhere, non-zero trailing bits
 * accepted. It returns undefined for malformed input.
 */
export function goBase64Decode(input: string): Uint8Array | undefined {
    const s = input.replace(/[\r\n]/g, "");
    if (s.length % 4 !== 0) return undefined;
    const out: number[] = [];
    for (let q = 0; q < s.length; q += 4) {
        const last = q + 4 === s.length;
        const quad = s.slice(q, q + 4);
        const pad = last ? (/=*$/.exec(quad) as RegExpExecArray)[0].length : 0;
        if (pad > 2) return undefined;
        let bits = 0;
        for (let i = 0; i < 4 - pad; i++) {
            const v = ALPHABET.indexOf(quad[i] as string);
            if (v < 0) return undefined;
            bits = (bits << 6) | v;
        }
        bits <<= 6 * pad;
        out.push((bits >> 16) & 0xff);
        if (pad < 2) out.push((bits >> 8) & 0xff);
        if (pad < 1) out.push(bits & 0xff);
    }
    return new Uint8Array(out);
}
