# Retrieval over drug labels: research and recommendation

Research dated 2026-11-21, before anything was built. **Nothing in this document was measured in this repository.** It gathers what primary sources say, sets a locally built design beside Amazon Bedrock Knowledge Bases stage by stage, and recommends what to build and what to measure.

Every claim carries one of these labels:

| Label | Meaning |
|---|---|
| measured | Measured by others, on data that is named |
| vendor | Measured by the vendor of the thing measured |
| documented | Stated in the owner's documentation |
| observed | Seen by a research agent in live data, with the sample size given |
| inference | Deduced, not stated by a source |
| to measure | Unknown until measured here |

The question: a system answers clinicians' questions strictly from approved US prescription drug labels, cites the label, version and section for every statement, and says so when the label does not answer. How should it get the labels, turn them into searchable text, and retrieve from them?

## Recommendation in brief

1. **Take labels from DailyMed as SPL XML, pinned by set id and version.** It is the only source that keeps section structure and returns a named past version.
2. **Write our own SPL parser in TypeScript.** No maintained Node parser exists. It needs a check that no text was dropped, because no source describes one.
3. **Split on the label's own structure:** one chunk per leaf subsection, split further at paragraph boundaries above about 400 tokens, no overlap, with the drug and title path in front of each chunk.
4. **Treat tables as the main safety risk.** Rebuild each table's grid, infer its header rows, and index one chunk per row with the headers repeated, keeping the whole table to hand to the model.
5. **Resolve the drug first and filter to its label, then search with keywords and vectors together,** and rerank.
6. **Do not rely on a score threshold to refuse.** Check that the retrieved text supports the answer, and check numbers against the cited text in code.
7. **Measure everything on FDARxBench plus a small set of our own,** with a split held back.
8. **On AWS, use the Managed Knowledge Base fed with our own chunks.** It is the kind AWS recommends and the only kind that attaches to AgentCore Gateway.

## Stage by stage: local, Managed, customer-managed

"Managed" is the Bedrock Managed Knowledge Base, generally available since 2026-06-17. "Customer-managed" is the older kind, where you provide the vector store. All Bedrock cells are documented unless marked.

| Stage | Built locally | Bedrock Managed | Bedrock customer-managed |
|---|---|---|---|
| Input format | SPL XML read directly | XML is not a supported format. Text, Markdown, HTML, PDF, Office files; 50 MB a file | The same formats |
| Parsing | Our parser, section codes and tables kept | `SMART_PARSING` or multimodal only | Default (text only), foundation model, or Bedrock Data Automation |
| Chunking | Any. Recommended: by section, then paragraph | Default (about 300 tokens, 20% overlap), fixed, or none. No hierarchical, no semantic, no custom step | Default, fixed, hierarchical (exactly 2 levels), semantic, none, or a Lambda function |
| Our own chunks | Native | One chunk per file with chunking set to none (inference from two pages) | The same, or a Lambda function |
| Metadata | Any shape | Sidecar file, 10 KB. No prefix or substring filters | Sidecar file, 10 KB. Filters: up to 5 in a group, one level of nesting |
| Embedding model | Any | Built in, or one of five at 1,024 dimensions | Titan Text v1 or v2, Cohere Embed v3 |
| Store | OpenSearch or PostgreSQL | None to choose. The index cannot be inspected | OpenSearch Serverless or cluster, Aurora PostgreSQL, S3 Vectors, Neptune Analytics, Pinecone, Redis, MongoDB Atlas |
| Search type | Keyword, vector or both, chosen by us | Hybrid, chosen by the service | Hybrid or vector, chosen per query. Hybrid only on OpenSearch Serverless, Aurora and MongoDB |
| Reranking | Any model | Built in. Not available with a custom embedding model | Amazon Rerank 1.0 or Cohere Rerank 3.5. Only Cohere is offered in `us-east-1` |
| What a result returns | Whatever we store | Text, score, source location, metadata, document id. No section field | The same |
| Changing the chunking | Re-run the pipeline | Not after the data source is created | Not after the data source is created |
| Attaches to AgentCore Gateway | Through our own tool | Yes, as two MCP tools | No. The agent calls `Retrieve` itself (inference) |
| Grounding check | Ours | Guardrails contextual grounding | The same |
| Evaluation | Ours | RAG evaluation jobs. Whether a Managed base can be a target is unconfirmed | RAG evaluation jobs, which also accept passages and answers from an outside system |

What follows from the table:

- **The labels must be converted before Bedrock sees them, in either kind.** The conversion is the pipeline in this document.
- **Our section-aware splitting survives on Bedrock only if we hand it finished chunks.** The Managed kind has no structure-aware option of its own.
- **Citations to a label section depend on metadata we attach,** since a result carries no section field.

## The data

| Source | What it holds | Past versions | Structure kept | Use it for |
|---|---|---|---|---|
| DailyMed (National Library of Medicine) | SPL XML as submitted by companies: prescription, OTC and more | Yes, by set id and version | Full: nested sections, tables, images | The corpus |
| openFDA label API (FDA) | The same labels converted to JSON, weekly | No. Current version only | Flattened: subsections folded into one string, Highlights mixed in, no section ids | Finding set ids by drug name |
| Drugs@FDA (FDA) | The last FDA-approved label, for brand products, as documents | Approval history | Not structured data | Stating what was last approved |

All rows are documented, except openFDA's flattening, which was observed in its converter's source and in live records.

- **A label is identified by its set id, which never changes, and a version number that only rises** (documented, FDA SPL Implementation Guide). A past version is fetched with `getFile.cfm?type=zip&setid=…&version=…` (documented; observed working for versions 1, 3, 5 and 6 of two labels).
- **Which label is "approved".** DailyMed says its labelling "may not be verified by FDA", and no source names a single system of record. Here, the label of record is the DailyMed SPL at the pinned version. A pharmaceutical company would use its own regulatory system of record in its place.
- **One drug has many labels.** openFDA returned 265 prescription labels for atorvastatin and 398 for metformin (observed). The corpus needs a rule; see "Decisions".
- **Licence.** openFDA data is CC0. The National Library of Medicine asks for credit and a notice that data may not be current. No primary source states that label text written by a manufacturer is in the public domain, so the repository should hold a manifest and a fetch script, not the label files.
- **Reproducibility.** The manifest pins set id, version, the document id inside the file, and a SHA-256 we compute. DailyMed publishes checksums for its bulk files only, as MD5.

## The pipeline

| Stage | What it does | What it must guarantee |
|---|---|---|
| Fetch | Downloads each pinned version | The checksum matches the manifest, or the run stops |
| Parse | Reads SPL XML into a tree of sections, each with its code, title, number and blocks | Every text node of the label body is in the tree exactly once |
| Tables | Rebuilds each grid, expands merged cells, finds header rows, attaches footnotes | A cell keeps its row and column headings |
| Chunk | Emits chunks with their citation record | A chunk belongs to exactly one section |
| Emit | Writes the local index, and one file per chunk with a metadata sidecar for Bedrock | Both come from the same chunks |

Each stage is keyed on the label's set id and version and on the parser's revision, so a re-run changes nothing unless one of those changed.

**The citation record** kept with every chunk: set id, version, effective date, drug names, section code, section number, title path, the section's own id from the XML, and the chunk's position. DailyMed's page for a label version is addressed by `drugInfo.cfm?setid=…&version=…` (observed, not documented).

**What real labels do, each needing a test** (observed in three labels unless marked):

| Irregularity | Consequence if ignored |
|---|---|
| Highlights text sits inside the full section as an excerpt (documented) | The summary is indexed twice and cited as if it were the full text |
| Sections carry the wrong code, or the "unclassified" code | Filtering by section code drops content |
| Subsections have no title | Chunks have no title path |
| Tables have no header row; the caption is a merged cell; header cells are bold body cells | Rows lose their column meaning |
| One label had 35 column spans and 40 row spans | Cells are misaligned |
| Footnotes are in three different places | A qualifier is separated from its number |
| Non-breaking spaces are used to indent | Hierarchy inside a table is lost |
| Text exists only inside an image (documented) | It cannot be retrieved. It must be flagged, not skipped silently |
| Old-format labels number subsections "1.", "2." | They are mistaken for the new format's section numbers |
| One label covers several products | A strength is attributed to the wrong product |

About 57% of prescription labels appear to be in the newer format (derived from an openFDA field, unofficial). Both formats must parse.

## Chunking

| Choice | Recommendation | Evidence |
|---|---|---|
| Unit | The leaf subsection, split at paragraph and list boundaries above about 400 tokens | measured: structure-based chunks gave 53.2% answer accuracy against 48.2% for fixed 512-token chunks on financial filings (141 questions, vendor authors). measured: 400-token chunks with no overlap recalled 89.5% against 85.4% for 800 tokens with overlap (472 queries, general corpora) |
| Overlap | None | measured: no clear advantage in two studies |
| Context in the chunk | Drug name and title path in front of the text | measured: a title prefix scored 67.4% page accuracy against 46.1% without, though the variants differed in other ways too. vendor: generated context cut retrieval failures from 5.7% to 3.7% |
| Tables | One chunk per row with headers repeated. The whole table is kept for the model | measured: row chunks with repeated headers beat table chunks, on telecom specifications, reported in charts only. No source tested drug labels |
| Returning the surrounding subsection with a matched chunk | Try it | No measured evidence found. Bedrock's hierarchical chunking does this |
| Semantic chunking | Not used | measured: "not justified by consistent performance gains" on real documents. Not offered by the Managed kind |
| Late chunking, proposition chunks | Not used at first | measured: small or inconsistent gains; one biomedical study found late chunking below plain chunking |

## Retrieval

1. **Resolve the drug, then filter.** A question names a drug. Matching it to a label by name, and searching only that label, removes near-identical text from other drugs. Within one label there are a few hundred chunks, so vector search is exact and the known problem of filters applied after an approximate index does not arise (inference).
2. **Search with keywords and vectors together.**
   - measured: on 700 FDA labels, BM25 put the right passage first 56% of the time against 42% for a vector baseline. The paper's vector model was not identified in the part read, so this shows keyword search is strong here, not that vectors are weak.
   - measured (abstract only): vector search does badly on rare-entity questions.
   - vendor: fusing both gave 18% better ranking than BM25 alone on a general benchmark.
3. **Fusion.** Start with rank fusion, which needs no tuning. vendor: OpenSearch's own tests put it 3.9% behind score-based fusion, and Elastic found a tuned combination better still given about 40 labelled queries. Compare both once a labelled set exists.
4. **Rerank the top results, and measure refusals separately.** vendor: reranking cut retrieval failures from 2.9% to 1.9%. measured: in another study, adding reranking and query rewriting lowered correct refusals for all 12 models tested.
5. **Models: a shortlist to measure, not a pick.**

| Role | Local candidates | Bedrock counterpart |
|---|---|---|
| Embedding | Qwen3-Embedding-0.6B (1,024 dimensions, Apache-2.0); BGE-M3 (1,024 dimensions, MIT, 8,192 tokens); EmbeddingGemma-300m (768 dimensions) | Titan Text Embeddings V2 (1,024 dimensions) |
| Reranking | bge-reranker-v2-m3; Qwen3-Reranker-0.6B | Cohere Rerank 3.5 |

The model server's tiers keep 2,048 MiB of the GPU back for other models (this repository's `model/README.md`). Models of the 0.6B class fit beside the chat model; the 4B and 8B embedders do not. Current leaderboard standings and reranker latency could not be confirmed from a primary source and are to measure.

## Not answering

- measured: with the whole label in the prompt, accuracy was about 0.53 against about 0.80 with the right passages. Retrieval matters even when the label would fit.
- measured: frontier models refused almost every unanswerable label question but also refused answerable ones.
- No source supports a single score threshold as a reliable signal.

Recommended, in order:

1. No label for the named drug: refuse, and say which drugs are covered.
2. After retrieval, the model must quote the passage that supports each statement, or say the label does not answer.
3. In code: every number and unit in the answer must appear in the passage it cites. This is cheap, and dosing is where an error does the most harm.
4. On AWS, Bedrock Guardrails' contextual grounding check is the managed counterpart of step 2.

## Evaluation

- **FDARxBench** (2026-03, Apache-2.0, public): 17,223 expert-curated questions over 700 labels: 9,888 answerable from one section, 3,400 from two, 3,935 unanswerable. Each question carries the label's set id and the passages that answer it.
- **Three limits of it, observed in its files:**
  - It records no label version, so its passages must be matched to our pinned labels by their text, and questions whose passage no longer appears are dropped and counted.
  - Its questions come from generic-drug assessors, not clinicians.
  - Its labels include generics.
- **A set of our own,** about 40 questions in a clinician's words, including table lookups and questions the label cannot answer.
- **Metrics:** whether the right passage is in the top results, its rank, citation precision and recall, refusal precision and recall, and answer correctness.
- **Size:** the unit that sets the margin is the question, not the label. About 250 questions gives a margin of roughly 6 points either way on a proportion, 1,000 gives 3, and the full 17,223 gives about 1 (derived). Comparing two strategies on the same questions needs fewer.
- **Discipline:** tune on one split and report once on another.

Comparisons worth running, each a result for a later write-up: keyword against vector against both; with and without reranking; with and without the title path; row chunks against table chunks; with and without the surrounding subsection.

## To check on AWS

The design depends on these, and each is an inference or is contradicted between AWS pages:

1. One chunk per file with a sidecar, with chunking set to none, on the Managed kind.
2. What `SMART_PARSING` does to text we have already split.
3. Whether a matched row chunk is replaced by its whole table. AWS documents this for content with tables of 10,000 characters or fewer.
4. Whether citations and evaluation jobs work on a Managed base.
5. How many filters a Managed base accepts. One page says 5 in a group; AWS's skill file says more than 10 are rejected.

## Risks

| Risk | Why it matters |
|---|---|
| The parser is the largest piece of work | Nothing maintained exists to build on in Node |
| Tables | The irregularities above were found in three labels. More kinds will exist |
| FDARxBench passages may not match current label versions | The usable question set could be smaller than it looks |
| Local and Bedrock embeddings differ | Local and AWS results will not be identical, and should not be presented as such |

## Decisions

1. **Search engine: OpenSearch, or PostgreSQL with pgvector.** Recommended: OpenSearch. It has true BM25, which the evidence favours for drug names and doses, a built-in hybrid query with both kinds of fusion, and filtering during vector search. It is the same engine as the Bedrock store with the widest support. Its cost is weight: a Java server locally, and capacity charges on AWS. PostgreSQL is lighter, but its full-text ranking is not BM25, and its vector index filters after scanning unless configured otherwise.
2. **Bedrock kind for the AWS pass: Managed, or customer-managed.** Recommended: Managed. AWS recommends it, it is the only kind that attaches to AgentCore Gateway, it is available in `us-east-1`, and it has no store to run. We give up the choice of search type and the ability to inspect the index. The customer-managed kind on OpenSearch Serverless would mirror the local design more closely, at a higher running cost.
3. **Corpus: which labels.** Recommended: all 700 labels in FDARxBench, each pinned at its DailyMed version on the day of fetch, plus the drugs in this lab's scenario if they are not among them.
   - The pipeline is automated, so the number of labels costs machine time, not effort: about 180 MB to download and roughly 200,000 chunks to embed (derived from one label's size and a few hundred chunks a label).
   - The parser is the part most likely to be wrong, and three labels already showed ten kinds of irregularity. Seven hundred labels show what it really has to handle. A label that fails a validation is left out and listed, never included quietly.
   - Retrieval measures need no model, so all 17,223 questions can be scored, which puts the margin on a proportion near 1 point (derived).
   - Answer quality needs the model to write and a judge to grade every answer. At several seconds each on the local model that is about a day for the full set, so it runs on a sample drawn evenly across the three question types.
   - On AWS, start with about 100 labels. One chunk per file means two objects in S3 for every chunk, and how long Bedrock takes to ingest that many small files is to measure.

## Sources

Label data and format:

- FDA, SPL Implementation Guide with Validation Procedures: https://www.fda.gov/media/84201/download
- FDA, LOINC codes for prescription drug labeling: https://www.fda.gov/media/114007/download
- DailyMed web services: https://dailymed.nlm.nih.gov/dailymed/app-support-web-services.cfm
- DailyMed, about: https://dailymed.nlm.nih.gov/dailymed/about-dailymed.cfm
- DailyMed bulk files: https://dailymed.nlm.nih.gov/dailymed/spl-resources-all-drug-labels.cfm
- openFDA drug label API: https://open.fda.gov/apis/drug/label/
- openFDA licence: https://open.fda.gov/license/
- openFDA SPL converter source: https://github.com/FDA/openfda
- National Library of Medicine terms: https://www.nlm.nih.gov/databases/download/terms_and_conditions.html

Chunking, retrieval and evaluation:

- FDARxBench (2026-03): https://arxiv.org/abs/2603.19539 and https://github.com/xiongbetty/FDARxBench
- Chroma, Evaluating Chunking (2024-07): https://www.trychroma.com/research/evaluating-chunking
- Unstructured, element-based chunking on FinanceBench (2024-03): https://arxiv.org/abs/2402.05131
- Qu et al., Is Semantic Chunking Worth the Computational Cost? (2024-10): https://arxiv.org/abs/2410.13070
- Jina, Late Chunking (2024-09): https://arxiv.org/abs/2409.04701
- Anthropic, Contextual Retrieval (2024-09): https://www.anthropic.com/news/contextual-retrieval
- Table chunking for retrieval (2024-08): https://arxiv.org/abs/2408.17008
- Elastic, hybrid retrieval (2023-07): https://www.elastic.co/search-labs/blog/improving-information-retrieval-elastic-stack-hybrid
- OpenSearch, reciprocal rank fusion: https://docs.opensearch.org/latest/vector-search/ai-search/hybrid-search/rrf/
- EntityQuestions (2021): https://arxiv.org/abs/2109.08535
- DeclineCraft (2026-10): https://arxiv.org/abs/2610.28340
- Sufficient Context (2024-11): https://arxiv.org/abs/2411.06037
- Qwen3 Embedding (2025-06): https://arxiv.org/abs/2506.05176
- BGE-M3: https://huggingface.co/BAAI/bge-m3
- pgvector, filtering: https://github.com/pgvector/pgvector

Amazon Bedrock Knowledge Bases:

- Managed Knowledge Base: https://docs.aws.amazon.com/bedrock/latest/userguide/kb-build-managed.html
- Managed ingestion options: https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-customize-ingestion.html
- Managed Regions: https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-regions.html
- Chunking: https://docs.aws.amazon.com/bedrock/latest/userguide/kb-chunking.html
- Supported formats: https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-ds.html
- Metadata sidecar files: https://docs.aws.amazon.com/bedrock/latest/userguide/s3-data-source-connector.html
- Query configuration and filters: https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-config.html
- Vector stores: https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-setup.html
- Reranking models and Regions: https://docs.aws.amazon.com/bedrock/latest/userguide/rerank-supported.html
- Gateway target: https://docs.aws.amazon.com/bedrock/latest/userguide/kb-gateway-target.html
- Contextual grounding check: https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-contextual-grounding-check.html
- Evaluation: https://docs.aws.amazon.com/bedrock/latest/userguide/evaluation-kb.html
