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

## Measured with the answers-question rubric and the reworded sample

Not measured yet. The planner records here the runs judged under `answers-question`, the measures by thirds of wording overlap, and the runs on the reworded sample, each with the command and the hardware it was measured on.

## Tests

`evaluation/test/` holds Q01 to Q25, run by `toolchain/check.sh` with everything else. Three test doubles, each labelled: a stand-in agent that speaks the contract over HTTP and records each request (`evaluation/test/support.ts`), a stand-in judge adapter (`evaluation/test/stand-in-adapter.sh`) and a stand-in rewriter adapter (`evaluation/test/stand-in-rewriter.sh`). All text in them is invented.
