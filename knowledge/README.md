# Knowledge

A local stand-in for Amazon Bedrock Knowledge Bases: taking documents in, storing them for search, and answering retrieval requests from agents.

The documents are US drug labels from DailyMed. What exists so far gets them onto disk, reproducibly, counts what they are, parses each into a structured document, and splits it into chunks that can be searched and cited: the labels of the public benchmark [FDARxBench](https://github.com/xiongbetty/FDARxBench), each pinned at one version of its DailyMed label. Which ones are pinned, and why the others are not, is in `knowledge/corpus/manifest.json`. The chunks are indexed in a search engine (OpenSearch), and a retrieval service gives agents keyword search over them as two MCP tools, behind the same token check as the rest of the lab. See "Search and retrieval" below.

## The corpus as pinned

Measured by `knowledge/pin.sh` and `knowledge/census.sh` on the committed `knowledge/corpus/manifest.json`:

| | Labels |
|---|---|
| Records in the benchmark's labels file | 704 |
| Records with a set id | 699 |
| Pinned | 640 |
| Not served by DailyMed (`version-not-served`) | 59 |
| Pinned, prescription labels (document type 34391-3) | 417 |
| Pinned, over-the-counter labels (document type 34390-5) | 223 |
| Pinned, new format | 236 |
| Pinned, old format | 404 |

The corpus therefore holds both prescription and over-the-counter labels. Nothing downstream may assume a label is a prescription label; read its document type code. How it is put together is in [docs/architecture/knowledge.md](../docs/architecture/knowledge.md).

Every command on this page is run from the root of the repository. The host needs a shell and Docker; Node is not needed on it.

## The corpus commands

| Command | What it does | Network | Writes |
|---|---|---|---|
| `knowledge/pin.sh` | Run once. Downloads the benchmark's two files at a fixed revision and records their checksums. For each set id in the labels file, asks DailyMed for the label's history, takes the highest version, downloads it, reads it safely, and records it | DailyMed and GitHub | `knowledge/corpus/benchmark.json` and `knowledge/corpus/manifest.json`, which are committed; the benchmark files in `knowledge/data/benchmark/` |
| `knowledge/fetch.sh` | Reads only the two committed files. Downloads the benchmark files and every label version the manifest names, and checks each against its checksum | DailyMed and GitHub | `knowledge/data/` |
| `knowledge/census.sh` | Counts what the fetched labels are, and how much of the benchmark's text appears word for word in them. Counts and codes only, never label text | None | `knowledge/data/census.json`, and a summary on standard output |
| `knowledge/parse.sh` | Parses every fetched label into a structured document, checks that no text was lost, and reports what did not parse cleanly. Numbers, codes and identifiers only in the report | None | `knowledge/data/parsed/<set id>/<version>.json` for each label without an error; `knowledge/data/parse-report.json` |
| `knowledge/chunk.sh` | Splits every parsed label into chunks, checks that nothing was lost or doubled, and reports what it made. Numbers, codes and identifiers only in the report | None | `knowledge/data/chunks/<set id>/<version>.jsonl`, one chunk per line in document order; `knowledge/data/chunk-report.json` |

`knowledge/index.sh` and `knowledge/gate.sh`, which work on a running stack, are described under "Search and retrieval".

Each takes no arguments. Each builds the image `knowledge-corpus:checkout-<number>` from the `run` stage of `toolchain/Dockerfile`, named for the checkout like the toolchain's check image, and runs the tool in it as your user, with a read-only root filesystem and no capabilities, with only `knowledge/corpus/` and `knowledge/data/` mounted.

| Exit code | `pin.sh` | `fetch.sh` | `census.sh` | `parse.sh` and `chunk.sh` |
|---|---|---|---|---|
| 0 | Both files written | Everything fetched and verified | Every pinned label counted | Ran to the end, whatever the labels' results |
| 1 | A request failed after every attempt; neither file was written | Something was refused; the rest was fetched | Some pinned labels are missing or do not match; the rest were counted | Not used |
| 2 | Could not run | Could not run, or the committed files do not pass their schema | The same | The same |

### Pinning

- A label DailyMed does not serve, or whose archive or XML is refused (see "Safety"), is listed in the manifest as not pinned, with a reason code. That is not an error for the run.
- A benchmark record whose set id is not a GUID is listed the same way, by its `drug_id`. The labels file at the pinned revision holds 704 records: 699 with a GUID and 5 with an empty set id.
- A request that fails after every attempt stops the run before anything is written to `knowledge/corpus/`, so a passing network fault is never committed as a fact about a label.
- Pinning leaves the benchmark files in `knowledge/data/benchmark/`, but no label files.

### Fetching

- A file already present whose checksum matches is not downloaded again. A second run on complete data sends no request and changes no file, the report included. The command prints how many requests it sent.
- The XML's SHA-256 is what must match the manifest. If the zip's bytes differ but its XML matches, the label is accepted and reported as repackaged.
- A label whose XML checksum differs, whose version is no longer served, whose download fails after every attempt, or whose download is refused as unsafe is not written. The run carries on with the others, lists each such label and its reason on standard error and in the report, and exits 1.
- A file in `knowledge/data/` that does not match the manifest is removed before its label is downloaded again, so the folder never holds a wrong label.

### The census

For each label: its set id, version, document type code, XML size, whether the benchmark's `drug_name` occurs in its text, its format (new or old), the counts of sections, unclassified sections, untitled sections, tables, tables with no `thead`, cells with `rowspan` or `colspan`, footnotes, images and products; the benchmark's questions on it by task and how many come from Highlights; and how many of the benchmark's answer passages and chunks for it occur word for word in the fetched version. The rules for each count, for the text that is compared and for its normalisation are written into `census.json` itself.

### Parsing

One pure function turns a label's XML bytes into a document and a list of problems; it reads no clock, no randomness and no file. A second run on unchanged input writes byte-identical files.

What a parsed document holds:

| Part | What it is |
|---|---|
| Identity | Set id, version, document id, effective time, document type code, `kind` (`prescription` for 34391-3, `otc` for 34390-5, `other` otherwise), `format` (`new` or `old`, by the census's rule), and the document's title |
| Products | For each product in the product data: its name, its generic name if given, and the names of its active ingredients |
| Sections | A tree in document order. Each has its id from the XML, its code, its title with white space collapsed (or none), a `number` (only in a new-format label, only when the title starts with the form `5` or `5.1`), its path (the titles from the top down, untitled sections skipped), its blocks, its Highlights blocks and its child sections |
| Paragraph | Text, the footnotes written in it, the marks in its text, and an indent (the number of leading non-breaking spaces, which are not kept in the text) |
| List | Ordered or not; each item with its caption or marker if the label gives one, its text, its footnotes, and any nested list, table or image |
| Table | Its caption and where it came from (`element`, `inferred` from a first row of one cell across every column, or `none`); its rows as written, each cell with text, header flag, row and column span and indent; for each row, whether it is wholly bold (every cell with text is a `th` or wholly bold) and how many of its cells have text, so a later step can tell a column heading from a row that labels a group of rows; the expanded grid, where the widest row sets the width and a short row's positions after its last cell are empty; its header rows and where they came from (`thead`, `inferred` from leading rows of `th` cells or wholly bold cells, or `none`); its footnotes (from `tfoot`, from footnote elements in cells, or both) with the cells that refer to each. A table inside a cell is kept in that cell as a nested table |
| Image | The referenced object's id, its descriptive text, and the caption on the reference |
| Highlights | The text a section keeps as an excerpt (`excerpt/highlight`), as blocks of their own, never mixed into the section's blocks |

Text rules: white space is collapsed; a line break element becomes a line break, and a line break in the source is only layout; superscript and subscript are kept and marked as `^{...}` and `_{...}`; bold, italic and links leave the text unchanged; a footnote written inline is replaced by its mark, `[^N]` in document order (`[^?]` for a reference to a footnote that does not exist), and listed with its text on its block.

Problems never carry label text: a code, a severity, the section id or the table's position (its index among the section's tables, nested ones counted), and counts.

| Code | Severity | Meaning |
|---|---|---|
| `text-not-conserved` | error | The check below failed; the problem gives the tokens missing and extra |
| `table-not-rectangular` | error | Once spans are applied, two cells claim one position, a span runs past the last row, or a row leaves an empty position before a covered one |
| `no-sections` | error | The body has no section with text |
| `unreadable` | error | The XML could not be read: a step 1 refusal, or the file is missing or does not match the manifest |
| `section-untitled` | warning | A section with no title |
| `section-unclassified` | warning | A section coded 42229-5 |
| `table-header-inferred` | warning | A table whose header rows were inferred |
| `table-header-none` | warning | A table with no header rows |
| `table-caption-inferred` | warning | A caption taken from a first row |
| `table-nested` | warning | A table inside a table cell, at any depth |
| `table-row-short` | warning | A table with rows that cover fewer columns than its widest row; one per table, with the number of such rows. Cells fill a row from the left, as the label is displayed, and the positions after the last cell are empty |
| `footnote-mark-unmatched` | warning | A `tfoot` footnote whose mark no cell of its table carries |
| `section-images-only` | warning | A section whose only content is images |
| `footnote-reference-unmatched` | warning | A footnote reference that matches no footnote |
| `element-unknown` | warning | An element the parser does not know, by name and count. Its text is kept in the block it sits in |

A label with any error gets no parsed file and is listed as excluded; one with only warnings is written, with its warnings.

**The check that no text was lost** does not share the parser's traversal. Side A is every text node under the label's body, taken by a walk that knows only two things: product data (`subject` elements) is skipped, because it is parsed into products and is not prose; and every element boundary separates words except `content` and `linkHtml`, which only style or link text. Side B is every piece of text in the parsed document: titles, paragraphs, list items and their captions, cells, captions, footnotes, image text (once per object) and captions, Highlights, with the parser's footnote marks removed. Each side is cut into tokens at every character that is not a letter or a digit, and the two collections with their counts must be equal. A dropped word, a doubled word or two numbers run together fails it; the marks the parser adds do not.

### Chunking

One pure function turns a parsed document and two settings into chunks: the size limit in words for text, and the size limit above which a splittable table is split. Both are passed by name from `chunk.sh` (300 and 300); neither has a default. A word is a run between white space that holds a letter or a digit, so the ` | ` between cells is not counted. A second run writes the same bytes.

What a chunk carries:

| Field | What it is |
|---|---|
| `id` | `<set id>/<version>/<section key>/<part>/<n>`: the section key is the section's own id when the label gives it to exactly one section, otherwise its position in the tree (`at-1.2`); `n` counts that section's chunks of that part |
| `setId`, `version`, `effectiveTime`, `kind`, `format`, `documentTypeCode` | The label |
| `drug` | Every product name, generic name and active-ingredient name, once each, compared without case |
| `section` | The section's id, code, number, title and title path |
| `part` | `body` or `highlights` |
| `type` | `text`, `table` (a whole table) or `table-rows` (some rows of a table) |
| `position` | The chunk's ordinal in the label; for `table-rows`, the first and last row it holds and the table's row count |
| `text` | The content, in the plain form below |
| `repeated` | The lines of `text` repeated from elsewhere so the chunk stands alone |
| `context` | One line, `<drug names>: <title path>`, to put in front of `text` when wanted. Not part of `text` |
| `words` | The number of words in `text` |
| `source` | The label's page at DailyMed for this version |

Text:

- A section's own blocks make its chunks; child sections make their own; a section with no blocks makes none. Highlights blocks are chunked the same way, as `part` `highlights`.
- Blocks are packed in order until the next would pass the limit. No overlap.
- A paragraph over the limit is split at sentence ends, and a sentence over the limit between words.
- A list stays together when it fits; otherwise it is split between items, inside an item only when the item alone passes the limit. A nested list stays with its item. An item is written with its caption or marker; nested items are indented by two spaces.
- A block's footnotes are written after it, each with its mark, in the same chunk.
- An image gives its descriptive text and caption. A section whose blocks are images with no text makes no chunk.
- A table is never packed with text: it makes its own chunk or chunks.

Tables:

- **Plain form.** The caption on a line; each row on a line, cells separated by ` | `, an empty position as nothing, a cell covering several positions written once at its first; a cell's line breaks as ` / `; a nested table, in the same form, after its row; then the footnotes, each on a line with its mark. No Markdown table syntax.
- **Splittable** only when its header rows come from the label's `thead`, it has no nested table and no short row, and every wholly bold row below the header has exactly one filled cell (a group label).
- **A table that is not splittable is one chunk, whatever its size**, and one over the limit is counted as oversize. A splittable table within the limit is one chunk too.
- **A splittable table over the limit** is split into `table-rows` chunks of consecutive body rows, as many as fit. Each holds the caption, every header row, the group label in force (carried in from above, or in its place), the rows, the footnotes its cells refer to, the footnotes a header cell refers to, and every footnote no cell refers to.
  - The first chunk holds the caption, header rows and footnotes in their place. Each later chunk repeats the caption and header rows (and any footnote already written) and lists them in `repeated`, along with a carried group label.
  - A group label is never the last row of a chunk.
  - A chunk never ends between two rows that a cell spans.

**The check that nothing was lost or doubled** takes its own walk of the parsed document. One side is every word in the document's blocks and Highlights blocks; titles are left out, being in `context`. The other is every word in the chunks' text, less the words of their `repeated` lines. The parser's footnote marks are removed from both, both are cut into tokens at every character that is not a letter or a digit, and the two collections with their counts must be equal. A label that fails gets no chunk file and is listed in the report with the numbers missing and extra.

## Search and retrieval

Two services in `knowledge/compose.yaml`, started with the rest of the lab by the root `compose.yaml`, and two commands that work on a running stack:

| | What it is |
|---|---|
| `search` | OpenSearch 3.9.0, released 2026-09-29: the newest stable 3.x release published at least 14 days before it was pinned. Pinned by the digest of its multi-architecture index (linux/amd64, linux/arm64). It has the score ranker processor that hybrid search with rank fusion needs (a search pipeline using it was accepted by the running engine), though nothing here uses it yet. One node, a 1 GB heap, its data in the named volume `search-data`. It publishes no port: only containers on the stack's network reach it. Healthy once the cluster answers and is not red |
| `knowledge` | The retrieval service, built from `knowledge/src/` with the `run` stage of `toolchain/Dockerfile`. MCP at `POST /mcp` and `GET /ping` on port 8000, published at `127.0.0.1:8002` |
| `knowledge/index.sh <compose-project>` | Loads the chunks into the stack's search engine, from a container on its network |
| `knowledge/gate.sh <compose-project>` | Checks the retrieval path of a running stack whose index is built |

Start-up, from the repository root: `knowledge/fetch.sh`, `knowledge/parse.sh` and `knowledge/chunk.sh`; then `docker compose up -d --build --wait`; then `knowledge/index.sh ai-on-aws`.

### Indexing

- The index is named `labels-` and 16 hex characters of a SHA-256 of the chunk report's bytes and of the index definition below. A different set of chunks, or a different mapping, is a different index.
- It creates the index with the explicit definition and loads every chunk once, in bulk requests of 500, using each chunk's id as the document id. If the engine reports an error for any item of a bulk request, the run fails whatever the count, and the output gives the number of items refused and the first one's error type. Otherwise it checks that the engine's count of documents equals the number of chunks read. Only then does it point the alias `labels` at the new index. On a refused item or a count that differs, it leaves the alias where it was, removes the index it made, and exits 1.
- If the index for this hash already exists with the right count and the alias points at it, it changes nothing and says so. With the right count and the alias elsewhere, it only moves the alias.
- Older indexes are left in place and listed in the output.

| Exit code | `index.sh` |
|---|---|
| 0 | The alias points at a complete index, built now or already |
| 1 | The engine refused an item of a bulk request, or its count differed from the chunks read; the new index was removed and the alias left as it was |
| 2 | Could not run: no such stack, the chunk files disagree with the chunk report, or the engine could not be asked |

The mapping is strict: a chunk with a field not named here is refused.

| Field | Held as | Searched |
|---|---|---|
| `text`, `context` | Text, standard analyzer | Yes, by `search_label` (BM25) |
| `drug` | Text, standard analyzer, and `drug.exact`: a keyword compared without case or surrounding white space | Yes, by `find_labels` |
| `setId`, `version`, `kind`, `format`, `part`, `type`, `section.id`, `section.code`, `section.number` | Exact keywords | As filters |
| `id`, `effectiveTime`, `documentTypeCode`, `source`, `section.title`, `section.path` | Keywords, stored, not indexed (`effectiveTime` is sortable) | No |
| `repeated` | Text, stored, not indexed | No |
| `words` | Integer, stored, not indexed | No |
| `position` | Object, stored, not indexed | No |

The index has one shard and no replica.

### The retrieval service

Settings, each required and read by name: `SEARCH_URL` (`http://search:9200`), `SEARCH_INDEX` (`labels`), and `AUTH_DISCOVERY_URL`, `AUTH_ISSUER`, `AUTH_ALLOWED_AUDIENCE` (`lab-knowledge`), `AUTH_ALLOWED_CLIENTS` (`desk`) and `AUTH_ROLES_CLAIM` (`roles`), in the form the case system uses. Every route but `GET /ping` requires a valid access token, checked with `shared/access-token.ts` before the body is read. A refusal is 401 with `WWW-Authenticate` and `{error, reason, detail}`; a provider that cannot be asked is 503.

It talks to the engine with `fetch` and its REST API, with no client library. Each request may take 5 seconds.

| Tool | Input | Returns |
|---|---|---|
| `find_labels` | `drug`: a name as a person would write it | The labels whose product, generic or active-ingredient name is that name, compared without case or surrounding white space; if none, the labels whose names hold every word given. At most 10, newest effective date first, and `more_matched` says whether more matched. For each: set id, version, effective date, kind, format, the names, and the label's page at DailyMed. No match is an empty list |
| `search_label` | `set_id`; `query`; `part` (`body` or `highlights`, or both when left out); `max_results` (1 to 10, default 5) | Passages from that one label only, best first, ranked by BM25 over the chunk's text and context line. For each: chunk id, text, score, part, type, the section's number, title and path, the position, and the label's set id, version, effective date, kind and page at DailyMed |

How the input is held:

- The query goes only into a full-text match. The engine never reads it as a query language, so operator characters, field names and other set ids in it have no effect.
- The set id (and the part) are exact filters, set by code from the tool's arguments.
- Input outside the limits is refused before anything is sent: an empty query, `max_results` outside 1 to 10, an unknown `part`, or a set id that is not a lowercase GUID.

Every failure is an error result that says which; none is ever an empty list.

| Error | When |
|---|---|
| `invalid_input` | The input is outside the limits |
| `label_not_found` | No document has that set id. The error names it, so "no such label" cannot be read as "the label says nothing" |
| `index_not_built` | The alias does not exist: run `knowledge/index.sh` |
| `search_timed_out` | The engine did not answer in time |
| `search_unreachable` | The engine could not be reached |
| `search_error` | The engine answered with an error status |
| `search_unexpected_answer` | The engine answered in a form the service does not expect |

### The gate

`knowledge/gate.sh <compose-project>` runs from inside the stack's network. It prints a JSON report on standard output and nothing else, and exits 0, 1 or 2 by the same rules as `platform/identity/stack-gate.sh`. Neither its report nor standard error carries a secret, a token or label text: identifiers, codes and counts only. It signs in as `dana.desk` through the `desk` client, as the identity gate does, with the secrets passed from `platform/identity/.env` by Compose. It runs the knowledge image named for this checkout (`knowledge-corpus:checkout-<number>`), in a compose project also named for it, and prints the image on standard error. Its statements:

1. The service answers 401 with reason `missing` to no token, and 200 on `/ping`.
2. The alias `labels` exists and holds exactly as many documents as the chunk report counts.
3. `find_labels` returns the manifest's first label for that label's name shared by the fewest labels. The same name in other case, with spaces around it, returns the same label by exact match. The words of a multi-word name, reordered and matching no name exactly, return its label by the every-word fallback; that name is the first in manifest order whose words match at most 10 labels. A name no label has gives an empty list.
4. `search_label` on that label, with a word from one of its chunks, returns at least one passage. Every passage carries that set id and every field listed above, and the scores do not increase down the list.
5. A query made only of query-language characters, and one naming another field and another set id, each return only passages from the one label, or none, and no error.
6. A GUID not in the index returns `label_not_found`.
7. `max_results` 1 returns one passage, 10 at most ten, and 11 is refused.
8. 200 benchmark searches, each restricted to the question's own label, answer without an error.

It also measures, and does not assert, how often a passage from a referenced section is among the first five results. The 200 questions are those whose label is indexed and whose `references` is a list, sorted by `qid` and taken evenly. A hit is a passage among the first five whose section number equals the number a reference starts with, or whose title equals a reference, ignoring case and spacing. The report also gives the median and 95th-percentile time of its `search_label` calls.

### Hardening

The retrieval service runs with a read-only root, no capabilities, no new privileges and an init process, like the case system. The search engine runs with no capabilities, no new privileges and an init process, with `/tmp` and its log folder on tmpfs. It cannot have a read-only root: at every start OpenSearch writes `config/opensearch.keystore` into its configuration folder, whose other files must come from the image. A tmpfs over that folder would hide them. With every other writable folder given a tmpfs, a read-only root still stopped it at start (exit 70).

## Where data goes

```
knowledge/
├── corpus/                     committed
│   ├── benchmark.json          the benchmark's repository, revision, licence, and each file's path, SHA-256 and size
│   └── manifest.json           one entry per pinned label; the labels not pinned, each with a reason code
└── data/                       never committed (.gitignore), never in an image (.dockerignore)
    ├── benchmark/
    │   ├── labels.jsonl
    │   └── qa.jsonl
    ├── labels/<set id>/
    │   ├── <version>.xml       the label, as it was inside the zip
    │   └── <version>.download.json   the SHA-256 of the zip it came from and of the XML
    ├── fetch-report.json       counts, and the labels in each state: verified, repackaged, refused (with a reason)
    ├── census.json
    ├── parsed/<set id>/
    │   └── <version>.json      the parsed document, and its warnings; only for a label without an error
    ├── parse-report.json       counts by error, kind and format; warnings with counts and labels touched;
                                tables by header and caption source, with counts that bear on header rows;
                                untitled sections by code; unknown elements; one entry per label
    ├── chunks/<set id>/
    │   └── <version>.jsonl     one chunk per line, in document order; only for a label that passes the check
    └── chunk-report.json       labels chunked and not; chunks by type and part; size distributions; tables by
                                outcome and by the condition that makes them not splittable; splits; the ten
                                largest chunks by id; one entry per label
```

A manifest entry holds: set id, version, document id, effective time, published date, document type code, the SHA-256 of the zip as downloaded and of the XML inside it, and the XML's size in bytes. Entries are sorted by set id, so the same inputs give a byte-identical file.

## Requests

- At most 2 requests to DailyMed at once, and 1 to GitHub. The tool refuses a setting above 4; `lib.sh` sets 2, because a first pinning run at 4 at once, with waits of 2 and 8 seconds, was answered 429 by DailyMed's history service for 20 set ids three times running.
- A request with no response, or a status of 408, 429 or 5xx, is tried 3 times in all, waiting 10 and then 60 seconds. A 404 is not tried again. One attempt may take 120 seconds.
- Every request carries the User-Agent `label-corpus-fetch/1.0` and nothing that identifies a person, a machine or this repository.

These settings are written in `knowledge/lib.sh` and passed to the tool by name.

## Safety

Downloads are untrusted input.

- Only one member of each zip is read: the label's XML, the one member whose name ends in `.xml`. A zip with no such member, or with more than one, is refused.
- No name from inside an archive is used to name a file on disk. Output names are built from the manifest's set id and version, and a set id that is not a lowercase GUID is refused.
- The XML's decompressed size is capped at 20 MiB (20,971,520 bytes), counted on the bytes actually produced, not the size the archive declares. A zip's download is capped at 50 MiB (52,428,800 bytes).
- The XML reader resolves no external entity, loads no DTD and fetches no stylesheet. A label whose DOCTYPE declares any entity is refused. A label that is not UTF-8, or not well-formed, is refused.
- Reasons are written as fixed codes. A parser's own message, which can quote the document, never reaches a file.

The libraries: [yauzl](https://github.com/thejoshwolfe/yauzl) 3.4.0 reads the zip, and [@xmldom/xmldom](https://github.com/xmldom/xmldom) 0.9.12 reads the XML. Both are MIT-licensed and exact versions in the root `package.json`.

## Tests

`knowledge/test/` holds tests F1 to F13 for pinning, fetching and the census, P1 to P21 for parsing, U1 to U18 for chunking, and S1 to S14 for indexing and retrieval, run by `toolchain/check.sh` with everything else. The first use a labelled stand-in for DailyMed and for the benchmark's host, on loopback, serving synthetic labels and zips built in the tests; the parser's and the splitter's tests use synthetic labels in `knowledge/test/support/labels.ts` and `knowledge/test/support/chunking.ts`. The retrieval tests use a labelled stand-in for the search engine that records requests and answers as told: it shows the wiring and the handling of each failure, not ranking. Their tokens are real signed ones from `test-support/issuer.ts`. No real label text is in them.

## Not present

- **The search engine's security plugin is off.** It has no TLS, no sign-in and no access control: any container on the stack's network can read, change or delete every index. It publishes no port, so nothing outside that network reaches it. The retrieval service is the only path an agent is given, and it holds the token check. Do not publish the engine's port.
- No embeddings, vector search, hybrid search or reranking: retrieval is keyword (BM25) only. No Bedrock data source.
- No agent calls the retrieval service yet.
- No removal of old indexes; `index.sh` lists them.
- No backup of the index: it is rebuilt from the chunks with `index.sh`.
- No limit on the size of a table that is not splittable: such a table is one chunk, however long.
- No chunk that holds text and a table together.
- No decision on which rows of a table are really column headings: the parser infers header rows by one fixed rule and records, for every row, whether it is wholly bold and how many cells have text. Telling a column heading from a group label is left to the step that splits tables.
- No text from images: an image is kept as its object id, descriptive text and caption.
- No section numbers in old-format labels, whose numbering stays in the title.

## Terms

- **Labels come from DailyMed, a service of the National Library of Medicine (NLM).** This piece is not endorsed by NLM. As NLM asks: the data from DailyMed may not be current; check DailyMed for the latest version of a label.
- **Labels are not redistributed here.** No source states that label text written by a manufacturer is in the public domain, so this repository holds only the manifest and the commands that fetch the labels. Run `knowledge/fetch.sh` to get them.
- **FDARxBench** is by its authors, under the Apache License 2.0. Its files are downloaded at a pinned revision and are not copied into this repository.
