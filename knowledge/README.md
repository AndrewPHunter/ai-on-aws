# Knowledge

A local stand-in for Amazon Bedrock Knowledge Bases: taking documents in, storing them for search, and answering retrieval requests from agents.

The documents are US drug labels from DailyMed. What exists so far gets them onto disk, reproducibly, and counts what they are: the labels of the public benchmark [FDARxBench](https://github.com/xiongbetty/FDARxBench), each pinned at one version of its DailyMed label. Which ones are pinned, and why the others are not, is in `knowledge/corpus/manifest.json`. Nothing parses, splits or searches them yet.

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

## The three commands

| Command | What it does | Network | Writes |
|---|---|---|---|
| `knowledge/pin.sh` | Run once. Downloads the benchmark's two files at a fixed revision and records their checksums. For each set id in the labels file, asks DailyMed for the label's history, takes the highest version, downloads it, reads it safely, and records it | DailyMed and GitHub | `knowledge/corpus/benchmark.json` and `knowledge/corpus/manifest.json`, which are committed; the benchmark files in `knowledge/data/benchmark/` |
| `knowledge/fetch.sh` | Reads only the two committed files. Downloads the benchmark files and every label version the manifest names, and checks each against its checksum | DailyMed and GitHub | `knowledge/data/` |
| `knowledge/census.sh` | Counts what the fetched labels are, and how much of the benchmark's text appears word for word in them. Counts and codes only, never label text | None | `knowledge/data/census.json`, and a summary on standard output |

Each takes no arguments. Each builds the image `knowledge-corpus:checkout-<number>` from the `run` stage of `toolchain/Dockerfile`, named for the checkout like the toolchain's check image, and runs the tool in it as your user, with a read-only root filesystem and no capabilities, with only `knowledge/corpus/` and `knowledge/data/` mounted.

| Exit code | `pin.sh` | `fetch.sh` | `census.sh` |
|---|---|---|---|
| 0 | Both files written | Everything fetched and verified | Every pinned label counted |
| 1 | A request failed after every attempt; neither file was written | Something was refused; the rest was fetched | Some pinned labels are missing or do not match; the rest were counted |
| 2 | Could not run | Could not run, or the committed files do not pass their schema | The same |

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
    └── census.json
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

`knowledge/test/` holds tests F1 to F13, run by `toolchain/check.sh` with everything else. They use a labelled stand-in for DailyMed and for the benchmark's host, on loopback, serving synthetic labels and zips built in the tests. No real label text is in them.

## Terms

- **Labels come from DailyMed, a service of the National Library of Medicine (NLM).** This piece is not endorsed by NLM. As NLM asks: the data from DailyMed may not be current; check DailyMed for the latest version of a label.
- **Labels are not redistributed here.** No source states that label text written by a manufacturer is in the public domain, so this repository holds only the manifest and the commands that fetch the labels. Run `knowledge/fetch.sh` to get them.
- **FDARxBench** is by its authors, under the Apache License 2.0. Its files are downloaded at a pinned revision and are not copied into this repository.
