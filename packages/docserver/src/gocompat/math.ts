// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Go `math.Log` as Go computes it on amd64 (math/log_amd64.s, the fdlibm
// algorithm). JavaScript's `Math.log` is the platform libm and can differ in
// the last bit, which would change BM25 scores; this port repeats the Go
// instruction sequence so results are bit-identical.

// Go's constants, written as the shortest literals of the same doubles.
const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const L1 = 0.6666666666666735;
const L2 = 0.3999999999940942;
const L3 = 0.2857142874366239;
const L4 = 0.22222198432149784;
const L5 = 0.1818357216161805;
const L6 = 0.15313837699209373;
const L7 = 0.14798198605116586;
const HALF_SQRT2 = 0.7071067811865476;

const view = new DataView(new ArrayBuffer(8));

/** goLog returns the natural logarithm of x exactly as Go's `math.Log`. */
export function goLog(x: number): number {
    if (Number.isNaN(x) || x === Number.POSITIVE_INFINITY) return x;
    if (x < 0) return Number.NaN;
    if (x === 0) return Number.NEGATIVE_INFINITY;

    // f1, ki := Frexp(x), by bit manipulation as the assembly does.
    view.setFloat64(0, x);
    const hi = view.getUint32(0);
    let k = ((hi >>> 20) & 0x7ff) - 0x3fe;
    view.setUint32(0, (hi & 0x000fffff) | 0x3fe00000);
    let f1 = view.getFloat64(0);
    // if f1 <= Sqrt2/2 { k--; f1 *= 2 } (the assembly's cmpnlt).
    if (!(HALF_SQRT2 < f1)) {
        k -= 1;
        f1 *= 2;
    }
    const f = f1 - 1;
    const s = f / (2 + f);
    const s2 = s * s;
    const s4 = s2 * s2;
    const t1 = s2 * (((L7 * s4 + L5) * s4 + L3) * s4 + L1);
    const t2 = s4 * ((L6 * s4 + L4) * s4 + L2);
    const R = t1 + t2;
    const hfsq = 0.5 * f * f;
    return k * LN2_HI - (hfsq - (s * (hfsq + R) + k * LN2_LO) - f);
}
