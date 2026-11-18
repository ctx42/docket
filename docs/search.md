# Writing documents that search well

The docket doc server finds documents with **BM25 keyword search over
sections**. It has no semantic matching: a document is found only by the words
it contains, and it ranks by where those words sit. This page says how the
server cuts and ranks a document, and how to write one that it finds. It
applies to every document the server indexes: synced Confluence pages, a
knowledge base, gap drafts.

## How the server indexes a document

- **Sections.** A body of about 600 words or fewer (the server estimates 800
  tokens, at four tokens per three words) stays one section. A longer body is
  cut at every level-1 (`#`) and level-2 (`##`) heading outside fenced code.
  A `###` or deeper heading never starts a section; it only extends the
  heading path of the section it sits in.
- **Three fields, three weights.** Each section is indexed in three fields:
  - the **title** (weight 3): the front-matter `title`, then every front-matter
    `alias`;
  - the **heading** (weight 2): the heading path of the section;
  - the **body** (weight 1): the words of the document path, then the section
    text.

  A word in a higher field ranks a section higher than the same word in the
  body. A short page is one section with an empty heading path, so its
  headings count only as body text.
- **Words.** Text is split into words, lowercased, cleared of English stop
  words (such as "the" and "of"), and reduced to a stem: "shipping",
  "shipped", and "ships" all match "ship". In the document path, `/`, `_`, and
  `-` split words, and `.md` is dropped.
- **Citation.** A result cites the front-matter `url`. Without one, it cites
  the first `http(s)` URL in the body.
- **Trust rank.** A project can rank folders with `precedence`. The rank
  travels with each result, but it never changes the order.

## Headings

- On a page that may grow past about 600 words, break it into sections with
  `#` or `##`, one topic each. A `###` heading does not make a new section.
- Put the words people search for into `#` and `##` headings. On a long page
  they rank higher there than in the body. Avoid empty headings such as
  "Overview" or "Notes".
- Split a long `##` section into focused `##` sections, not into `###`
  subsections, when each part answers a different question.

## Title, file name, and aliases

- Give every document a descriptive front-matter `title`. Every section of the
  document carries it in the title field.
- Name the file for its topic. Its path words are searchable, for example
  `kb/shipping/express_times.md` matches "express" and "times".
- Put synonyms and other names in front-matter `aliases` once, not spread
  through the text. They count as title words. Do not write plural or tense
  forms: stemming already matches them.

## Facts

- State each fact as one plain sentence that uses the words a reader will
  search for. A reader checks a claim by searching for its words.
- Use one name for one thing. Two names for the same thing split the matches
  between them.
- In a glossary, give each term its own `##` heading, with the definition as
  the first paragraph under it. The `glossary_terms` tool lists each such
  heading as a term.

## Links, tables, and metadata

- Set the canonical URL as front-matter `url`. Otherwise the first link in the
  body becomes the citation, even an unrelated one.
- A draft that is not published yet has no URL: leave `url` out until it is.
  The server cites a `url` as written, so a placeholder there becomes the
  citation.
- Give tables real column headers and a one-line sentence that says what the
  table holds. Cells alone give the search few words to match.
- Open a page with a two-column key/value table (such as `Status` and
  `Owners`) to make its fields listable: `list_docs` with `fields` reads that
  table as plain text, with front-matter keys taking precedence.

## After you write

- The server rebuilds its index when a watched source changes, after a short
  quiet time. `index_status` says whether a change is still `pending`; call it
  with `reindex: true` to rebuild at once, before you search for what you just
  wrote.
- Cite a document by its `id`, which stays the same when the document moves.
  `check_refs` tells which stored citations still point to a document or
  section, and suggests where a lost one may have moved.
- Narrow a search to one folder with `folder`, for example `kb`. Read one
  section with `get_doc` and `<id>#<anchor>`.
