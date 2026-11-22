# Evaluation

The harness that measures the label expert: it sends a fixed sample of the benchmark's questions (FDARxBench) to the agent through the agent contract, as a client does, stores every response, scores in code what code can score, and has a judge model grade the answers under a rubric. Two runs of the same questions, under two search strategies or on two wordings of the questions, are compared question by question. The design, the exact definition of every measure and what is not measured are in [docs/architecture/evaluation.md](../docs/architecture/evaluation.md).

Every command is run from the root of the repository. Each but the model calls of `judge.sh` and `reword.sh` runs its TypeScript in the piece's image, built from the `run` stage of `toolchain/Dockerfile` (the pinned Node image) and named for the checkout, with a read-only root, no capabilities and your user's ids.

## The commands

| Command | What it does | Needs |
|---|---|---|
| `evaluation/sample.sh [--record]` | Draws the sample: only questions whose label is in `knowledge/corpus/manifest.json`, stratified by question type with the counts in `evaluation/sample.json`, each stratum chosen by a seeded shuffle of its sorted qids. Writes `evaluation/data/sample.jsonl`, and fails if the draw differs from the qids committed in `evaluation/sample.json`. `--record` writes the qids and the hashes of the benchmark file and the manifest into `evaluation/sample.json` instead, to be committed | `knowledge/fetch.sh` run first (the benchmark file) |
| `evaluation/reword.sh` | Writes the reworded variant of the sample, `evaluation/data/sample-reworded.jsonl`: the same questions, each answerable question's text rewritten by a model as a clinician or pharmacist would ask it and checked by a second call; refusal questions copied. Prints the counts (reworded, kept the original and why) and the wording overlap before and after. Refuses to run when the file exists | The sample; the operator's machine (below) |
| `evaluation/reword.sh --check <n>` | Writes `evaluation/data/reword-check.csv`: `n` reworded questions drawn by seed, each with its original and its reworded text, for a person to read | The reworded sample |
| `evaluation/run.sh <compose-project> <run-name> [--sample reworded] [--retry-failed]` | Sends each sampled question to the label expert of a running stack (`http://expert:8080`, on the stack's network) with a real access token, signed in as `dana.desk` as the gates do, at most 4 at once. Stores each response whole, with its status, duration and time. `--sample reworded` sends the reworded variant; `run.json` records the variant and the SHA-256 of its file | The stack running, its index built, `platform/identity/.env` |
| `evaluation/score.sh <run-name>` | Scores the run against its own variant's file and prints the table; writes `scores.json`. Refuses a run whose variant file has changed since the run | `knowledge/chunk.sh` run (the chunks give each cited passage's section); the benchmark file (for wording overlap) |
| `evaluation/compare.sh <run-a> <run-b> [--only-reworded]` | For each yes-or-no measure: both right, only A, only B, neither, and the exact two-sided sign test; then the same within each third of wording overlap, as run A's scores cut them. Says which variants it compared. `--only-reworded` restricts to the questions actually reworded. Writes `compare-<run-a>.json` (or `compare-<run-a>-only-reworded.json`) beside run B | Both runs scored, on the same set of question ids |
| `evaluation/judge.sh <run-name> [--rubric <name>] [--retry-failed]` | Has the judge grade each answerable question the agent answered under one rubric, with one sentence of reason: `answers-question` (the default) or `completeness` (below). Writes `judgments-<rubric>.jsonl` and `judge-<rubric>.json` | The operator's machine (below) |
| `evaluation/judge.sh <run-name> [--rubric <name>] --check <n>` | Writes `judge-check-<rubric>.csv`: `n` items the judge graded under the rubric, drawn by seed, each with the question, the reference, the reply and empty columns for a person (`person_verdict` for completeness; `person_answers` and `person_contradicts` for answers-question). Once a person has filled it in, `score.sh` reports how often the judge and the person agree | A judged run |

A run is started again with the same command: a question already answered is not sent again, and one whose call failed is sent again only with `--retry-failed`. A run is made on one variant: starting it again on the other is refused. The same holds for `judge.sh`, per rubric. If the responses of one run report more than one search strategy, `run.sh` stops: change the service's `SEARCH_STRATEGY` only between runs, and give each strategy its own run name.

A typical comparison: `evaluation/sample.sh`; with the service on `keyword`, `evaluation/run.sh ai-on-aws keyword-1`; restart it on `fused_reranked`, `evaluation/run.sh ai-on-aws reranked-1`; `evaluation/judge.sh` and `evaluation/score.sh` on each; `evaluation/compare.sh keyword-1 reranked-1`.

A reworded comparison, in order: `evaluation/reword.sh` once; `evaluation/reword.sh --check <n>`, and read the pairs in `evaluation/data/reword-check.csv` before going on; `evaluation/run.sh ai-on-aws keyword-r1 --sample reworded`, then the same on `fused_reranked` as `reranked-r1` (once per strategy, the service restarted in between); `evaluation/judge.sh` and `evaluation/score.sh` on each; then `evaluation/compare.sh keyword-1 keyword-r1 --only-reworded` (the original against the reworded wording, for one strategy) and `evaluation/compare.sh keyword-r1 reranked-r1` (one strategy against the other, on the reworded set; with `--only-reworded`, on the questions actually reworded).

| Exit code | `sample.sh` | `reword.sh` | `run.sh` | `score.sh`, `compare.sh` | `judge.sh` |
|---|---|---|---|---|---|
| 0 | The sample is written | The reworded sample is written (or, with `--check`, the file) | Every question has a response | Done | Every question is judged (or, with `--check`, the file is written) |
| 1 | | The reworded sample is written, and some model calls failed: those questions keep their original text, each counted | Some calls failed, each recorded with its reason | | Some judge calls failed, each recorded |
| 2 | Could not run, or the draw differs from the committed list | Could not run, or the reworded sample exists already | Could not run, the run was made on the other variant, or the responses reported more than one strategy | Could not run (a run not found or not scored; a variant file changed since the run; runs on different sets of questions, or on the same variant with different files) | Could not run |

No command prints a question, an answer, a reply, a rewrite or a model's reason: output is counts, codes, identifiers and file names.

## The rubrics

| Rubric | The judge returns | Scored as |
|---|---|---|
| `answers-question` (the default) | `answers`: `yes` (the reply answers what the question asks, and nothing in it is contradicted by the reference), `partly` (it answers part of what was asked) or `no`; `contradicts`: whether the reply states something the reference contradicts; `coverage`: `all`, `some` or `none` of the reference's facts appear in the reply; one sentence of reason | The share with `answers: yes` and `contradicts: false` ("answers the question, uncontradicted"), the share that contradicts, and the three coverage shares; each overall and by question type. The paired comparison uses the first |
| `completeness` (the first rubric, unchanged) | `verdict`: `correct` (every fact of the reference given, none contradicted), `partly_correct` or `incorrect`; one sentence of reason | The three shares, overall and by question type. The paired comparison uses "correct" |

A run folder judged before rubrics existed holds `judgments.jsonl`, `judge.json` and perhaps `judge-check.csv`: they are read as the completeness rubric's for as long as `judgments-completeness.jsonl` (or `judge-check-completeness.csv`) does not exist. They are never rewritten or deleted; `judge.sh --rubric completeness` carries the old judgments over into the new file and asks only about questions they do not cover.

## The judge and the rewriter, on the operator's machine

The judge and the rewriter are models reached through the Codex command-line tool with the operator's own login, so `judge.sh` and `reword.sh` run on the operator's machine, not in a container. They need:

- a POSIX shell, `xargs`, `sleep` and `kill`;
- Docker, for the steps that run in the pinned image (writing the requests, and reading the answers back);
- the `codex` command on `PATH`, signed in. `evaluation/judge/codex.sh` and `evaluation/reword/codex.sh` run `codex exec` with the model `gpt-6-astra` and reasoning effort `high` (each adapter's settings, at its top), read-only, in an empty folder, with no git repository, no user configuration, no rules, no session kept, and the schema file they are given as the output schema.

Node is not needed on the machine. Each model call is given 300 seconds; at most 4 run at once.

Each sits behind one boundary: a command that takes the schema file its answer must keep to as its argument, reads one JSON request on standard input and writes one JSON answer on standard output, and answers `--describe` with its name, model and effort. Another model is another adapter script with the same contract; set `ADAPTER` in `judge.sh` or `reword.sh`. A call that fails, runs out of time, or answers outside the schema is recorded as a failure and counted; nothing is guessed.

| Adapter | Request | Schema file | Given nothing else than |
|---|---|---|---|
| The judge | `instructions` (the rubric's), `question` (the text the run sent), `reference`, `reply` | `evaluation/judge/verdict.schema.json` (completeness), `evaluation/judge/answers-question.schema.json` | The question, the benchmark's answer and the agent's reply with its citation markers removed: no passage, no citation, no identifier |
| The rewriter | `instructions`, `question`, `drug_name` | `evaluation/reword/rewrite.schema.json` (`question`) | The question and the drug's name: not the reference, not the label |
| The checker (the same adapter) | `instructions`, `original`, `rewrite` | `evaluation/reword/same.schema.json` (`same`, `reason`) | The two questions |

`reword.sh` runs the same three steps as `judge.sh`, twice: the image writes the rewrite requests; this machine calls the adapter; the image reads the rewrites back and writes a check request for each rewrite that came back in the schema and keeps the drug's name; this machine calls the adapter again; the image reads the checks back and writes the file. A rewrite is used only when the checker answers `same: true`. Otherwise the question keeps its original text and is counted as not reworded, with the reason: the rewrite call failed or answered outside the schema, the rewrite is the original again ignoring case and white space, or does not keep the drug's name (in both cases the checker is not asked), the check call failed or answered outside the schema, or the checker judged it not the same.

The drug's name is kept when the original question names the drug (as the benchmark's `drug_name`, ignoring case) and the rewrite holds the name spelled as the original spells it. A question that does not name the drug has no name to keep.

The judge and the rewriter are optional: without judgments `score.sh` prints "correctness: not judged", and without the reworded sample every run is on the original.

## Where the data lives

```
evaluation/
├── sample.json                   committed: the seed, the strata, the hashes of the files the list was drawn from,
│                                 and the list of qids (identifiers only)
└── data/                         never committed (.gitignore), never in an image (.dockerignore): it holds text
    ├── sample.jsonl              the sampled questions, with their answers and references
    ├── sample-reworded.jsonl     the reworded variant: each question with its text, whether it was reworded, and why not
    ├── sample-reworded.json      the rewriter, its model and effort, the instructions' hashes, the sample's and the
    │                             file's SHA-256, the counts and the wording overlap before and after
    ├── reword-check.csv          original and reworded pairs for a person to read
    └── runs/<run-name>/
        ├── responses.jsonl       one line per call: qid, time, duration, status, whether it kept to the contract,
        │                         the reason it failed, and the response whole
        ├── run.json              the sample variant and its file's hash, the agent's id, the models and strategies the
        │                         responses named, start and end
        ├── scores.json           every measure, each question's yes-or-no results, its wording overlap and third
        │                         (identifiers and numbers only)
        ├── compare-<run>.json    the comparison with another run (beside run B)
        ├── judgments-<rubric>.jsonl  one line per judged question: the verdict's fields and its reason, or the failure
        ├── judge-<rubric>.json   the judge, its model and effort, the rubric and the SHA-256 of its instructions
        ├── judge-check-<rubric>.csv  items for a person to grade, with the question, the reference and the reply
        └── judgments.jsonl, judge.json, judge-check.csv
                                  from before rubrics existed: read as the completeness rubric's (above)
```

## Reading the table

Every share is printed as `numerator of denominator = share [low, high]`: the interval is the 95% Wilson score interval. A share over fewer than 20 items is marked "too few to read". Two runs differ on a measure only as far as `compare.sh`'s sign test says: the two middle counts (only A right, only B right) are what it weighs; questions both got right or both got wrong say nothing about which run is better. With 250 questions, a difference of a few points on a share is within the interval.

The wording overlap of a question is the share of its content words found in the benchmark passage it was written from (the definition is in the architecture document). `score.sh` splits the answerable questions into thirds at the sample's own cut points, which it prints; a tie at a cut point falls to the lower third, so the thirds need not be the same size, and each third's size is printed. A question with no content words is in no third, and counted. `compare.sh` splits both runs by run A's thirds.

## Measured by the planner, 2026-11-22

Four runs of the 250 sampled questions, each on a trial stack from this repository, with the chat model qwen3.5-9b and the embedding model and reranker served on the GPU machine, over the 640-label index with vectors: `keyword` and `fused_reranked` on the original wording (`keyword-1`, `reranked-1`), then the same two on the reworded sample (`evaluation/run.sh <project> <name> --sample reworded`: `keyword-reworded-1`, `reranked-reworded-1`), the retrieval service restarted on its setting between strategies. Each run sent 250 questions, 4 at once, and got 250 responses. The rewriter, the checker and the judge were `gpt-6-astra` at effort `high` through the Codex command-line tool. No call to the agent, the rewriter, the checker or the judge failed. The two original runs were judged under both rubrics and scored by this harness; the two reworded runs were judged under `answers-question`. Every figure below is as `reword.sh`, `score.sh` and `compare.sh` printed it.

### The rewording

`evaluation/reword.sh`: 190 answerable questions sent to the rewriter, 190 checked, none settled before the checker (no rewrite failed, came back as the original, or lost the drug's name), 190 reworded; the 60 refusal questions copied; 0 model calls failed. `evaluation/reword.sh --check 30` wrote 30 original and reworded pairs for a person to read.

| Wording overlap | Median | Questions in the original wording's thirds (cut at 50.0% and 80.0%) |
|---|---|---|
| Original wording | 66.7% over 190 questions | 82, 53, 55 |
| Reworded | 35.7% over 190 questions | 142, 38, 10 |

The reworded sample's own thirds, which `score.sh` uses for the reworded runs, are cut at 25.0% and 50.0%: 69, 73 and 48 questions.

### The four runs

| Measure | `keyword-1` (original) | `reranked-1` (original) | `keyword-reworded-1` | `reranked-reworded-1` |
|---|---|---|---|---|
| Outcomes | completed 231, stopped 19, failed 0, call failures 0 | completed 234, stopped 16, failed 0, call failures 0 | completed 226, stopped 24, failed 0, call failures 0 | completed 232, stopped 18, failed 0, call failures 0 |
| Stopped: the answer did not pass the checks after 2 corrections | 18 | 16 | 22 | 17 |
| Stopped: the run reached its limit of 8 turns | 1 | 0 | 2 | 1 |
| Label answers | answered 160, label_does_not_answer 57, no_label 14, none 19 | answered 164, label_does_not_answer 56, no_label 14, none 16 | answered 157, label_does_not_answer 58, no_label 11, none 24 | answered 166, label_does_not_answer 55, no_label 11, none 18 |
| Refusal questions declined | 57 of 60 = 95.0% [86.3%, 98.3%] | 56 of 60 = 93.3% [84.1%, 97.4%] | 56 of 60 = 93.3% [84.1%, 97.4%] | 55 of 60 = 91.7% [81.9%, 96.4%] |
| Answerable questions answered | 158 of 190 = 83.2% [77.2%, 87.8%] | 160 of 190 = 84.2% [78.4%, 88.7%] | 154 of 190 = 81.1% [74.9%, 86.0%] | 162 of 190 = 85.3% [79.5%, 89.6%] |
| Declined questions that were refusal questions | 57 of 71 = 80.3% [69.6%, 87.9%] | 56 of 70 = 80.0% [69.2%, 87.7%] | 56 of 69 = 81.2% [70.4%, 88.6%] | 55 of 66 = 83.3% [72.6%, 90.4%] |
| Answered, every citation from the right label | 148 of 160 = 92.5% [87.3%, 95.7%] | 155 of 164 = 94.5% [89.9%, 97.1%] | 146 of 157 = 93.0% [87.9%, 96.0%] | 156 of 166 = 94.0% [89.3%, 96.7%] |
| Cited sections that match a reference | 124 of 274 = 45.3% [39.5%, 51.2%] | 129 of 293 = 44.0% [38.5%, 49.8%] | 107 of 270 = 39.6% [34.0%, 45.6%] | 119 of 286 = 41.6% [36.0%, 47.4%] |
| References cited | 115 of 189 = 60.8% [53.7%, 67.5%] | 123 of 190 = 64.7% [57.7%, 71.2%] | 102 of 185 = 55.1% [47.9%, 62.1%] | 114 of 196 = 58.2% [51.2%, 64.8%] |
| Of the cited passages, with no section number or title to match on | 45 of 274 | 49 of 293 | 41 of 270 | 38 of 286 |
| Numeric answered, every reference number given | 18 of 21 = 85.7% [65.4%, 95.0%] | 19 of 20 = 95.0% [76.4%, 99.1%] | 19 of 22 = 86.4% [66.7%, 95.3%] | 19 of 20 = 95.0% [76.4%, 99.1%] |
| A referenced section shown, any search | 134 of 190 = 70.5% [63.7%, 76.6%] | 143 of 190 = 75.3% [68.7%, 80.9%] | 121 of 190 = 63.7% [56.6%, 70.2%] | 131 of 190 = 68.9% [62.0%, 75.1%] |
| A referenced section shown, first search | 125 of 190 = 65.8% [58.8%, 72.2%] | 140 of 190 = 73.7% [67.0%, 79.4%] | 98 of 190 = 51.6% [44.5%, 58.6%] | 126 of 190 = 66.3% [59.3%, 72.7%] |
| Searches: median, 95th percentile | 1, 4 | 1, 4 | 2, 4 | 1, 4 |
| Corrections: median, 95th percentile | 0, 3 | 0, 3 | 0, 3 | 0, 3 |
| Seconds: median, 95th percentile | 8.6, 37.2 | 10.2, 58.4 | 9.4, 47.4 | 10.8, 42.1 |
| Tokens in: median, 95th percentile | 6157, 16382 | 7386, 21239 | 7447, 20488 | 7544, 22540 |
| Tokens out: median, 95th percentile | 678, 2451 | 718, 2630 | 720, 2733 | 783, 2753 |
| Left out of judging: the reference answer holds no letter | 3 | 3 | 2 | 3 |
| `answers-question`: judged, judge failures | 155, 0 | 157, 0 | 152, 0 | 159, 0 |
| All: answers the question, uncontradicted | 129 of 155 = 83.2% [76.6%, 88.3%] | 139 of 157 = 88.5% [82.6%, 92.6%] | 123 of 152 = 80.9% [73.9%, 86.4%] | 137 of 159 = 86.2% [79.9%, 90.7%] |
| All: contradicts the reference | 6 of 155 = 3.9% [1.8%, 8.2%] | 3 of 157 = 1.9% [0.7%, 5.5%] | 3 of 152 = 2.0% [0.7%, 5.6%] | 3 of 159 = 1.9% [0.6%, 5.4%] |
| All: covers all of the reference | 95 of 155 = 61.3% [53.4%, 68.6%] | 97 of 157 = 61.8% [54.0%, 69.0%] | 85 of 152 = 55.9% [48.0%, 63.6%] | 100 of 159 = 62.9% [55.2%, 70.0%] |
| All: covers some of the reference | 55 of 155 = 35.5% [28.4%, 43.3%] | 56 of 157 = 35.7% [28.6%, 43.4%] | 60 of 152 = 39.5% [32.1%, 47.4%] | 57 of 159 = 35.8% [28.8%, 43.6%] |
| All: covers none of the reference | 5 of 155 = 3.2% [1.4%, 7.3%] | 4 of 157 = 2.5% [1.0%, 6.4%] | 7 of 152 = 4.6% [2.2%, 9.2%] | 2 of 159 = 1.3% [0.3%, 4.5%] |
| Factual: answers the question, uncontradicted | 68 of 82 = 82.9% [73.4%, 89.5%] | 73 of 86 = 84.9% [75.8%, 90.9%] | 65 of 81 = 80.2% [70.3%, 87.5%] | 73 of 84 = 86.9% [78.1%, 92.5%] |
| Factual: contradicts the reference | 2 of 82 = 2.4% [0.7%, 8.5%] | 2 of 86 = 2.3% [0.6%, 8.1%] | 0 of 81 = 0.0% [0.0%, 4.5%] | 1 of 84 = 1.2% [0.2%, 6.4%] |
| Factual: covers all of the reference | 49 of 82 = 59.8% [48.9%, 69.7%] | 50 of 86 = 58.1% [47.6%, 68.0%] | 44 of 81 = 54.3% [43.5%, 64.7%] | 50 of 84 = 59.5% [48.8%, 69.4%] |
| Factual: covers some of the reference | 29 of 82 = 35.4% [25.9%, 46.2%] | 32 of 86 = 37.2% [27.7%, 47.8%] | 32 of 81 = 39.5% [29.6%, 50.4%] | 33 of 84 = 39.3% [29.5%, 50.0%] |
| Factual: covers none of the reference | 4 of 82 = 4.9% [1.9%, 11.9%] | 4 of 86 = 4.7% [1.8%, 11.4%] | 5 of 81 = 6.2% [2.7%, 13.6%] | 1 of 84 = 1.2% [0.2%, 6.4%] |
| Multihop: answers the question, uncontradicted | 20 of 31 = 64.5% [46.9%, 78.9%] | 26 of 30 = 86.7% [70.3%, 94.7%] | 22 of 31 = 71.0% [53.4%, 83.9%] | 24 of 34 = 70.6% [53.8%, 83.2%] |
| Multihop: contradicts the reference | 3 of 31 = 9.7% [3.3%, 24.9%] | 1 of 30 = 3.3% [0.6%, 16.7%] | 1 of 31 = 3.2% [0.6%, 16.2%] | 2 of 34 = 5.9% [1.6%, 19.1%] |
| Multihop: covers all of the reference | 9 of 31 = 29.0% [16.1%, 46.6%] | 11 of 30 = 36.7% [21.9%, 54.5%] | 10 of 31 = 32.3% [18.6%, 49.9%] | 13 of 34 = 38.2% [23.9%, 55.0%] |
| Multihop: covers some of the reference | 21 of 31 = 67.7% [50.1%, 81.4%] | 19 of 30 = 63.3% [45.5%, 78.1%] | 19 of 31 = 61.3% [43.8%, 76.3%] | 20 of 34 = 58.8% [42.2%, 73.6%] |
| Multihop: covers none of the reference | 1 of 31 = 3.2% [0.6%, 16.2%] | 0 of 30 = 0.0% [0.0%, 11.4%] | 2 of 31 = 6.5% [1.8%, 20.7%] | 1 of 34 = 2.9% [0.5%, 14.9%] |
| Numeric: answers the question, uncontradicted | 20 of 21 = 95.2% [77.3%, 99.2%] | 20 of 20 = 100.0% [83.9%, 100.0%] | 20 of 22 = 90.9% [72.2%, 97.5%] | 20 of 20 = 100.0% [83.9%, 100.0%] |
| Numeric: contradicts the reference | 1 of 21 = 4.8% [0.8%, 22.7%] | 0 of 20 = 0.0% [0.0%, 16.1%] | 2 of 22 = 9.1% [2.5%, 27.8%] | 0 of 20 = 0.0% [0.0%, 16.1%] |
| Numeric: covers all of the reference | 16 of 21 = 76.2% [54.9%, 89.4%] | 17 of 20 = 85.0% [64.0%, 94.8%] | 16 of 22 = 72.7% [51.8%, 86.8%] | 17 of 20 = 85.0% [64.0%, 94.8%] |
| Numeric: covers some of the reference | 5 of 21 = 23.8% [10.6%, 45.1%] | 3 of 20 = 15.0% [5.2%, 36.0%] | 6 of 22 = 27.3% [13.2%, 48.2%] | 3 of 20 = 15.0% [5.2%, 36.0%] |
| Numeric: covers none of the reference | 0 of 21 = 0.0% [0.0%, 15.5%] | 0 of 20 = 0.0% [0.0%, 16.1%] | 0 of 22 = 0.0% [0.0%, 14.9%] | 0 of 20 = 0.0% [0.0%, 16.1%] |
| List: answers the question, uncontradicted | 21 of 21 = 100.0% [84.5%, 100.0%] | 20 of 21 = 95.2% [77.3%, 99.2%] | 16 of 18 = 88.9% [67.2%, 96.9%] (too few to read) | 20 of 21 = 95.2% [77.3%, 99.2%] |
| List: contradicts the reference | 0 of 21 = 0.0% [0.0%, 15.5%] | 0 of 21 = 0.0% [0.0%, 15.5%] | 0 of 18 = 0.0% [0.0%, 17.6%] (too few to read) | 0 of 21 = 0.0% [0.0%, 15.5%] |
| List: covers all of the reference | 21 of 21 = 100.0% [84.5%, 100.0%] | 19 of 21 = 90.5% [71.1%, 97.3%] | 15 of 18 = 83.3% [60.8%, 94.2%] (too few to read) | 20 of 21 = 95.2% [77.3%, 99.2%] |
| List: covers some of the reference | 0 of 21 = 0.0% [0.0%, 15.5%] | 2 of 21 = 9.5% [2.7%, 28.9%] | 3 of 18 = 16.7% [5.8%, 39.2%] (too few to read) | 1 of 21 = 4.8% [0.8%, 22.7%] |
| List: covers none of the reference | 0 of 21 = 0.0% [0.0%, 15.5%] | 0 of 21 = 0.0% [0.0%, 15.5%] | 0 of 18 = 0.0% [0.0%, 17.6%] (too few to read) | 0 of 21 = 0.0% [0.0%, 15.5%] |
| `completeness`: judged, judge failures | 155, 0 | 157, 0 | not judged | not judged |
| All: correct | 96 of 155 = 61.9% [54.1%, 69.2%] | 97 of 157 = 61.8% [54.0%, 69.0%] | | |
| All: partly correct | 49 of 155 = 31.6% [24.8%, 39.3%] | 51 of 157 = 32.5% [25.7%, 40.2%] | | |
| All: incorrect | 10 of 155 = 6.5% [3.5%, 11.5%] | 9 of 157 = 5.7% [3.0%, 10.5%] | | |
| Factual: correct | 48 of 82 = 58.5% [47.7%, 68.6%] | 50 of 86 = 58.1% [47.6%, 68.0%] | | |
| Factual: partly correct | 28 of 82 = 34.1% [24.8%, 44.9%] | 30 of 86 = 34.9% [25.7%, 45.4%] | | |
| Factual: incorrect | 6 of 82 = 7.3% [3.4%, 15.1%] | 6 of 86 = 7.0% [3.2%, 14.4%] | | |
| Multihop: correct | 11 of 31 = 35.5% [21.1%, 53.1%] | 12 of 30 = 40.0% [24.6%, 57.7%] | | |
| Multihop: partly correct | 17 of 31 = 54.8% [37.8%, 70.8%] | 16 of 30 = 53.3% [36.1%, 69.8%] | | |
| Multihop: incorrect | 3 of 31 = 9.7% [3.3%, 24.9%] | 2 of 30 = 6.7% [1.8%, 21.3%] | | |
| Numeric: correct | 16 of 21 = 76.2% [54.9%, 89.4%] | 17 of 20 = 85.0% [64.0%, 94.8%] | | |
| Numeric: partly correct | 4 of 21 = 19.0% [7.7%, 40.0%] | 3 of 20 = 15.0% [5.2%, 36.0%] | | |
| Numeric: incorrect | 1 of 21 = 4.8% [0.8%, 22.7%] | 0 of 20 = 0.0% [0.0%, 16.1%] | | |
| List: correct | 21 of 21 = 100.0% [84.5%, 100.0%] | 18 of 21 = 85.7% [65.4%, 95.0%] | | |
| List: partly correct | 0 of 21 = 0.0% [0.0%, 15.5%] | 2 of 21 = 9.5% [2.7%, 28.9%] | | |
| List: incorrect | 0 of 21 = 0.0% [0.0%, 15.5%] | 1 of 21 = 4.8% [0.8%, 22.7%] | | |

Three of the 190 answerable sampled questions have a reference answer that is only section numbers and punctuation (two of them were answered in `keyword-reworded-1`). A judge finds no fact in them to grade against, so `judge.sh` does not ask about them, and `score.sh` leaves them out of the judged shares (a judgment already stored for one is not counted, nor deleted) and says how many it left out.

### By thirds of wording overlap

Each run is split by the thirds of its own variant's file: the original wording cut at 50.0% and 80.0% (82, 53, 55 questions), the reworded at 25.0% and 50.0% (69, 73, 48 questions).

| Third | Measure | `keyword-1` | `reranked-1` | Third | `keyword-reworded-1` | `reranked-reworded-1` |
|---|---|---|---|---|---|---|
| Lowest | First search | 48 of 82 = 58.5% [47.7%, 68.6%] | 61 of 82 = 74.4% [64.0%, 82.6%] | Lowest | 27 of 69 = 39.1% [28.5%, 50.9%] | 41 of 69 = 59.4% [47.6%, 70.2%] |
| Lowest | Any search | 56 of 82 = 68.3% [57.6%, 77.4%] | 63 of 82 = 76.8% [66.6%, 84.6%] | Lowest | 41 of 69 = 59.4% [47.6%, 70.2%] | 45 of 69 = 65.2% [53.4%, 75.4%] |
| Lowest | Answers, uncontradicted | 50 of 64 = 78.1% [66.6%, 86.5%] | 56 of 69 = 81.2% [70.4%, 88.6%] | Lowest | 40 of 52 = 76.9% [63.9%, 86.3%] | 48 of 56 = 85.7% [74.3%, 92.6%] |
| Middle | First search | 43 of 53 = 81.1% [68.6%, 89.4%] | 44 of 53 = 83.0% [70.8%, 90.8%] | Middle | 41 of 73 = 56.2% [44.8%, 67.0%] | 53 of 73 = 72.6% [61.4%, 81.5%] |
| Middle | Any search | 44 of 53 = 83.0% [70.8%, 90.8%] | 45 of 53 = 84.9% [72.9%, 92.1%] | Middle | 47 of 73 = 64.4% [52.9%, 74.4%] | 54 of 73 = 74.0% [62.9%, 82.7%] |
| Middle | Answers, uncontradicted | 35 of 44 = 79.5% [65.5%, 88.8%] | 41 of 44 = 93.2% [81.8%, 97.7%] | Middle | 46 of 57 = 80.7% [68.7%, 88.9%] | 51 of 60 = 85.0% [73.9%, 91.9%] |
| Highest | First search | 34 of 55 = 61.8% [48.6%, 73.5%] | 35 of 55 = 63.6% [50.4%, 75.1%] | Highest | 30 of 48 = 62.5% [48.4%, 74.8%] | 32 of 48 = 66.7% [52.5%, 78.3%] |
| Highest | Any search | 34 of 55 = 61.8% [48.6%, 73.5%] | 35 of 55 = 63.6% [50.4%, 75.1%] | Highest | 33 of 48 = 68.8% [54.7%, 80.1%] | 32 of 48 = 66.7% [52.5%, 78.3%] |
| Highest | Answers, uncontradicted | 44 of 47 = 93.6% [82.8%, 97.8%] | 42 of 44 = 95.5% [84.9%, 98.7%] | Highest | 37 of 43 = 86.0% [72.7%, 93.4%] | 38 of 43 = 88.4% [75.5%, 94.9%] |

### Paired

Both right, only A, only B, neither, and the exact two-sided sign test on the two middle counts, as `compare.sh` printed them (p printed as 0.0000 is below 0.00005). `judged_correct` is the `completeness` rubric's "correct"; the reworded runs were not judged under it.

Strategies on the original wording, `evaluation/compare.sh keyword-1 reranked-1`:

| Measure | n | Both | Only `keyword-1` | Only `reranked-1` | Neither | p |
|---|---|---|---|---|---|---|
| declined_rightly | 250 | 200 | 15 | 16 | 19 | 1.0000 |
| right_label | 147 | 138 | 0 | 0 | 9 | 1.0000 |
| retrieved_any | 190 | 129 | 5 | 14 | 42 | 0.0636 |
| retrieved_first | 190 | 120 | 5 | 20 | 45 | 0.0041 |
| numbers | 20 | 18 | 0 | 1 | 1 | 1.0000 |
| judged_correct | 144 | 84 | 8 | 7 | 45 | 1.0000 |
| answers_uncontradicted | 144 | 120 | 5 | 8 | 11 | 0.5811 |

Strategies on the reworded questions, `evaluation/compare.sh keyword-reworded-1 reranked-reworded-1 --only-reworded` (all 190 answerable questions were reworded):

| Measure | n | Both | Only `keyword-reworded-1` | Only `reranked-reworded-1` | Neither | p |
|---|---|---|---|---|---|---|
| declined_rightly | 190 | 146 | 8 | 16 | 20 | 0.1516 |
| right_label | 146 | 137 | 0 | 0 | 9 | 1.0000 |
| retrieved_any | 190 | 113 | 8 | 18 | 51 | 0.0755 |
| retrieved_first | 190 | 94 | 4 | 32 | 60 | 0.0000 |
| numbers | 19 | 17 | 0 | 1 | 1 | 1.0000 |
| answers_uncontradicted | 144 | 112 | 6 | 13 | 13 | 0.1671 |

Original against reworded, `keyword`: `evaluation/compare.sh keyword-1 keyword-reworded-1 --only-reworded`:

| Measure | n | Both | Only `keyword-1` | Only `keyword-reworded-1` | Neither | p |
|---|---|---|---|---|---|---|
| declined_rightly | 190 | 140 | 18 | 14 | 18 | 0.5966 |
| right_label | 140 | 131 | 0 | 0 | 9 | 1.0000 |
| retrieved_any | 190 | 111 | 23 | 10 | 46 | 0.0351 |
| retrieved_first | 190 | 89 | 36 | 9 | 56 | 0.0001 |
| numbers | 21 | 18 | 0 | 0 | 3 | 1.0000 |
| answers_uncontradicted | 138 | 107 | 11 | 6 | 14 | 0.3323 |

Original against reworded, `fused_reranked`: `evaluation/compare.sh reranked-1 reranked-reworded-1 --only-reworded`:

| Measure | n | Both | Only `reranked-1` | Only `reranked-reworded-1` | Neither | p |
|---|---|---|---|---|---|---|
| declined_rightly | 190 | 144 | 16 | 18 | 12 | 0.8642 |
| right_label | 144 | 138 | 0 | 0 | 6 | 1.0000 |
| retrieved_any | 190 | 125 | 18 | 6 | 41 | 0.0227 |
| retrieved_first | 190 | 120 | 20 | 6 | 44 | 0.0094 |
| numbers | 18 | 17 | 0 | 0 | 1 | 1.0000 |
| answers_uncontradicted | 141 | 119 | 7 | 5 | 10 | 0.7744 |

The two strategy comparisons by third, each on run A's thirds (original wording: cut at 50.0% and 80.0%; reworded: at 25.0% and 50.0%):

| Comparison | Third (questions) | Measure | n | Both | Only `keyword` | Only `fused_reranked` | Neither | p |
|---|---|---|---|---|---|---|---|---|
| Original | Lowest (82) | retrieved_first | 82 | 45 | 3 | 16 | 18 | 0.0044 |
| Original | Lowest (82) | retrieved_any | 82 | 52 | 4 | 11 | 15 | 0.1185 |
| Original | Lowest (82) | answers_uncontradicted | 60 | 45 | 3 | 4 | 8 | 1.0000 |
| Original | Middle (53) | retrieved_first | 53 | 41 | 2 | 3 | 7 | 1.0000 |
| Original | Middle (53) | retrieved_any | 53 | 43 | 1 | 2 | 7 | 1.0000 |
| Original | Middle (53) | answers_uncontradicted | 40 | 33 | 1 | 4 | 2 | 0.3750 |
| Original | Highest (55) | retrieved_first | 55 | 34 | 0 | 1 | 20 | 1.0000 |
| Original | Highest (55) | retrieved_any | 55 | 34 | 0 | 1 | 20 | 1.0000 |
| Original | Highest (55) | answers_uncontradicted | 44 | 42 | 1 | 0 | 1 | 1.0000 |
| Reworded | Lowest (69) | retrieved_first | 69 | 24 | 3 | 17 | 25 | 0.0026 |
| Reworded | Lowest (69) | retrieved_any | 69 | 36 | 5 | 9 | 19 | 0.4240 |
| Reworded | Lowest (69) | answers_uncontradicted | 48 | 37 | 1 | 6 | 4 | 0.1250 |
| Reworded | Middle (73) | retrieved_first | 73 | 40 | 1 | 13 | 19 | 0.0018 |
| Reworded | Middle (73) | retrieved_any | 73 | 45 | 2 | 9 | 17 | 0.0654 |
| Reworded | Middle (73) | answers_uncontradicted | 55 | 42 | 2 | 4 | 7 | 0.6875 |
| Reworded | Highest (48) | retrieved_first | 48 | 30 | 0 | 2 | 16 | 0.5000 |
| Reworded | Highest (48) | retrieved_any | 48 | 32 | 1 | 0 | 15 | 1.0000 |
| Reworded | Highest (48) | answers_uncontradicted | 41 | 33 | 3 | 3 | 2 | 1.0000 |

The original-against-reworded comparisons were also split by third (by the original run's thirds); for first-search retrieval, only original against only reworded: `keyword` 19 / 8 (p = 0.0522), 10 / 0 (p = 0.0020), 7 / 1 (p = 0.0703); `fused_reranked` 14 / 4 (p = 0.0309), 4 / 1 (p = 0.3750), 2 / 1 (p = 1.0000), lowest, middle and highest.

### Readings

Stated as readings, each with the figures it rests on:

- On the original wording, reranking put a referenced section in the first search more often only in the lowest third of wording overlap: 16 questions against 3 there (p = 0.0044), against 3 to 2 (p = 1.0000) in the middle third and 1 to 0 (p = 1.0000) in the highest; 20 against 5 overall (p = 0.0041). It changed neither whether the agent answers (declined rightly: 16 against 15, p = 1.0000) nor the judged answers (correct under `completeness`: 7 against 8, p = 1.0000; answers the question uncontradicted: 8 against 5, p = 0.5811).
- Rewording lowered first-search retrieval for both strategies, and for `keyword` by more: `keyword` from 125 to 98 of 190 (paired, 36 lost against 9 gained, p = 0.0001); `fused_reranked` from 140 to 126 of 190 (20 against 6, p = 0.0094).
- On the reworded questions the gap between the strategies in first-search retrieval is larger and clear: 32 questions against 4 (p = 0.0000 as printed), 126 against 98 of 190, and present in the lowest and middle thirds (17 against 3, p = 0.0026; 13 against 1, p = 0.0018). The gap in judged answers points the same way and is not established by this run: answers the question uncontradicted, 13 against 6 (p = 0.1671). The planner's earlier probe, with a different set of rewrites and its own judging script, gave 10 against 2 on the same measure; it was a probe, and is not in the repository.
- Under `completeness` about a third of the answers were graded "partly correct" (49 of 155 and 51 of 157 on the original wording). Under `answers-question` most answers answer the question: 129 of 155 and 139 of 157 answer it uncontradicted, against 96 and 97 graded correct. Derived from those shares (the two rubrics' judgments were not crossed question by question): at least 33 (`keyword`) and 42 (`fused_reranked`) answers that answer the question uncontradicted were not graded correct, that is were partly correct or incorrect under `completeness`; and the shares covering only some of the reference (55 and 56) sit close to the partly correct ones (49 and 51).
- The agent's own checks ended 16 to 22 of the 250 runs with no reply (an answer that did not pass after 2 corrections): 18, 16, 22 and 17 in the four runs.

### Not present in these figures

- One run per strategy and variant: run-to-run variation is not measured.
- The judge has not been checked against a person under either rubric: no person has filled in a check file. A second judging of the same original answers by the planner's probe counted contradictions differently (10 and 9, against 6 and 3 here), so the contradiction share is approximate.
- The rewrites are a model's, checked by a model; the 30-pair file `reword.sh --check 30` wrote for a person has not yet been read.
- The sample is 250 of the benchmark's 17,207 questions.

## Tests

`evaluation/test/` holds Q01 to Q25, run by `toolchain/check.sh` with everything else. Three test doubles, each labelled: a stand-in agent that speaks the contract over HTTP and records each request (`evaluation/test/support.ts`), a stand-in judge adapter (`evaluation/test/stand-in-adapter.sh`) and a stand-in rewriter adapter (`evaluation/test/stand-in-rewriter.sh`). All text in them is invented.
