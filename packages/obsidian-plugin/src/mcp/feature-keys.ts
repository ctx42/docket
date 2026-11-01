// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The doc server's feature keys in project-config.md — the unranked drafts
// folder (`initiatives`), the glossary, the gap folder, and the trust order
// (`precedence`) — found in the vault's files and written line by line, so
// comments and keys other tools write stay as they are. Pure, so it is
// unit-tested; the settings tab is DOM glue around it.

/** FeatureKey is one key the Detect action fills. */
export type FeatureKey = "initiatives" | "glossary" | "gaps" | "precedence";

/** Found is a detected value, or the candidates seen when there is not one. */
export type Found = { value: string | string[] } | { candidates: string[] };

/** posix basename without a `.md` extension. */
function stem(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/** folders returns every folder path the file paths imply. */
function folders(files: readonly string[]): string[] {
    const out = new Set<string>();
    for (const f of files) {
        const parts = f.split("/");
        for (let i = 1; i < parts.length; i++)
            out.add(parts.slice(0, i).join("/"));
    }
    return [...out].sort();
}

/** one turns a candidate list into a value when it holds exactly one. */
function one(candidates: string[]): Found {
    return candidates.length === 1
        ? { value: candidates[0] as string }
        : { candidates };
}

/**
 * detectKeys proposes the feature keys from the vault's Markdown `files`
 * (vault-relative paths) and its `sources`: the SRD folder (a folder inside a
 * source named `srd` or `initiatives`, else one whose subfolders each hold a
 * `*-srd.md`), the folder or file named `glossary` inside a source, the gap
 * folder `gap`, and the trust order — `kb` first when it is a source, then
 * each other source's subfolders (or the source, having none) in name order,
 * leaving out the SRD folder and any folder holding it.
 */
export function detectKeys(
    files: readonly string[],
    sources: readonly string[],
): Record<FeatureKey, Found> {
    const inSource = (p: string) => sources.some((s) => p.startsWith(`${s}/`));
    const all = folders(files).filter(inSource);
    let srd = all.filter((d) => stem(d) === "srd" || stem(d) === "initiatives");
    if (srd.length === 0) {
        srd = all.filter((d) => {
            const subs = all.filter(
                (s) =>
                    s.startsWith(`${d}/`) &&
                    !s.slice(d.length + 1).includes("/"),
            );
            return (
                subs.length > 0 &&
                subs.every((s) =>
                    files.some(
                        (f) =>
                            f.startsWith(`${s}/`) &&
                            !f.slice(s.length + 1).includes("/") &&
                            f.endsWith("-srd.md"),
                    ),
                )
            );
        });
    }
    const initiatives = one(srd);
    const glossary = one(
        [...all, ...files.filter(inSource)]
            .filter((p) => stem(p) === "glossary")
            .sort(),
    );
    const unranked =
        "value" in initiatives ? (initiatives.value as string) : "";
    const order: string[] = sources.includes("kb") ? ["kb"] : [];
    for (const src of [...sources].filter((s) => s !== "kb").sort()) {
        const subs = all.filter(
            (d) =>
                d.startsWith(`${src}/`) &&
                !d.slice(src.length + 1).includes("/"),
        );
        for (const d of subs.length === 0 ? [src] : subs) {
            if (
                unranked !== "" &&
                (d === unranked || unranked.startsWith(`${d}/`))
            )
                continue;
            order.push(d);
        }
    }
    return {
        initiatives,
        glossary,
        gaps: { value: "gap" },
        precedence: { value: order },
    };
}

/**
 * setKeyLines returns a project-config.md `text` with `key` set to `value` —
 * a scalar line, or a block list for an array — replacing the key's lines in
 * place or adding them at the end of the front matter; every other byte is
 * kept. It throws for a note without front matter.
 */
export function setKeyLines(
    text: string,
    key: string,
    value: string | readonly string[],
): string {
    const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (m === null) throw new Error("the config note has no front matter");
    const front = m[1] as string;
    const nl = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = front.split(/\r?\n/);
    const set =
        typeof value === "string"
            ? [`${key}: ${value}`]
            : [`${key}:`, ...value.map((v) => `  - ${v}`)];
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at < 0) {
        lines.push(...set);
    } else {
        let end = at + 1;
        while (end < lines.length && /^[\s-]/.test(lines[end] as string)) end++;
        lines.splice(at, end - at, ...set);
    }
    const start = m[0].indexOf(front);
    return (
        text.slice(0, start) + lines.join(nl) + text.slice(start + front.length)
    );
}

/**
 * keyValue returns the value a project-config.md `text` sets for `key`: a
 * scalar (quotes and a trailing comment dropped), the items of a block or
 * flow list, or undefined when the key is unset.
 */
export function keyValue(
    text: string,
    key: string,
): string | string[] | undefined {
    const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (m === null) return undefined;
    const lines = (m[1] as string).split(/\r?\n/);
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at < 0) return undefined;
    const clean = (v: string) =>
        v
            .replace(/\s+#.*$/, "")
            .trim()
            .replace(/^(["'])(.*)\1$/, "$2");
    const rest = clean((lines[at] as string).slice(key.length + 1));
    if (rest.startsWith("[") && rest.endsWith("]")) {
        return rest
            .slice(1, -1)
            .split(",")
            .map(clean)
            .filter((v) => v !== "");
    }
    if (rest !== "") return rest;
    const items: string[] = [];
    for (let i = at + 1; i < lines.length; i++) {
        const item = /^\s*-\s*(.*)$/.exec(lines[i] as string);
        if (item === null) break;
        items.push(clean(item[1] as string));
    }
    return items;
}
