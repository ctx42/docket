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

The docket plugin writes these keys and runs the doc server, which reads them
when it starts; the plugin restarts it when one of them changes. Every path is
relative to the vault root; an absolute path, or one leading out of it
(\`../\`), stops the server from starting.

| Key              | Meaning                                                                                       |
|------------------|-----------------------------------------------------------------------------------------------|
| \`mcp-server\`     | Name the server is registered under in \`.mcp.json\`; its tools are \`mcp__<name>__<tool>\`      |
| \`mcp-port\`       | Port the server listens on; the plugin moves it to a free port, and updates \`.mcp.json\`     |
| \`sources\`        | Top-level folders the server indexes; a folder outside them is invisible to search           |
| \`watch\`          | Rebuild the index when a source or the gap folder changes, without a restart                 |
| \`watch-debounce\` | How long changes must be quiet before a rebuild (default \`500ms\`, at most \`1m\`)             |
| \`initiatives\`    | Drafts folder inside a source: its documents carry no \`rank\` and never fill a gap            |
| \`glossary\`       | Glossary file or folder inside a source, served by the glossary tool                         |
| \`gaps\`           | Gap folder, one file per documentation gap; outside every source, holding none               |
| \`precedence\`     | Folders inside the sources, most trusted first; a result's \`rank\` settles disagreements     |

The settings tab's "Server features" fills \`initiatives\`, \`glossary\`,
\`gaps\`, and \`precedence\` from the vault (Detect) and writes them on Save.
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
