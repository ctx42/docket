// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The body section of project-config.md that documents the keys the docket
// plugin owns. The plugin keeps it current under its own heading and never
// touches the rest of the body, which other tools (the srd skills' own
// section) and the user may write. Pure, so it is unit-tested.

/** KEYS_HEADING is the heading the plugin owns in the config's body. */
export const KEYS_HEADING = "## Doc server keys";

/** KEYS_SECTION is the whole section, heading included. */
export const KEYS_SECTION = `${KEYS_HEADING}

The docket plugin runs the doc server over this vault and writes the keys
below. The server reads them when it starts, and the plugin restarts the doc
server, when it runs, as soon as one of them changes. Every path is relative
to the vault root. An absolute path, or one that leads out of the vault
(\`../\`), stops the server from starting.

In docket's settings, "Server features" fills \`initiatives\`, \`glossary\`,
\`gaps\`, and \`precedence\` from the vault's files (Detect) and writes them on
Save. You can also edit them here by hand.

### \`mcp-server\`

The name agents know the server by. The vault's \`.mcp.json\` registers the
server under this name, and agents call its tools as \`mcp__<name>__<tool>\`.
The server does not start without it. The plugin writes it when it creates
this note.

### \`mcp-port\`

The local port the server listens on, from 1 to 65535. The plugin picks a free
port on the first start, moves to another one when the port is busy, and keeps
\`.mcp.json\` in step.

### \`sources\`

The folders the server reads and searches: a list of top-level folder names,
without \`/\`. Each folder must exist and appear once. Its name starts the path
of every document in it, for example \`notes/setup.md\`. Anything outside the
sources is invisible to search. The plugin adds the folder of each knowledge
base you add in its settings.

### \`watch\` and \`watch-debounce\`

With \`watch: true\` the server rebuilds its index when a document in a source,
or a file in the gap folder, changes. Without it, changes show only after the
next start. \`watch-debounce\` is how long changes must stay quiet before a
rebuild, so a sync that writes many files at once causes one rebuild. It
defaults to \`500ms\` and allows at most \`1m\`.

### \`precedence\`

How far each folder is trusted, most trusted first: a list of folders inside
the sources, at any depth. Every search result carries the \`rank\` of its
folder: 1 for the first entry, 2 for the second, and so on. Folders not in the
list rank after all of them. The rank does not change the order of results;
it settles disagreements between documents. An entry must exist, appear once,
and must not lie inside \`initiatives\`.

### \`initiatives\`

The folder of drafts that are still being written, such as requirement
documents, inside a source. Its documents are searchable, but they carry no
\`rank\` and can never close a documentation gap: only finished documentation
can.

### \`glossary\`

The shared glossary: one Markdown file, or a folder of them, inside a source.
The server reads the terms and their definitions from it and offers them
through its glossary tool.

### \`gaps\`

The folder for documentation gaps: facts that work on the drafts needs but the
documentation does not supply reliably. Each gap is one file. The server owns
these files and changes them only through its gap tools. The folder must lie
outside every source, and no source may lie inside it.
`;

/**
 * withKeysSection returns a project-config.md `text` whose body carries the
 * current {@link KEYS_SECTION}: appended after the body when missing,
 * replaced in place — its heading to the next \`## \` heading — when
 * outdated, and the text unchanged when current.
 */
export function withKeysSection(text: string): string {
    const at = text.indexOf(`\n${KEYS_HEADING}\n`);
    if (at < 0) {
        const body = text.endsWith("\n") ? text : `${text}\n`;
        return `${body}\n${KEYS_SECTION}`;
    }
    const start = at + 1;
    const next = text.indexOf("\n## ", start + KEYS_HEADING.length);
    const end = next < 0 ? text.length : next + 1;
    const old = text.slice(start, end);
    const want = next < 0 ? KEYS_SECTION : `${KEYS_SECTION}\n`;
    return old === want ? text : text.slice(0, start) + want + text.slice(end);
}
