# Model server

Three vLLM processes share one NVIDIA GPU, each serving one model behind an OpenAI-compatible API and the same required API key: the chat model (with tool calling), an embedding model and a reranker. How it is put together is in [docs/architecture/model-server.md](../docs/architecture/model-server.md).

Every command on this page is run from the root of the repository, unless its section says otherwise.

## What you need

- A machine with one NVIDIA GPU with at least 14,590 MiB of memory free. vLLM v0.34.0 needs driver 580 or newer and a GPU of compute capability 7.5 or newer.
- Docker with Compose and the NVIDIA Container Toolkit on that machine.
- Disk on that machine: 37,000 MiB in Docker's storage for the vLLM image, and in the cache directory 11,000 MiB of weights for the 9B chat model or 5,400 MiB for the 4B, 1,200 MiB for the embedding model and 2,300 MiB for the reranker (the figures in `model/tiers.json`). Setup checks there is room for whichever of these is not already there.
- Nothing else. Setup needs only a shell and Docker; every tool it uses runs in a container.

## Set it up

On the GPU machine, from a clone of this repository:

```bash
model/setup.sh --cache-dir <directory>
```

`<directory>` is an existing directory, given as an absolute path, where the model weights are kept. There is no default: weights are large, and where they go is yours to choose.

Setup then:

1. checks the GPU, its driver and its free memory, and the disk space;
2. selects the largest tier that fits (see below);
3. writes `model/.env` with a new API key;
4. downloads the weights of the chat model, the embedding model and the reranker;
5. starts the chat server, and confirms from its start-up log that it has room for the tier's number of requests;
6. starts the embedding server, and confirms from its start-up log that it has room for one input of the longest length it accepts;
7. starts the reranker server;
8. runs the gate on all three, and reports success only if the gate passes.

Setup waits at most 900 seconds for each server to report healthy. The embedding and reranker servers start after the chat server is healthy. Each of the three checks at start-up that a set share of the card is free, and the two smaller servers make that check with the chat server's memory already in use.

To see what it would select without changing anything:

```bash
model/setup.sh --check --cache-dir <directory>
```

Unless you say otherwise, the servers are published on `127.0.0.1`: chat on port 8000, the embedding model on 8001, the reranker on 8002.

The lab's agents and its knowledge piece run in containers and reach the servers from the lab's network, where `127.0.0.1` is the container itself: a server published on a loopback address is not reachable from them. On a machine that also runs the lab, the defaults also take the ports the lab publishes on `127.0.0.1` (the case system's 8000 and 8001, the retrieval service's 8002). For the lab, publish the servers with `--bind` on an address its containers can reach.

## From another machine

To run setup on one machine and the servers on another, give the GPU machine's Docker address and the address the servers should be published on:

```bash
model/setup.sh --host ssh://<user>@<gpu-machine> --bind <address> --cache-dir <directory>
```

`<directory>` is then a directory on the GPU machine. Nothing from this repository needs to be on the GPU machine. The machine you run setup from also needs Docker.

## Flags

| Flag | Meaning |
|---|---|
| `--cache-dir <directory>` | Where the weights are kept on the GPU machine: an absolute path with no white space, quote, `#`, `$` or backslash. Required, unless `--keep-env`. |
| `--bind <address>` | IPv4 address the servers are published on. Default `127.0.0.1`. Required with `--host`, where it may not be a loopback address. |
| `--port <n>` | Port the chat server is published on. Default `8000`. |
| `--embed-port <n>` | Port the embedding server is published on. Default `8001`. |
| `--rerank-port <n>` | Port the reranker server is published on. Default `8002`. |
| `--host <docker-host>` | Docker address of the GPU machine, when it is not the machine setup runs on. |
| `--tier <name>` | Use `large`, `medium` or `small` instead of the largest that fits. It must still fit. |
| `--check` | Run the checks and the selection, print the result, change nothing. An existing `model/.env` does not stop it. |
| `--keep-env` | Use the existing `model/.env` as it is, key included. `--cache-dir`, `--bind`, `--port`, `--embed-port` and `--rerank-port` are then not accepted. |

The three ports must differ, and setup refuses two that are equal. For that reason `--port 8001` given alone is refused: 8001 is the embedding server's default.

Setup refuses to run if `DOCKER_HOST`, or any variable whose name starts with `MODEL_`, `CHAT_`, `EMBED_`, `RERANK_` or `COMPOSE_`, is set in your shell: such a variable would silently change what is started.

## What clients read

Setup writes these to `model/.env`, beside the address, cache directory and user:

| Variable | Meaning |
|---|---|
| `MODEL_API_KEY` | The key all three servers require, sent as a bearer token |
| `MODEL_BASE_URL` | The chat server: `http://<address>:<port>/v1` |
| `MODEL_EMBED_BASE_URL` | The embedding server: `http://<address>:<embed port>/v1`, serving `/embeddings` |
| `MODEL_RERANK_BASE_URL` | The reranker server: `http://<address>:<rerank port>/v1`, serving `/rerank` |
| `MODEL_PORT`, `MODEL_EMBED_PORT`, `MODEL_RERANK_PORT` | The three ports |

The names of the embedding model and the reranker, the embedding model's number of dimensions and the longest input each accepts are in `model/retrieval.env`: `EMBED_MODEL_ID`, `EMBED_DIMENSIONS`, `EMBED_MAX_MODEL_LEN`, `RERANK_MODEL_ID`, `RERANK_MAX_MODEL_LEN`. The knowledge piece also reads `EMBED_MODEL_REPO` and `EMBED_MODEL_REVISION` from it: with `EMBED_DIMENSIONS` they are the identity of its vectors, and its retrieval service refuses to use vectors made with another (`knowledge/README.md`).

## Tiers

A tier is a chat model and settings that passed the gate, with the GPU memory it needs free. The embedding model and the reranker are the same on every tier; their settings are in `model/retrieval.env`. A tier's need is derived: the chat model's peak measured in the gate, plus the embedding server's peak (2,964 MiB, measured after setup's gate), plus the reranker server's peak (1,882 MiB, measured by hand with the largest passages; the gate's smaller requests reached 1,702 MiB), plus a margin of 512 MiB. The figures are in `model/tiers.json`.

| Tier | Chat model | Context | Requests at once | Needs free |
|---|---|---|---|---|
| `large` | Qwen3.5-9B, 4-bit | 32,768 tokens | 4 | 21,492 MiB |
| `medium` | Qwen3.5-4B, 4-bit | 32,768 tokens | 4 | 16,138 MiB |
| `small` | Qwen3.5-4B, 4-bit | 20,480 tokens | 4 | 14,590 MiB |

Beside every tier:

| Server | Model (name clients use) | Longest input | Notes |
|---|---|---|---|
| embedding | Qwen3-Embedding-0.6B (`qwen3-embedding-0.6b`) | 8,192 tokens | vectors of 1,024 numbers; a longer input is refused, not truncated |
| reranker | bge-reranker-v2-m3 (`bge-reranker-v2-m3`) | 8,192 tokens | a longer document is refused unless the request sends `max_tokens_per_doc` |

Setup selects on the memory that is free when it runs, not on the size of the card. If nothing fits it stops and says how much is short; it never starts a tier that does not fit.

## Exit codes

| Exit | Meaning | Left behind |
|---|---|---|
| 0 | The three servers are running and passed the gate. | `model/.env`, `model/gate-report.json`, the servers |
| 1 | A download failed, or a server started but was not shown fit. | `model/.env`; every server that started is stopped, its container kept so its log can be read |
| 2 | Setup could not run: a bad flag; a variable named under Flags set in the shell; Docker not reachable; `model/.env` already there (without `--keep-env` or `--check`), or missing or incomplete with `--keep-env`; one of the lab's servers already running; the cache directory missing; the pinned Node image not runnable on the GPU machine; output of `nvidia-smi` or of the disk probe not understood; a file of `model/` not as expected; `model/.env` or the old gate report not writable; or setup's own tool failing. | No server left running. `model/.env` only if the failure came after it was written |
| 3 | The machine is not supported or is too small: no GPU, more than one, a driver or GPU too old, too little free GPU memory, or too little disk. | Nothing written, nothing started |

## Running it again

- `model/.env` is never overwritten. To keep the same key and settings, pass `--keep-env`; to start over, delete the file.
- A `model/.env` written before the embedding and reranker servers were added lacks `MODEL_EMBED_PORT`, `MODEL_RERANK_PORT`, `MODEL_EMBED_BASE_URL` and `MODEL_RERANK_BASE_URL`, so `--keep-env` stops and names what is missing. Delete the file and set up again. That writes a new key, so the agents must then be recreated to read it (`docker compose up -d --force-recreate` from the root of the repository).
- Setup stops if any of the lab's three servers is already running, because its memory would make the card look smaller than it is, and names the ones running. Stop them first:

  ```bash
  docker compose -p ai-on-aws-model stop
  ```

  With `--host`, put `DOCKER_HOST=<docker-host>` in front of that command. Setup prints the exact command.

## Restarting

- Any one of the three servers can be restarted on its own with `docker restart <container>` while the other two run. Each gives vLLM an explicit start-up share of the card (`--gpu-memory-utilization 0.05`: in `CHAT_EXTRA_ARGS` in each profile, and in `model/retrieval.env`). Without it vLLM asks for 92% of the card to be free, and with the other two servers running it never is.
- `docker compose ... up -d chat embed rerank` (the command under [By hand](#by-hand)) starts them in order: the embedding and reranker servers wait until the chat server reports healthy.
- Setting up again needs all three stopped first (see above).

## What was measured

Only this hardware has been measured; nothing else is claimed to work.

- NVIDIA RTX 3090 Ti (24 GiB), driver 595, NVIDIA Container Toolkit 1.20
- Docker 29 with Compose, on Ubuntu 24.04
- vLLM v0.34.0 (image pinned by digest)

On it:

- Each of the three chat profiles passed the gate on its own, serving 4 requests at once. Each profile records its results at the top of its file in `model/profiles/`.
- Before the embedding and reranker servers were added, `model/setup.sh` with the chat server alone was run on the GPU machine itself, from a second machine with `--host`, and with `--tier small` and `--keep-env`. Each run ended with the gate passing.

With the three servers, on 2026-11-21, from a second machine with `--host`, `large` tier (setup and its gate did the measuring unless a line says otherwise):

1. With the chat server already running, `model/setup.sh --check` refused and named the chat server.
2. `model/setup.sh --host ... --bind ... --cache-dir ...` exited 0 in 5 min 53 s. The weights of all three models were already in the cache, so the downloader skipped each download. The chat server's start-up line showed room for 4.06 requests of 32,768 tokens; the embedding server's, read from its log by setup, room for 1.14 inputs of 8,192 tokens (a cache of 9,344 tokens). The gate passed with no failures:
   - chat: 80 of 80 tool-calling conversations correct;
   - embedding: 178 vectors, none of the wrong length and none off unit length; the answering passage first in 10 of 10 queries; an input over the limit refused with 400; 4 of 4 batches sent at once answered;
   - reranker: the answering passage first in 10 of 10 queries; a document over the limit refused with 400, and accepted with `max_tokens_per_doc`; 4 of 4 requests sent at once answered.
3. GPU memory after that gate: chat 16,230 MiB, embedding 2,964 MiB, reranker 1,702 MiB; 20,932 MiB in use, 3,182 MiB free.
4. The chat container, restarted on its own with the other two running, exited: vLLM found 18.62 of 23.55 GiB free, less than its default start-up share of 0.92 (21.66 GiB). As first built, the chat server could not restart on its own.
5. Each profile's `CHAT_EXTRA_ARGS` was then given `--gpu-memory-utilization 0.05`. With the cache fixed in bytes the share sizes nothing; it is only vLLM's start-up check.
6. With the servers stopped, `model/setup.sh --host ... --keep-env`, run against the `model/.env` the first run wrote, exited 0 in 5 min 9 s with the key kept. The gate passed again with the same figures.
7. The chat container restarted on its own was healthy in about 50 s beside the other two. vLLM found 18.65 GiB free and built the same cache (133,152 tokens, 4.06 requests of 32,768 tokens). GPU memory then: chat 15,674 MiB, embedding 2,932 MiB, reranker 1,702 MiB.

Measured by hand on the same card before setup ran them, with each server started with the flags in `model/retrieval.env` beside the `large` chat tier: the embedding server's peak of 2,960 MiB while embedding 4,000 passages in batches of 32; the reranker server's peak of 1,882 MiB with 20 of the largest passages in one request, the figure `model/tiers.json` uses; an input over the embedding limit is refused, never truncated, and a batch holding one is refused as a whole; a `dimensions` field is refused. These figures are also at the top of `model/retrieval.env`.

Not run:

- The download of the embedding model and the reranker through setup: their weights were already in the cache. No run has been made on a machine where the weights or the vLLM image were not already present.
- Any card but the one above. The `medium` and `small` tiers are meant for cards with less memory; no run has been made on a 16 GiB or 12 GiB card.
- Setup and the gate with the three servers on the `medium` and `small` tiers.

The gate's thresholds for the embedding and reranker servers, and its fixed set of queries, are chosen, not measured.

## By hand

Setup automates these steps. To do them yourself, from `model/` on the GPU machine. Every command passes the same three files: `.env`, a profile and `retrieval.env`.

1. Copy `.env.example` to `.env` and fill it in.
2. Download the pinned revisions of the profile's chat model, the embedding model and the reranker:

   ```bash
   docker compose --env-file .env --env-file profiles/qwen3.5-9b-w4a16.env --env-file retrieval.env --profile download run --rm download
   docker compose --env-file .env --env-file profiles/qwen3.5-9b-w4a16.env --env-file retrieval.env --profile download run --rm download-embed
   docker compose --env-file .env --env-file profiles/qwen3.5-9b-w4a16.env --env-file retrieval.env --profile download run --rm download-rerank
   ```

3. Start the three servers and wait for them to report healthy (a few minutes). Compose starts the embedding and reranker servers once the chat server reports healthy:

   ```bash
   docker compose --env-file .env --env-file profiles/qwen3.5-9b-w4a16.env --env-file retrieval.env up -d chat embed rerank
   ```

## The gate

The gate is a script that decides whether the running servers are fit for the lab. All the text it sends is synthetic.

- Chat: no key and a wrong key are rejected and the right key accepted; the model is listed; tool calling works under concurrent load; and several long prompts are answered correctly at once.
- Embedding: no key and a wrong key are rejected and the right key accepted; the model is listed; every vector has the configured number of dimensions and unit length within a tolerance; for a fixed set of queries, each with one passage that answers it and several that do not, the answering passage is the most similar in at least the configured share; an input over the limit is refused; several batches sent at once are all answered.
- Reranker: the same key checks; the model is listed; for the same set, the answering passage is ranked first in at least the configured share; a document over the limit is refused, and accepted with `max_tokens_per_doc`; several requests sent at once are all answered.

Thresholds are in `model/gate/gate.config.json`, and they are the same for every tier: 20 rounds of 4 tool-calling conversations with at least 95% correct and no server fault; 4 prompts of at least 14,000 tokens at once; vectors of unit length within 0.001; the answering passage first in at least 90% of the fixed set, for the embedding server and for the reranker; 4 batches of 32 inputs, and 4 reranker requests, at once. Each request may take 180 seconds. The report has a section for each server and names each check that failed.

Setup runs it for you. To run it yourself, from `model/gate/`, on any machine that can reach the servers:

```bash
docker compose --env-file ../.env --env-file ../profiles/qwen3.5-9b-w4a16.env --env-file ../retrieval.env run --rm gate
```

When the servers are published on a loopback address of the machine the gate runs on, add the override that puts the gate on the host's network, as setup does:

```bash
docker compose -f compose.yaml -f compose.host-network.yaml --env-file ../.env --env-file ../profiles/qwen3.5-9b-w4a16.env --env-file ../retrieval.env run --rm gate
```

It prints a JSON report and exits 0 on a pass, 1 if a check failed, and 2 if it could not run.

## Tests

The decisions setup makes (flags, selection, disk space, the text of `model/.env`, the running-server guard, the capacity checks, exit codes) and the gate's verdicts on the embedding and reranker servers are pure functions with tests. They run in a container, with no GPU and no network:

```bash
sh model/setup/run-tests.sh
```
