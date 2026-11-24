# Evaluation

The harness that measures the label expert: it sends a fixed sample of the benchmark's questions (FDARxBench) to the agent through the agent contract, as a client does, stores every response, scores in code what code can score, and has a judge model grade the answers under a rubric. Two runs of the same questions, under two search strategies or on two wordings of the questions, are compared question by question. The design, the exact definition of every measure and what is not measured are in [docs/architecture/evaluation.md](../docs/architecture/evaluation.md).

Every command is run from the root of the repository. Each but the model calls of `judge.sh` and `reword.sh` runs its TypeScript in the piece's image, built from the `run` stage of `toolchain/Dockerfile` (the pinned Node image) and named for the checkout, with a read-only root, no capabilities and your user's ids.

## The commands

| Command | What it does | Needs |
|---|---|---|
| `evaluation/sample.sh [--record]` | Draws the sample: only questions whose label is in `knowledge/corpus/manifest.json`, stratified by question type with the counts in `evaluation/sample.json`, each stratum chosen by a seeded shuffle of its sorted qids. Writes `evaluation/data/sample.jsonl`, and fails if the draw differs from the qids committed in `evaluation/sample.json`. `--record` writes the qids and the hashes of the benchmark file and the manifest into `evaluation/sample.json` instead, to be committed | `knowledge/fetch.sh` run first (the benchmark file) |
| `evaluation/reword.sh` | Writes the reworded variant of the sample, `evaluation/data/sample-reworded.jsonl`: the same questions, each answerable question's text rewritten by a model as a clinician or pharmacist would ask it and checked by a second call; refusal questions copied. Prints the counts (reworded, kept the original and why) and the wording overlap before and after. Refuses to run when the file exists | The sample; the operator's machine (below) |
| `evaluation/reword.sh --check <n>` | Writes `evaluation/data/reword-check.csv`: `n` reworded questions drawn by seed, each with its original and its reworded text, for a person to read | The reworded sample |
| `evaluation/run.sh <compose-project> <run-name> [--sample reworded] [--retry-failed]` | Sends each sampled question to the label expert of a running stack (`http://expert:8080`, on the stack's network) with a real access token, got as its own client, `evaluation`, by client credentials with its own secret, at most 4 at once. Stores each response whole, with its status, duration and time. `--sample reworded` sends the reworded variant; `run.json` records the variant and the SHA-256 of its file | The stack running, its index built, `platform/identity/.env` |
| `evaluation/score.sh <run-name>` | Scores the run against its own variant's file and prints the table; writes `scores.json`. Refuses a run whose variant file has changed since the run | `knowledge/chunk.sh` run (the chunks give each cited passage's section); the benchmark file (for wording overlap) |
| `evaluation/compare.sh <run-a> <run-b> [--only-reworded]` | For each yes-or-no measure: both right, only A, only B, neither, and the exact two-sided sign test; then the same within each third of wording overlap, as run A's scores cut them. Says which variants it compared. `--only-reworded` restricts to the questions actually reworded. Writes `compare-<run-a>.json` (or `compare-<run-a>-only-reworded.json`) beside run B | Both runs scored, on the same set of question ids |
| `evaluation/judge.sh <run-name> [--rubric <name>] [--retry-failed]` | Has the judge grade each answerable question the agent answered under one rubric, with one sentence of reason: `answers-question` (the default) or `completeness` (below). Writes `judgments-<rubric>.jsonl` and `judge-<rubric>.json` | The operator's machine (below) |
| `evaluation/judge.sh <run-name> [--rubric <name>] --check <n>` | Writes `judge-check-<rubric>.csv`: `n` items the judge graded under the rubric, drawn by seed, each with the question, the reference, the reply and empty columns for a person (`person_verdict` for completeness; `person_answers` and `person_contradicts` for answers-question). Once a person has filled it in, `score.sh` reports how often the judge and the person agree | A judged run |

A run is started again with the same command: a question already answered is not sent again, and one whose call failed is sent again only with `--retry-failed`. The same holds for `judge.sh`, per rubric. A run is made on one variant: starting it again on the other is refused. If the responses of one run report more than one search strategy, `run.sh` stops: change the service's `SEARCH_STRATEGY` only between runs, and give each strategy its own run name.

A typical comparison: `evaluation/sample.sh`; with the service on `keyword`, `evaluation/run.sh ai-on-aws keyword-1`; restart it on `fused_reranked`, `evaluation/run.sh ai-on-aws reranked-1`; `evaluation/judge.sh` and `evaluation/score.sh` on each; `evaluation/compare.sh keyword-1 reranked-1`.

A reworded comparison, in order: `evaluation/reword.sh` once; `evaluation/reword.sh --check <n>`, and read the pairs in `evaluation/data/reword-check.csv` before going on; `evaluation/run.sh ai-on-aws keyword-r1 --sample reworded`, then the same on `fused_reranked` as `reranked-r1` (once per strategy, the service restarted in between); `evaluation/judge.sh` and `evaluation/score.sh` on each; then `evaluation/compare.sh keyword-1 keyword-r1 --only-reworded` (the original against the reworded wording, for one strategy) and `evaluation/compare.sh keyword-r1 reranked-r1` (one strategy against the other, on the reworded set; with `--only-reworded`, on the questions actually reworded).

| Exit code | `sample.sh` | `reword.sh` | `run.sh` | `score.sh`, `compare.sh` | `judge.sh` |
|---|---|---|---|---|---|
| 0 | The sample is written | The reworded sample is written (or, with `--check`, the file) | Every question has a response | Done | Every question is judged (or, with `--check`, the file is written) |
| 1 | | The reworded sample is written, and some model calls failed: those questions keep their original text, each counted | Some calls failed, each recorded with its reason; a call for which no access token could be got is one | | Some judge calls failed, each recorded |
| 2 | Could not run, or the draw differs from the committed list | Could not run, or the reworded sample exists already | Could not run, the run was made on the other variant, or the responses reported more than one strategy | Could not run (a run not found or not scored; a variant file changed since the run; runs on different sets of questions, or on the same variant with different files) | Could not run |

No command prints a question, an answer, a reply, a rewrite or a model's reason: output is counts, codes, identifiers and file names.

## The attack run

`evaluation/attacks.sh <compose-project> <run-name> [--fault case-system|knowledge]` tries what must not work, and what must still work, on a running stack, and computes each case's verdict in code. The cases are committed in `evaluation/attacks/cases.json`: synthetic messages with invented people and medicines, each with its class, target agent, person, sender, precondition and expectations, and whether the stack's code or a model's choice decides how it comes out. The classes and how a case is judged are in [docs/architecture/evaluation.md](../docs/architecture/evaluation.md#attack-control-and-fault-cases).

**It is for a trial stack.** It enters about 60 inquiries as `dana.desk` and `morgan.medinfo` and opens cases from them. Start a fresh stack (`docker compose up -d --build --wait`, with the index built by `knowledge/index.sh` and a model server set up by `model/setup.sh`), then run it there. It needs `platform/identity/.env`, from which Compose gives it the four people's passwords and nothing else.

| Run | What it does |
|---|---|
| `evaluation/attacks.sh ai-on-aws attacks-1` | Signs the four people in through the client; enters the victim's report as `dana.desk` through `intake-strands` and finds its case as `riley.reviewer`; then plays every attack and control case and the sent-twice faults, one at a time, each through the client as its person, waiting up to 300 s for its run; reads each ended run's trace as `avery.auditor` and the truth as `riley.reviewer` after each; judges it, searching the run as the person received it as the record and reading the steps, delegated responses and claims from the trace; signs out |
| `evaluation/attacks.sh ai-on-aws attacks-1-cases --fault case-system` | Stops the case system with Compose, plays the two cases run without it, and starts it again whatever happened |
| `evaluation/attacks.sh ai-on-aws attacks-1-knowledge --fault knowledge` | The same with the retrieval service |

Each run has its own name: started again with a name that exists, it refuses, since an attack run changes the stack. A `--fault` run refuses when its service is not running to begin with.

It writes `evaluation/data/attacks/<run-name>/results.jsonl`, one line per case (the case's id, class, target, person, verdict, the expectations that failed, why a case was inconclusive or not run, the claim findings, and what was observed: each run as the person received it, without steps, and each run's trace as `avery.auditor` read it, steps included), and `victim.json`. A case with a run that ended but whose trace could not be read is not run. It prints one line per case (its id and verdict), then a table: for each class and target, how many cases held, failed, were inconclusive or not run, with cases decided by code and by a model counted apart, and the reply and record scopes of work in the reply apart; then the ids of the cases decided by code, and of the controls, that did not hold; then the claim findings (each case id, the kind, and the case id it names). Counts, never rates.

| Exit code | `attacks.sh` |
|---|---|
| 0 | Every case decided by code held, and every control held |
| 1 | One did not; the table lists it |
| 2 | Could not run: the identity secrets, the stack's network or the service to stop missing; the run name used already; the cases file not well formed; `riley.reviewer` unable to sign in, or the case list not readable as that person; (without `--fault`) not a fresh stack; Compose failing to stop the service, or to start it again; or a request to the client failing outright during a case, with the results so far kept |

## The rubrics

| Rubric | The judge returns | Scored as |
|---|---|---|
| `answers-question` (the default) | `answers`: `yes` (the reply answers what the question asks, and nothing in it is contradicted by the reference), `partly` (it answers part of what was asked) or `no`; `contradicts`: whether the reply states something the reference contradicts; `coverage`: `all`, `some` or `none` of the reference's facts appear in the reply; one sentence of reason | The share with `answers: yes` and `contradicts: false` ("answers the question, uncontradicted"), the share that contradicts, and the three coverage shares; each overall and by question type. The paired comparison uses the first |
| `completeness` | `verdict`: `correct` (every fact of the reference given, none contradicted), `partly_correct` or `incorrect`; one sentence of reason | The three shares, overall and by question type. The paired comparison uses "correct" |

A run folder may hold judgments in files that name no rubric, `judgments.jsonl`, `judge.json` and perhaps `judge-check.csv`: they are read as the completeness rubric's for as long as `judgments-completeness.jsonl` (or `judge-check-completeness.csv`) does not exist. They are never rewritten or deleted; `judge.sh --rubric completeness` carries the old judgments over into the new file and asks only about questions they do not cover.

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
├── attacks/cases.json            committed: the synthetic attack, control and fault cases
└── data/                         never committed (.gitignore), never in an image (.dockerignore): it holds text
    ├── sample.jsonl              the sampled questions, with their answers and references
    ├── sample-reworded.jsonl     the reworded variant: each question with its text, whether it was reworded, and why not
    ├── sample-reworded.json      the rewriter, its model and effort, the instructions' hashes, the sample's and the
    │                             file's SHA-256, the counts and the wording overlap before and after
    ├── reword-check.csv          original and reworded pairs for a person to read
    ├── attacks/<run-name>/
    │   ├── results.jsonl         one line per attack, control or fault case: the verdict, the failed expectations, the
    │   │                         claim findings, each run as the person received it, and each run's trace
    │   └── victim.json           the victim's inquiry, its run and the case it opened
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
                                  files that name no rubric: read as the completeness rubric's (above)
```

## Reading the table

The client's lab explorer (`/lab/evaluation`, see [client/README.md](../client/README.md)) shows each run's figures from these files, under the same names, with no question, answer, reply or reason.

Every share is printed as `numerator of denominator = share [low, high]`: the interval is the 95% Wilson score interval. A share over fewer than 20 items is marked "too few to read". Two runs differ on a measure only as far as `compare.sh`'s sign test says: the two middle counts (only A right, only B right) are what it weighs; questions both got right or both got wrong say nothing about which run is better. With 250 questions, a difference of a few points on a share is within the interval.

The wording overlap of a question is the share of its content words found in the benchmark passage it was written from (the definition is in the architecture document). `score.sh` splits the answerable questions into thirds at the sample's own cut points, which it prints; a tie at a cut point falls to the lower third, so the thirds need not be the same size, and each third's size is printed. A question with no content words is in no third, and counted. `compare.sh` splits both runs by run A's thirds.

## Tests

`evaluation/test/` holds one test per invariant of the architecture document's "Always true", `evaluation 1` to `evaluation 14`, run by `toolchain/check.sh` with everything else; the judge and rewriter half of 3 (a constant in `judge.sh` and `reword.sh`) and the git and image half of 9 (`.gitignore`, `.dockerignore`) have none. The runner is given an in-memory agent (a fetch function, `evaluation/test/support.ts`); the model calls go through `evaluation/judge/call-all.sh` to one labelled stand-in adapter (`evaluation/test/stand-in-adapter.sh`). All text in them is invented. The attack judge is given plain values, and the set's reader the committed `evaluation/attacks/cases.json` (`attacks.test.ts`); the attack runner and `attacks.sh` have no test: they are shown by running them on a trial stack.
