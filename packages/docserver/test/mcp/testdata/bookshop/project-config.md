---
mcp-server: srd
mcp-port: 7777
sources:
  - docs
  - kb
  - initiatives
gaps: gap
watch: true
watch-debounce: 500ms
glossary: docs/glossary
kb: kb
initiatives: initiatives
precedence:
  - kb
  - docs/ordering
  - docs/catalog
---

# Bookshop project configuration

Example `project-config.md` for a fictional online bookshop. Start the server
from it:

```shell
docket mcp -c examples/bookshop/project-config.md
```

The front matter holds flat keys only (text, number, checkbox, or list of
text), so Obsidian's Properties view can edit it. Every path is relative to
the project root, the directory holding this note; an absolute path, or one
escaping the root with `..`, stops the server. Keys the server does not use are
ignored, so the note can carry settings for other tools too. `kb` is read by
the companion SRD skills, not by the server.

A document's path is its location from the project root, for example
`docs/catalog/epub_delivery.md`; its identity is its front-matter `id` when
set (that document sets `epub-delivery`), else its path. The `.mcp.json`
beside this note registers `srd` on port 7777; the server refuses to
start when the two disagree.

`precedence` ranks the folders by trust, most trusted first, and every
`search`, `get_doc`, and `list_docs` result carries the document's `rank`:
`kb/shipping_times.md` gets 1, `docs/catalog/epub_delivery.md` 3, and the
unlisted `docs/glossary` folder ranks last, 4. Documents under `initiatives`
are work in progress and carry no rank. Rank never reorders search results;
agents use it to settle conflicting statements.

`gaps` names the gap folder, `gap`, which holds one Markdown file per gap;
filled and wontfix gaps move into its `closed/` subfolder. The sample `gap-0001-epub-download-link-after-a-resend.md` is an open gap,
partly filled by the Download Link section of `epub-delivery`; edit it in
Obsidian and the server keeps your changes.
