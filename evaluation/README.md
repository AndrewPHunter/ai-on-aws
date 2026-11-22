# Evaluation

The harness that measures the label expert: it sends a fixed sample of the benchmark's questions (FDARxBench) to the agent through the agent contract, as a client does, stores every response, scores in code what code can score, and has a judge model grade answer correctness. Two runs of the same sample, under two search strategies, are compared question by question. The design, the exact definition of every measure and what is not measured are in [docs/architecture/evaluation.md](../docs/architecture/evaluation.md).

Every command is run from the root of the repository. Each but `judge.sh`'s call to the judge runs its TypeScript in the piece's image, built from the `run` stage of `toolchain/Dockerfile` (the pinned Node image) and named for the checkout, with a read-only root, no capabilities and your user's ids.

## The commands

| Command | What it does | Needs |
|---|---|---|
| `evaluation/sample.sh [--record]` | Draws the sample: only questions whose label is in `knowledge/corpus/manifest.json`, stratified by question type with the counts in `evaluation/sample.json`, each stratum chosen by a seeded shuffle of its sorted qids. Writes `evaluation/data/sample.jsonl`, and fails if the draw differs from the qids committed in `evaluation/sample.json`. `--record` writes the qids and the hashes of the benchmark file and the manifest into `evaluation/sample.json` instead, to be committed | `knowledge/fetch.sh` run first (the benchmark file) |
| `evaluation/run.sh <compose-project> <run-name> [--retry-failed]` | Sends each sampled question to the label expert of a running stack (`http://expert:8080`, on the stack's network) with a real access token, signed in as `dana.desk` as the gates do, at most 4 at once. Stores each response whole, with its status, duration and time | The stack running, its index built, `platform/identity/.env` |
| `evaluation/score.sh <run-name>` | Scores the run and prints the table; writes `scores.json` | `knowledge/chunk.sh` run (the chunks give each cited passage's section) |
| `evaluation/compare.sh <run-a> <run-b>` | For each yes-or-no measure: both right, only A, only B, neither, and the exact two-sided sign test. Writes `compare-<run-a>.json` beside run B | Both runs scored, on the same sample |
| `evaluation/judge.sh <run-name> [--retry-failed]` | Has the judge grade each answerable question the agent answered: correct, partly correct or incorrect, with one sentence of reason. Writes `judgments.jsonl` and `judge.json` | The operator's machine (below) |
| `evaluation/judge.sh <run-name> --check <n>` | Writes `judge-check.csv`: `n` judged items drawn by seed, each with the question, the reference, the reply and an empty `person_verdict` column. Once a person has filled it in, `score.sh` reports how often the judge and the person agree | A judged run |

A run is started again with the same command: a question already answered is not sent again, and one whose call failed is sent again only with `--retry-failed`. The same holds for `judge.sh`. If the responses of one run report more than one search strategy, `run.sh` stops: change the service's `SEARCH_STRATEGY` only between runs, and give each strategy its own run name.

A typical comparison: `evaluation/sample.sh`; with the service on `keyword`, `evaluation/run.sh ai-on-aws keyword-1`; restart it on `fused_reranked`, `evaluation/run.sh ai-on-aws reranked-1`; `evaluation/score.sh` on each; `evaluation/compare.sh keyword-1 reranked-1`.

| Exit code | `sample.sh` | `run.sh` | `score.sh`, `compare.sh` | `judge.sh` |
|---|---|---|---|---|
| 0 | The sample is written | Every question has a response | Done | Every question is judged (or, with `--check`, the file is written) |
| 1 | | Some calls failed, each recorded with its reason | | Some judge calls failed, each recorded |
| 2 | Could not run, or the draw differs from the committed list | Could not run, or the responses reported more than one strategy | Could not run (a run not found or not scored; different samples) | Could not run |

No command prints a question, an answer, a reply or a judge's reason: output is counts, codes, identifiers and file names.

## The judge, on the operator's machine

The judge is a model reached through the Codex command-line tool with the operator's own login, so `judge.sh` runs on the operator's machine, not in a container. It needs:

- a POSIX shell, `xargs`, `sleep` and `kill`;
- Docker, for the two steps that run in the pinned image (writing the requests, and reading the verdicts back);
- the `codex` command on `PATH`, signed in. `evaluation/judge/codex.sh` runs `codex exec` with the model `gpt-6-astra` and reasoning effort `high` (the adapter's settings, at its top), read-only, in an empty folder, with no git repository, no user configuration, no rules, no session kept, and `evaluation/judge/verdict.schema.json` as the output schema.

Node is not needed on the machine. Each judge call is given 300 seconds; at most 4 run at once.

The judge sits behind one boundary: a command that reads one JSON request on standard input (`instructions`, `question`, `reference`, `reply`) and writes one JSON verdict on standard output (`verdict`, `reason`), and answers `--describe` with its name, model and effort. Another judge is another adapter script with the same contract; set `ADAPTER` in `judge.sh`. The judge is given the question, the benchmark's answer and the agent's reply with its citation markers removed, and nothing else: no passage, no citation, no identifier. A call that fails, runs out of time, or answers outside the schema is recorded as a failure and counted; nothing is guessed.

The judge is optional: without judgments `score.sh` prints "correctness: not judged".

## Where the data lives

```
evaluation/
├── sample.json                   committed: the seed, the strata, the hashes of the files the list was drawn from,
│                                 and the list of qids (identifiers only)
└── data/                         never committed (.gitignore), never in an image (.dockerignore): it holds text
    ├── sample.jsonl              the sampled questions, with their answers and references
    └── runs/<run-name>/
        ├── responses.jsonl       one line per call: qid, time, duration, status, whether it kept to the contract,
        │                         the reason it failed, and the response whole
        ├── run.json              the sample's hash, the agent's id, the models and strategies the responses named,
        │                         start and end
        ├── scores.json           every measure, and each question's yes-or-no results (identifiers only)
        ├── compare-<run>.json    the comparison with another run (beside run B)
        ├── judgments.jsonl       one line per judged question: the verdict and its reason, or the failure
        ├── judge.json            the judge, its model and effort, and the SHA-256 of the instructions it was given
        └── judge-check.csv       items for a person to grade, with the question, the reference and the reply
```

## Reading the table

Every share is printed as `numerator of denominator = share [low, high]`: the interval is the 95% Wilson score interval. A share over fewer than 20 items is marked "too few to read". Two runs differ on a measure only as far as `compare.sh`'s sign test says: the two middle counts (only A right, only B right) are what it weighs; questions both got right or both got wrong say nothing about which run is better. With 250 questions, a difference of a few points on a share is within the interval.

## Measured by the planner, 2026-11-22

Two runs of the 250 sampled questions on a trial stack from this repository, with the real chat model (qwen3.5-9b), the real embedding model and reranker, and the 640-label index with vectors: `keyword`, then `fused_reranked` (the retrieval service restarted on the setting in between). Each sent 250 questions and got 250 responses, with no call failure, in about 13 and 17 minutes at 4 at once. `score.sh`, `compare.sh`, `judge.sh` and `judge.sh --check 40` ran end to end on macOS and exited 0. The judge (`codex`, `gpt-6-astra`, effort `high`) accepted the schema file as written and graded 158 and 160 answers with no failure, in under 4 minutes each.

| Measure | `keyword` | `fused_reranked` |
|---|---|---|
| Outcomes | completed 231, stopped 19, failed 0 | completed 234, stopped 16, failed 0 |
| Stopped: the answer did not pass the checks after 2 corrections | 18 of 250 = 7.2% [4.6%, 11.1%] | 16 of 250 = 6.4% [4.0%, 10.1%] |
| Stopped: the turn limit | 1 | 0 |
| Refusal questions declined | 57 of 60 = 95.0% [86.3%, 98.3%] | 56 of 60 = 93.3% [84.1%, 97.4%] |
| Answerable questions answered | 158 of 190 = 83.2% [77.2%, 87.8%] | 160 of 190 = 84.2% [78.4%, 88.7%] |
| Declined questions that were refusal questions | 57 of 71 = 80.3% [69.6%, 87.9%] | 56 of 70 = 80.0% [69.2%, 87.7%] |
| Answered, every citation from the right label | 148 of 160 = 92.5% [87.3%, 95.7%] | 155 of 164 = 94.5% [89.9%, 97.1%] |
| Cited sections that match a reference | 124 of 274 = 45.3% [39.5%, 51.2%] | 129 of 293 = 44.0% [38.5%, 49.8%] |
| References cited | 115 of 189 = 60.8% [53.7%, 67.5%] | 123 of 190 = 64.7% [57.7%, 71.2%] |
| A referenced section shown, first search | 125 of 190 = 65.8% [58.8%, 72.2%] | 140 of 190 = 73.7% [67.0%, 79.4%] |
| A referenced section shown, any search | 134 of 190 = 70.5% [63.7%, 76.6%] | 143 of 190 = 75.3% [68.7%, 80.9%] |
| Numeric answered, every reference number given | 18 of 21 = 85.7% [65.4%, 95.0%] | 19 of 20 = 95.0% [76.4%, 99.1%] |
| Median seconds; median tokens in | 8.6; 6,157 | 10.2; 7,386 |
| Of the cited passages, with no section number or title to match on | 45 of 274 | 49 of 293 |
| Left out of judging: the reference answer holds no letter | 3 | 3 |
| Judged correct | 96 of 155 = 61.9% [54.1%, 69.2%] | 97 of 157 = 61.8% [54.0%, 69.0%] |
| Judged partly correct | 49 of 155 = 31.6% [24.8%, 39.3%] | 51 of 157 = 32.5% [25.7%, 40.2%] |
| Judged incorrect | 10 of 155 = 6.5% [3.5%, 11.5%] | 9 of 157 = 5.7% [3.0%, 10.5%] |

Paired, `keyword` against `fused_reranked` (both right, only `keyword`, only `fused_reranked`, neither; the exact two-sided sign test):

| Measure | Both | Only `keyword` | Only `fused_reranked` | Neither | p |
|---|---|---|---|---|---|
| A referenced section shown, first search | 120 | 5 | 20 | 45 | 0.0041 |
| A referenced section shown, any search | 129 | 5 | 14 | 42 | 0.0636 |
| Declined rightly | 200 | 15 | 16 | 19 | 1 |
| Judged correct | 84 | 8 | 7 | 45 | 1 |

Three of the 190 answerable sampled questions have a reference answer that is only section numbers and punctuation. The judge found no fact in them and graded the reply incorrect, which counted against the agent for a fault of the benchmark. `judge.sh` does not ask about such questions, and `score.sh` leaves them out of the correctness shares (a judgment already stored for one is not counted, nor deleted) and says how many it left out.

Readings of these figures, stated as readings:

- Reranking put a referenced section in the first search more often: 20 questions against 5 (sign test p = 0.0041).
- It changed neither whether the agent answers (16 against 15, p = 1) nor how often the judge calls the answer correct (7 against 8, p = 1).
- 7% of runs with `keyword` and 6% with `fused_reranked` (18 and 16 of 250) ended with no reply, because an answer did not pass the checks after 2 corrections.

Not present in these figures:

- The judge has not been checked against a person: the 40-item check file is written and not filled in.
- One run of each strategy: run-to-run variation is not measured.
- The sample is 250 of the benchmark's 17,207 questions.

## Tests

`evaluation/test/` holds Q01 to Q14, run by `toolchain/check.sh` with everything else. Two test doubles, each labelled: a stand-in agent that speaks the contract over HTTP and records each request (`evaluation/test/support.ts`), and a stand-in judge adapter (`evaluation/test/stand-in-adapter.sh`). All text in them is invented.
