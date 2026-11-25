# Knowledge

A local stand-in for Amazon Bedrock Knowledge Bases: taking documents in, storing them for search, and answering retrieval requests from agents.

The documents are US drug labels from DailyMed. This piece gets them onto disk, reproducibly, counts what they are, parses each into a structured document, and splits it into chunks that can be searched and cited: the labels of the public benchmark [FDARxBench](https://github.com/xiongbetty/FDARxBench), each pinned at one version of its DailyMed label. Which ones are pinned, and why the others are not, is in `knowledge/corpus/manifest.json`. Each chunk can be given a vector by the embedding server. The chunks are indexed in a search engine (OpenSearch), and a retrieval service gives agents search over them as two MCP tools, behind the same token check as the rest of the lab: by keyword, by vector, by both fused by rank, or fused and then reranked, as one setting of the service chooses. See "Search and retrieval" below.

## The corpus as pinned

What the committed `knowledge/corpus/manifest.json` holds, as `knowledge/census.sh` counts it:

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

`knowledge/embed.sh`, `knowledge/index.sh` and `knowledge/gate.sh`, which work on a running stack and take its Compose project as their argument, are described under "Search and retrieval".

Each of the five corpus commands takes no arguments. Each builds the image `knowledge-corpus:checkout-<number>` from the `run` stage of `toolchain/Dockerfile`, named for the checkout like the toolchain's check image, and runs the tool in it as your user, with a read-only root filesystem and no capabilities, with only `knowledge/corpus/` and `knowledge/data/` mounted.

| Exit code | `pin.sh` | `fetch.sh` | `census.sh` | `parse.sh` and `chunk.sh` |
|---|---|---|---|---|
| 0 | Both files written | Everything fetched and verified | Every pinned label counted | Ran to the end, whatever the labels' results |
| 1 | The run failed: a request failed (after every attempt, or at once for a status that is not retried), a benchmark file or a history could not be read, or the manifest would not pass its schema; neither file was written | A label or a benchmark file was refused; the rest was fetched | Some pinned labels are missing or do not match; the rest were counted | An unexpected failure, such as a file of the data folder that is not JSON |
| 2 | Could not run | Could not run, or the committed files do not pass their schema | The same, or a benchmark file missing or not matching the pin | Could not run, or the manifest does not pass its schema |

### Pinning

- A label DailyMed does not serve, or whose archive or XML is refused (see "Safety"), is listed in the manifest as not pinned, with a reason code. That is not an error for the run.
- A benchmark record whose set id is not a GUID is listed the same way, by its `drug_id`. The labels file at the pinned revision holds 704 records: 699 with a GUID and 5 with an empty set id.
- A request that fails after every attempt fails the run. Every set id is still tried and each failure is named on standard error, but nothing is written to `knowledge/corpus/` or `knowledge/data/benchmark/`, so a passing network fault is never committed as a fact about a label.
- Pinning leaves the benchmark files in `knowledge/data/benchmark/`, but no label files.

### Fetching

- A file already present whose checksum matches is not downloaded again. A second run on complete data sends no request and changes no file, the report included. The command prints how many requests it sent.
- The XML's SHA-256 is what must match the manifest. If the zip's bytes differ but its XML matches, the label is accepted and reported as repackaged.
- A label whose XML checksum differs, whose version is no longer served, whose download fails after every attempt, or whose download is refused as unsafe is not written. The run carries on with the others, lists each such label and its reason on standard error and in the report, and exits 1.
- A file in `knowledge/data/` that does not match the manifest, or whose download record is missing, unreadable or names another XML SHA-256, is removed before its label is downloaded again, so the folder never holds a wrong label.
- A benchmark file that cannot be downloaded (`download-failed`) or does not match the pin (`benchmark-checksum-mismatch`) is refused the same way, and the run exits 1.

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
| `text-not-conserved` | error | The check below failed; the problem gives the counts of tokens missing and extra |
| `table-not-rectangular` | error | Once spans are applied, two cells claim one position, a span runs past the last row, or a row leaves an empty position before a covered one |
| `no-sections` | error | The body has no section with a title or a block |
| `unreadable` | error | The XML could not be read: the reader refused it (its reason is a code of `knowledge/src/reasons.ts`), or the file is missing (`missing`) or does not match the manifest (`checksum-mismatch`) |
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
| `id` | `<set id>/<version>/<section key>/<part>/<n>`: the section key is the section's own id when the label gives it to exactly one section and it is 1 to 128 of the characters `A-Z a-z 0-9 . : _ -`, otherwise its position in the tree (`at-1.2`); `n` counts that section's chunks of that part |
| `setId`, `version`, `effectiveTime`, `kind`, `format`, `documentTypeCode` | The label |
| `drug` | Every product name, generic name and active-ingredient name, once each, compared without case |
| `section` | The section's id, code, number, title and title path |
| `part` | `body` or `highlights` |
| `type` | `text`, `table` (a whole table) or `table-rows` (some rows of a table) |
| `position` | The chunk's ordinal in the label; for `table-rows`, the first and last row it holds (from 0, among the table's rows, header rows counted) and the table's row count |
| `text` | The content, in the plain form below |
| `repeated` | The lines of `text` repeated from elsewhere so the chunk stands alone |
| `context` | One line, `<drug names>: <title path>` (`Unnamed product` and `Untitled section` when there are none), to put in front of `text` when wanted. Not part of `text` |
| `words` | The number of words in `text` |
| `source` | The label's page at DailyMed for this version |

Text:

- A section's own blocks make its chunks; child sections make their own; a section with no blocks makes none. Highlights blocks are chunked the same way, as `part` `highlights`.
- Blocks are packed in order until the next would pass the limit. No overlap.
- A paragraph over the limit is split at sentence ends, and a sentence over the limit between words.
- A list stays together when it fits; otherwise it is split between items, inside an item only when the item alone passes the limit. A nested list stays with its item. An item is written with its caption or marker; nested items are indented by two spaces.
- A block's footnotes are written after it, each with its mark, in the same chunk.
- An image gives its descriptive text and caption. A section whose blocks are images with no text makes no chunk.
- A table that is a block of the section is never packed with text: it makes its own chunk or chunks. A table inside a list item is written, in the plain form below, into the list's `text` chunk.

Tables:

- **Plain form.** The caption on a line; each row on a line, cells separated by ` | `, an empty position as nothing, a cell covering several positions written once at its first; a cell's line breaks as ` / `; a nested table, in the same form, after its row; then the footnotes, each on a line with its mark. No Markdown table syntax.
- **Splittable** only when its header rows come from the label's `thead`, it has no nested table and no short row, and every wholly bold row below the header has exactly one filled cell (a group label).
- **A table that is not splittable is one chunk, whatever its size**, and one over the limit is counted as oversize. A splittable table within the limit is one chunk too, and so is one over the limit with fewer than two body rows (counted as oversize).
- **A splittable table over the limit** is split into `table-rows` chunks of consecutive body rows, as many as fit; a chunk of one row with the caption and header rows may pass the limit. Each holds the caption, every header row, the group label in force (carried in from above, or in its place), the rows, the footnotes its cells refer to, the footnotes a header cell refers to, and every footnote no cell refers to.
  - The first chunk holds the caption, header rows and footnotes in their place. Each later chunk repeats the caption and header rows (and any footnote already written) and lists them in `repeated`, along with a carried group label.
  - A group label is never the last row of a chunk, unless it is the table's last row.
  - A chunk never ends between two rows that a cell spans.

**The check that nothing was lost or doubled** takes its own walk of the parsed document. One side is every word in the document's blocks and Highlights blocks; titles are left out, being in `context`. The other is every word in the chunks' text, less the words of their `repeated` lines. The parser's footnote marks are removed from both, both are cut into tokens at every character that is not a letter or a digit, and the two collections with their counts must be equal. A label that fails gets no chunk file and is listed in the report as `check-failed`, with the numbers missing and extra; a label with no parsed file is listed as `no-parsed-file`. Either way a chunk file left by an earlier run is removed.

## Search and retrieval

Two services in `knowledge/compose.yaml`, started with the rest of the lab by the root `compose.yaml`, and three commands that work on a running stack:

| | What it is |
|---|---|
| `search` | OpenSearch 3.9.0, pinned by the digest of its multi-architecture index (linux/amd64, linux/arm64). One node, a 1 GB heap, its data in the named volume `search-data`. It publishes no port: only containers on the stack's network reach it. Healthy once the cluster answers and is not red |
| `knowledge` | The retrieval service, built from `knowledge/src/` with the `run` stage of `toolchain/Dockerfile`. MCP at `POST /mcp` and `GET /ping` on port 8000, published at `127.0.0.1:8002` |
| `knowledge/embed.sh <compose-project>` | Asks the embedding server for a vector of every chunk, from a container on the stack's network |
| `knowledge/index.sh <compose-project>` | Loads the chunks, and their vectors when there is an embed report, into the stack's search engine, from a container on its network |
| `knowledge/gate.sh <compose-project>` | Checks the retrieval path of a running stack whose index is built |

Start-up, from the repository root: `knowledge/fetch.sh`, `knowledge/parse.sh` and `knowledge/chunk.sh`; then `docker compose up -d --build --wait`; then `knowledge/embed.sh ai-on-aws` (it needs `model/.env` from `model/setup.sh`); then `knowledge/index.sh ai-on-aws`. The compose file's strategy, `fused_reranked`, needs the vectors: on an index loaded without them a search answers `vectors_not_built`. A stack set to `keyword` needs neither `embed.sh` nor the model servers. To search by another strategy, change `SEARCH_STRATEGY` in `knowledge/compose.yaml` and recreate the service (`docker compose up -d knowledge`).

The embedding stage and the retrieval service reach the model servers at the addresses in `model/.env` from inside the stack's network, where `127.0.0.1` is the container itself. Model servers on a loopback address of the host are reached from there only at `host.docker.internal`, the address the model setup of an Apple silicon Mac writes. NVIDIA servers published on a loopback address (`model/setup.sh` without `--bind`) are not reached: `embed.sh` exits 2 and a search answers `embedding_unreachable`. Publish them on an address the containers can reach.

### The embedding stage

`knowledge/embed.sh` reads every chunk of the last chunk run (each chunk file checked against the chunk report's hash), in chunk-id order, and asks the embedding server for a vector of each chunk's document text: its context line, a newline and its text, or the text alone when it has no context (recipe `context-newline-text/1`). Documents get no instruction. A query is embedded as `Instruct: Given a question about a medicine, retrieve passages of its label that answer the question\nQuery:<query>`; the instruction is one constant, used by the stage's report, the index and the service.

- Requests carry 32 passages. A batch the server refuses as longer than the model takes is sent again one passage at a time; a passage refused alone gets no vector and is listed by chunk id. The refusal is recognised in one place (`isOverLength` in `knowledge/src/vectors/model-client.ts`): status 400 with a message naming the model's "maximum context length". Any other 400 fails the run at once.
- A request answered 408, 429 or 5xx, or not answered, is tried again twice, after 5 and 30 seconds. One request may take 120 seconds.
- Every vector's length is checked against `EMBED_DIMENSIONS`.
- It writes `knowledge/data/vectors/<set id>/<version>.jsonl` (one line per chunk with a vector: its id, and the vector as base64 of little-endian float32, as the server returns it for `encoding_format: base64`) and `knowledge/data/embed-report.json`: the model's repository and revision (from `model/retrieval.env`) and the name it is served under, the dimensions, the recipe, the instruction, the SHA-256 of the chunk report the chunks came from, counts (chunks, vectors, without a vector), the chunk ids without a vector, total tokens, the vector files in order, and a SHA-256 over their bytes in that order.
- Before it starts it checks that the server lists the configured model name and that the chunk report exists.
- It takes the server's address and the key from `model/.env`, and the model's identity from `model/retrieval.env`, both passed to the container by `--env-file`; the script reads neither. These six settings (`MODEL_EMBED_BASE_URL`, `MODEL_API_KEY`, `EMBED_MODEL_ID`, `EMBED_MODEL_REPO`, `EMBED_MODEL_REVISION`, `EMBED_DIMENSIONS`) are the one place the tool reads its environment: the key must never be on a command line. It prints counts and chunk ids, never text, a vector or the key.

| Exit code | `embed.sh` |
|---|---|
| 0 | Every chunk has a vector, or is listed as without one because the server refused it as too long |
| 1 | A request failed after its tries, failed at once (a status that is not retried, such as a 400 that is not an over-length refusal, or an answer that cannot be read), or a vector had the wrong length. No report was written, and an old one was removed, so a report never describes vector files it did not write |
| 2 | Could not run: no such stack, `model/.env` missing, a model setting missing or malformed, no chunk report or chunk files that do not match it, a chunk with no text, set id or version, or a server that cannot be asked or does not list the model |

### Indexing

- The index is named `labels-` and 16 hex characters of a SHA-256 of the chunk report's bytes, the embed report's bytes when there is one, and the index definition below. The chunk report records the SHA-256 of each label's chunk file, and the embed report the SHA-256 of the vector files; the index command checks every file against its hash before sending anything, so a change to any chunk's or vector's bytes, or to the mapping, is a different index. A chunk report in which a chunked label has no hash is refused before anything is sent: run `knowledge/chunk.sh` again.
- With an embed report, the report must name the chunk report being loaded (by its SHA-256); otherwise it exits 1 with the reason, and nothing is built. Each document is loaded with `embedding` (its vector) and `hasVector` (true or false), and the index's `_meta` records the embedding identity: repository, revision, dimensions, recipe, instruction, and the vector files' SHA-256. Without an embed report the index is built without vectors and `_meta` records `null`.
- It reads `knowledge/data/` through a read-only mount.
- Each request to the engine may take 60 seconds (`knowledge/index.sh`).
- It creates the index with the explicit definition and loads every chunk once, in bulk requests of at most 8 MiB of body (about 380 documents with their vectors; a document larger than that is sent alone), using each chunk's id as the document id. With vectors, after the count check below, the number of documents with `hasVector: true` must equal the embed report's vector count; if not, it removes the index, leaves the alias and exits 1. If the engine reports an error for any item of a bulk request, the run fails whatever the count, and the output gives the number of items refused and the first one's error type. Otherwise it checks that the engine's count of documents equals the number of chunks read. Only then does it point the alias `labels` at the new index. On a refused item or a count that differs, it leaves the alias where it was, removes the index it made, and exits 1. On any other failure once the index may exist (the create, a bulk request refused as a whole or not answered, the refresh, the count, the alias move), it also removes the index and leaves the alias, and exits 2. If the removal fails, it says so and names the index left behind. An index the alias points at is never removed: after an alias move whose answer was lost, the alias is read again first.
- If the index for this hash already exists with the right count and the alias points at it, it changes nothing and says so. With the right count and the alias elsewhere, it only moves the alias. With the wrong count it is removed and built again, unless the alias points at it: then the run stops with exit 2 and touches nothing.
- Older indexes are left in place and listed in the output.

| Exit code | `index.sh` |
|---|---|
| 0 | The alias points at a complete index, built now or already |
| 1 | The embed report was made from other chunks: nothing was built. Or items refused: the engine refused an item of a bulk request. Or the count differed from the chunks read, or the count of documents with a vector from the embed report. The new index was removed and the alias left as it was |
| 2 | Could not run: no such stack; no chunk report; a chunk report that is not JSON or has no chunk file hashes; a chunk file that is missing, does not match its hash, or holds a line that is not JSON (the file and line are named, the line is not quoted); the chunk files disagree with the report's count; an embed report that is not one, vector files that do not match its hash, hold a vector of the wrong length, or hold another number of vectors than it counts; an index of this name with the wrong count that the alias points at; or the engine could not be asked or answered in a way that stops the run. Any index the run made was removed, or named if it could not be |

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
| `embedding` (with vectors) | `knn_vector` of the embed report's dimensions, left out of `_source` so no search returns it; `index.knn` is left off, so it is searched only exactly | By `search_label`'s vector strategies, with a `script_score` cosine search |
| `hasVector` (with vectors) | Boolean | As a filter |

The index has one shard and no replica.

### The retrieval service

Settings, each required and read by name: `SEARCH_URL` (`http://search:9200`: an http or https origin with no path), `SEARCH_INDEX` (`labels`: a lowercase index or alias name), `SEARCH_STRATEGY` (below), and `AUTH_DISCOVERY_URL`, `AUTH_ISSUER`, `AUTH_ALLOWED_AUDIENCE` (`knowledge`), `AUTH_ALLOWED_CLIENTS` (`expert,knowledge-gate,lab-explorer`, a list separated by commas: the label expert's exchanged tokens, the gate's, and the client's lab explorer's, got by client credentials for its label search), `AUTH_REQUIRED_SCOPES` (`labels:search`) and `AUTH_ROLES_CLAIM` (`roles`), in the form the case system uses. A setting missing or malformed stops the service at start with exit 2, naming it. Every request but `GET /ping` requires a valid access token, checked with `shared/access-token.ts` before anything else of the request is read: the target, then the body. The identity provider is given 5 seconds a request, and its keys are fetched again at most every 30 seconds after a token names a key not yet seen.

| Request | Answer |
|---|---|
| `GET /ping` | 200 `{"status":"Healthy"}`, with no token |
| No token, or one that is not valid | 401 `{error: "unauthorized", reason, detail}`, with `WWW-Authenticate: Bearer error="invalid_token"` |
| A valid token without the scope `labels:search` | 403 `{error: "forbidden", reason: "insufficient_scope", detail}`, with `WWW-Authenticate: Bearer error="insufficient_scope", scope="labels:search"` |
| The identity provider cannot be asked | 503 `{error: "identity_unavailable", detail}` |
| With a valid token: a target that cannot be read as a path; a body over 100,000 bytes or not JSON | 400 `{error: "bad_request", detail}` |
| A path other than `/mcp` | 404 `{error: "not_found"}` |
| `/mcp` with a method other than `POST` | 405 `{error: "method_not_allowed"}`, with `Allow: POST`: the MCP endpoint is stateless, with no stream to open and no session to end, and answers in JSON |
| A failure of the service's own | 500 `{error: "internal_error"}` |

It talks to the engine with `fetch` and its REST API, with no client library. Each request may take 5 seconds.

`SEARCH_STRATEGY`, required, says how `search_label` ranks; `knowledge/compose.yaml` sets `fused_reranked`. An unknown value stops the service at start. The model never chooses it: no tool argument names it, and an argument called `strategy` is dropped by the MCP layer. For any strategy but `keyword` these are required at start, each named when missing: `MODEL_EMBED_BASE_URL`, `EMBED_MODEL_ID`, `MODEL_API_KEY`, `EMBED_MODEL_REPO`, `EMBED_MODEL_REVISION`, `EMBED_DIMENSIONS`; and for `fused_reranked`, `MODEL_RERANK_BASE_URL` and `RERANK_MODEL_ID`. The compose file names `model/.env` and the retrieval settings file `MODEL_RETRIEVAL_ENV` names (`model/retrieval.env` when it is not set) as optional env files; with `keyword` the service reads none of their values and starts without them. The key is sent to the two model servers only and is never logged or returned.

| Strategy | How `search_label` ranks | `score` is |
|---|---|---|
| `keyword` | BM25 over the chunk's text and context line, on the alias | The BM25 score |
| `vector` | The query's vector from the embedding server; an exact `script_score` search (`lang: knn`, `source: knn_score`, `space_type: cosinesimil`) over the documents with `hasVector: true`; the best `max_results` | The cosine similarity (the engine's score is (1 + cosine) / 2) |
| `fused` | The best 50 by keyword and the best 50 by vector, combined by reciprocal rank fusion: a passage's fused score is the sum, over the lists it is in, of 1 / (60 + its rank in that list, from 1). Ties by chunk id. The best `max_results` | The fused score |
| `fused_reranked` | The best 20 fused, sent with the query to the reranker with `max_tokens_per_doc` 7000, each as the same text the embedding stage embeds (the context line, a newline, the text; the text alone when there is no context), since the keyword side searches both and the vectors are made from both; ordered by its relevance score, ties by fused rank; the best `max_results` | The reranker's score |

Every strategy searches under the same filters: the set id, and the part when given. A strategy that uses vectors first reads which index the alias points at and the embedding identity that index records, and compares it with its own configuration and constants (repository, revision, dimensions, recipe, instruction); both legs then search that one index, so a move of the alias between them cannot mix two indexes. The verdict is kept per index name. The two legs of `fused` run at once; a failure of either is the answer, never the other leg alone. Fusion is done in this service's code, not with OpenSearch's `hybrid` query: in 3.9 a `hybrid` query sent without a search pipeline returns unnormalised results with no error, and no response field gives each sub-query's rank.

Every tool result is one MCP text item holding JSON: the result, or `{error, detail}` with `isError` set. The `search_label` result carries `set_id`, `strategy` (what was run) and `passages`. Each passage carries `ranks` (`keyword`, `vector`, `fused`, `reranked`: its rank from 1 in each list that was computed and that it is in, otherwise null) and `scores` (the BM25 score, the cosine, the fused score, the reranker's score: null where not computed).

| Tool | Input | Returns |
|---|---|---|
| `find_labels` | `drug`: a name as a person would write it | The labels whose product, generic or active-ingredient name is that name, compared without case or surrounding white space; if none, the labels whose names hold every word given. At most 10, one per set id, newest effective date first (then by set id), and `more_matched` says whether more matched; `matched_by` says which rule found them: `exact_name`, `every_word`, or `none` for an empty list. For each: set id, version, effective date, kind, format, the names, and the label's page at DailyMed. No match is an empty list |
| `search_label` | `set_id`; `query`; `part` (`body` or `highlights`, or both when left out); `max_results` (1 to 10, default 5) | Passages from that one label only, best first, ranked by the service's strategy (below), and the strategy run. For each: chunk id, text, score, its ranks and scores in each list computed, part, type, the section's number, title and path, the position, and the label's set id, version, effective date, kind and page at DailyMed |

How the input is held:

- The query goes only into a full-text match, and to the embedding server and the reranker as text. The engine never reads it as a query language, so operator characters, field names and other set ids in it have no effect.
- The set id (and the part) are exact filters, set by code from the tool's arguments.
- Input outside the limits is refused before anything is sent, with `invalid_input`: an empty query or one over 1,000 characters, an empty drug name or one over 200 characters (counted after surrounding white space is removed), `max_results` that is not a whole number from 1 to 10, an unknown `part`, or a set id that is not a lowercase GUID. The tools' input schemas give only types for `part` and `max_results`, so a value outside these limits reaches the service's own check and is answered in the same `{error, detail}` shape as every other failure. An argument of the wrong type (a number for `drug`, say) is still refused by the MCP layer in its own words.

Every failure is an error result that says which; none is ever an empty list.

| Error | When |
|---|---|
| `invalid_input` | The input is outside the limits |
| `label_not_found` | No document has that set id. The error names it, so "no such label" cannot be read as "the label says nothing" |
| `index_not_built` | The alias does not exist: run `knowledge/index.sh` |
| `search_timed_out` | The engine did not answer in time, or answered that its search timed out (`timed_out: true`); or the search as a whole used its 8 seconds, and the detail names the step it was on |
| `search_unreachable` | The engine could not be reached, or closed the connection part way through its answer |
| `search_error` | The engine answered with an error status, or answered that a shard failed |
| `search_unexpected_answer` | The engine answered in a form the service does not expect: a missing field, a version that is not a whole number of 1 or more, a passage from another label, or, under a strategy that uses vectors, an alias that does not point at exactly one index (a keyword search goes to the alias as it is) |
| `vectors_not_built` | The strategy uses vectors and the index the alias points at was built without them |
| `vectors_do_not_match` | The index's vectors were made with another repository, revision, dimensions, recipe or instruction than this service makes a query's vector with |
| `embedding_unreachable`, `embedding_timed_out`, `embedding_error` | The embedding server could not be reached; did not answer within 3 seconds; answered with an error status, a refusal of the query as too long, a vector of the wrong length, or an answer it cannot read |
| `rerank_unreachable`, `rerank_timed_out`, `rerank_error` | The reranker could not be reached; did not answer within 5 seconds; answered with an error status, or an answer that does not score every passage once |

Each applies to the count a search with no passages makes as well: a failed count is its own error, never an empty list. No failure is retried, and none falls back to another strategy: the caller is told.

The numbers, and where each is set:

| Number | Value | Set in |
|---|---|---|
| Passages per embedding request; tries; waits; one request's time | 32; 3; 5 s and 30 s; 120 s | `knowledge/embed.sh` |
| Bulk request body; one indexing request's time | at most 8 MiB; 60 s | `knowledge/index.sh` |
| Query; drug name; passages returned; listed labels | 1,000 characters; 200 characters; 1 to 10, default 5; 10 | `knowledge/src/search/tools.ts` |
| Request body to the service | 100,000 bytes | `knowledge/src/search/http.ts` |
| Passages fused from each list; passages reranked; reranker tokens per passage | 50; 20; 7,000 | `FUSION_DEPTH`, `RERANK_DEPTH`, `RERANK_MAX_TOKENS_PER_DOC` in `knowledge/src/search/tools.ts` |
| Fusion constant | 60 | `RRF_CONSTANT` in `knowledge/src/search/fusion.ts` |
| One whole search (`search_label` or `find_labels`), from the moment it starts | 8 s | `SEARCH_LIMIT_MS` in `knowledge/src/search/limits.ts` |
| One engine request; embedding request; reranker request | 5 s; 3 s; 5 s, each cut to what is left of the search | `knowledge/src/search/limits.ts` |
| Model, revision, served name, dimensions | from `model/retrieval.env` | `model/retrieval.env` |

Every request a search makes (the mapping read, each engine request, the embedding request, the reranker request, the count) gets the smaller of its own limit and what is left of the search's 8 seconds, and none is sent when nothing is left. A request that runs out of time is the search's failure only if what it was given was what was left of the search (less than its own limit); otherwise it is the request's own. So a search answers inside an agent's 10 s tool limit, whatever its strategy.

### The gate

`knowledge/gate.sh <compose-project>` runs from inside the stack's network. It prints a JSON report on standard output and nothing else, and exits 0, 1 or 2 by the same rules as `platform/identity/stack-gate.sh`. Neither its report nor standard error carries a secret, a token or label text: identifiers, codes and counts only. It gets its token as its own client, `knowledge-gate`, by client credentials for the scope `labels:search`, with its secret (`IDENTITY_KNOWLEDGE_GATE_CLIENT_SECRET`) passed from `platform/identity/.env` by Compose; no person signs in. It runs the knowledge image named for this checkout (`knowledge-corpus:checkout-<number>`), in a compose project also named for it, and prints the image on standard error. Its statements:

1. The service answers 401 with reason `missing` to no token, and 200 on `/ping`.
2. The alias `labels` exists, points at exactly one index, and holds exactly as many documents as the chunk report counts.
3. For the first label in the manifest whose chunks carry a drug name, `find_labels` on that label's name shared by the fewest labels returns its set id among the labels. The same name in other case, with spaces around it, returns the same label by exact match. The words of a multi-word name, reordered and matching no name exactly, return its label by the every-word fallback; that name is the first in manifest order whose words match at most 10 labels. A name no label has gives an empty list.
4. `search_label` on that label, with a word of six letters or more from one of its chunks, returns at least one passage. Every passage carries that set id and every field listed above, and the scores do not increase down the list.
5. A query made only of query-language characters, and one naming another field and another set id, each return only passages from the one label, or none, and no error.
6. A GUID not in the index returns `label_not_found`.
7. `max_results` 1 returns one passage, 10 at most ten, and 11 is refused by the service's own check, as `invalid_input`.
8. 200 benchmark searches, each restricted to the question's own label, answer without an error. When one does not, the statement lists each error code with its count and the first search it happened on, by its position among the 200, never by its text.

Statement 4 also states that the service names its strategy, and the report gives that strategy, beside the measure below. When the strategy uses vectors:

9. Every passage returned in step 4 and the benchmark searches carries the ranks its strategy computes. The embedding identity the index records equals the model, revision and dimensions in `model/retrieval.env` (passed to the gate) and this code's recipe and instruction. The gate cannot see the service's settings: this states that the index matches the committed configuration, and the service itself refuses a search when the index does not match its own.

A call to the service that gets no answer (the service stopped, the token refused, the network) stops the gate with exit 2: it is never read as a refusal or as an empty answer. A data file that is missing or not JSON stops it too, naming the file and the line without quoting it. Each of its own HTTP requests (sign-in, the alias, the count, the mapping) may take 20 seconds.

It also measures, and does not assert, how often a passage from a referenced section is among the first five results. The 200 questions are those whose label is indexed and whose `references` is a non-empty list of strings, sorted by `qid` and taken evenly; a question over 1,000 characters is cut to its first 1,000. The rule that matches a passage's section to a reference is `knowledge/src/references.ts`, which the evaluation harness uses too. A hit is a passage among the first five whose section number equals the number a reference starts with, or whose title equals a reference, ignoring case and spacing. The report (`passed`, `held`, `failed`, `strategy`, `measures`) also gives the median and 95th-percentile time of its `search_label` calls.

### Hardening

The retrieval service runs with a read-only root, no capabilities, no new privileges and an init process, like the case system. The search engine runs with no capabilities, no new privileges and an init process, with `/tmp` and its log folder on tmpfs. It cannot have a read-only root: at every start OpenSearch writes `config/opensearch.keystore` into its configuration folder, whose other files must come from the image. A tmpfs over that folder would hide them, and with every other writable folder on a tmpfs a read-only root still stops it at start (exit 70).

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
    ├── fetch-report.json       counts, the benchmark files and the labels in each state: verified, repackaged,
    │                           refused (with a reason)
    ├── census.json
    ├── parsed/<set id>/
    │   └── <version>.json      the parsed document, and its warnings; only for a label without an error
    ├── parse-report.json       counts by error, kind and format; warnings with counts and labels touched;
                                tables by header and caption source, with counts that bear on header rows;
                                untitled sections by code; unknown elements; one entry per label
    ├── chunks/<set id>/
    │   └── <version>.jsonl     one chunk per line, in document order; only for a label that passes the check
    ├── chunk-report.json       the settings; labels chunked and not (check-failed, no-parsed-file); chunks by type and part; size distributions; tables by
    │                           outcome and by the condition that makes them not splittable; splits; the ten
    │                           largest chunks by id; one entry per label, with its chunk file's SHA-256
    ├── vectors/<set id>/
    │   └── <version>.jsonl     one line per chunk with a vector, in chunk-id order: the id and the vector
    └── embed-report.json       the embedding identity, the chunk report it came from, counts, chunks without a
                                vector, tokens, the vector files and their SHA-256
```

A manifest entry holds: set id, version, document id, effective time, published date, document type code, the SHA-256 of the zip as downloaded and of the XML inside it, and the XML's size in bytes. Entries are sorted by set id, so the same inputs give a byte-identical file.

## Requests

- At most 2 requests to DailyMed at once, and 1 to GitHub, from 2 workers. The tool refuses a DailyMed setting above 4; `lib.sh` sets 2.
- A request with no response, a body cut short or not read in time, or a status of 408, 429 or 5xx, is tried 3 times in all, waiting 10 and then 60 seconds. A 404, or any other status, is not tried again. Redirects are followed. One attempt may take 120 seconds.
- A benchmark file may be at most 256 MiB (268,435,456 bytes).
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

`knowledge/test/` holds one test per invariant of ["Always true"](../docs/architecture/knowledge.md#always-true), named `knowledge 2.` to `knowledge 39.` by its number, and one probe that the index command reads its flags and builds an index, run by `toolchain/check.sh` with everything else. Invariants 1, 31 and 41 have no test, being set by the repository's own configuration and scripts, and 40, the gate's, has none either: the gate is not tested here. DailyMed, the benchmark's host, the search engine and the model servers are stand-ins in memory, passed to the code as values (`knowledge/test/support.ts`). The search engine's stand-in interprets no query, so a test that relies on a query asserts the request that was sent. The retrieval service runs on loopback, with its token check as a function. The labels are synthetic; no real label text is in them.

## Not present

- **The search engine's security plugin is off.** It has no TLS, no sign-in and no access control: any container on the stack's network can read, change or delete every index. It publishes no port, so nothing outside that network reaches it. The retrieval service is the only path an agent is given, and it holds the token check. The client's lab explorer reads the alias `labels`, its count and its mapping from the engine directly, with GET only, and searches through the retrieval service. Do not publish the engine's port.
- No Bedrock data source.
- No record of which passages the reranker read only in part: a passage over 7,000 tokens is cut by the reranker, and nothing says which.
- One passage of the corpus is over the embedding model's 8,192 tokens: it has no vector, and is found by keyword only.
- Vectors are not bit-for-bit repeatable across runs of the stage on a GPU. That is why the index is named from the vectors it holds (the embed report's hash), not from the chunks alone.
- No check of the reranker's repository or revision: the service names the reranker only by its served name (`RERANK_MODEL_ID`).
- No approximate (HNSW) vector search: each search is exact, over the documents of one label.
- Fusion is done in this service's code, not with OpenSearch's `hybrid` query: in 3.9 a `hybrid` query sent without a search pipeline returns unnormalised results with no error, and no response field gives each sub-query's rank.
- No removal of old indexes; `index.sh` lists them.
- No backup of the index: it is rebuilt from the chunks with `index.sh`.
- No limit on the size of a table that is not splittable: such a table is one chunk, however long. A split chunk of one row has no limit either.
- No chunk that holds text and a table that is a block of its own; a table inside a list item is part of the list's text.
- No decision on which rows of a table are really column headings: the parser infers header rows by one fixed rule and records, for every row, whether it is wholly bold and how many cells have text. Telling a column heading from a group label is left to the step that splits tables.
- No text from images: an image is kept as its object id, descriptive text and caption.
- No section numbers in old-format labels, whose numbering stays in the title.

## Terms

- **Labels come from DailyMed, a service of the National Library of Medicine (NLM).** This piece is not endorsed by NLM. As NLM asks: the data from DailyMed may not be current; check DailyMed for the latest version of a label.
- **Labels are not redistributed here.** No source states that label text written by a manufacturer is in the public domain, so this repository holds only the manifest and the commands that fetch the labels. Run `knowledge/fetch.sh` to get them.
- **FDARxBench** is by its authors, under the Apache License 2.0. Its files are downloaded at a pinned revision and are not copied into this repository.
