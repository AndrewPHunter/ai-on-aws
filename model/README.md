# Model server

Three vLLM processes share one GPU, an NVIDIA card or an Apple silicon Mac's, each serving one model behind an OpenAI-compatible API and the same required API key: the chat model (with tool calling), an embedding model and a reranker. How it is put together is in [docs/architecture/model-server.md](../docs/architecture/model-server.md).

Every command on this page is run from the root of the repository, unless its section says otherwise.

Setup takes one of two toolchains from the machine it runs on: on Linux, or with `--host`, the servers run in Docker containers on a machine with an NVIDIA GPU; on an Apple silicon Mac without `--host`, they run on the Mac itself with vLLM-Metal ([On an Apple silicon Mac](#on-an-apple-silicon-mac)). On any other machine setup stops with exit 3. No flag chooses the toolchain.

## What you need

On an NVIDIA machine:

- A machine with one NVIDIA GPU with at least 14,590 MiB of memory free. vLLM v0.34.0 needs driver 580 or newer and a GPU of compute capability 7.5 or newer.
- Docker with Compose and the NVIDIA Container Toolkit on that machine.
- Disk on that machine: 37,000 MiB in Docker's storage for the vLLM image, and in the cache directory 11,000 MiB of weights for the 9B chat model or 5,400 MiB for the 4B, 1,200 MiB for the embedding model and 2,300 MiB for the reranker (the figures in `model/tiers.json`). Setup checks there is room for whichever of these is not already there.
- Nothing else. Setup needs only a shell and Docker; every tool it uses runs in a container.

On an Apple silicon Mac:

- macOS 15 or newer and at least 23,812 MiB of memory (the `medium` tier's need in `model/metal/tiers.json`). Setup checks the total memory, not what is free: with other programs holding memory a server can still fail to start, and setup then stops with exit 1.
- Docker Desktop: setup's tool and the gate run in containers, and the lab's containers reach the servers at `host.docker.internal`.
- `uv`, `git` and `curl` on `PATH`. Setup installs none of them. `uv` builds the servers' Python environment, `git` fetches the two packages the environment takes from git commits, and `curl` checks the ports are free and reads each server's `/health`.
- Disk in the cache directory: 4,200 MiB for the Python environment together with `uv`'s package cache beside it, and 3,000 MiB of weights for the chat model, 1,200 MiB for the embedding model and 700 MiB for the reranker (the figures in `model/metal/tiers.json`). Setup checks there is room for whichever of these is not already there.

## Set it up

On the GPU machine, from a clone of this repository:

```bash
model/setup.sh --cache-dir <directory>
```

`<directory>` is an existing directory, given as an absolute path, where the model weights are kept. There is no default: weights are large, and where they go is yours to choose.

Setup then:

1. checks the GPU, its driver and its free memory;
2. selects the largest tier that fits (see below);
3. checks the disk space that tier needs;
4. writes `model/.env` with a new API key;
5. downloads the weights of the chat model, the embedding model and the reranker;
6. starts the chat server, and confirms from its start-up log that it has room for the tier's number of requests;
7. starts the embedding server, and confirms from its start-up log that it has room for one input of the longest length it accepts;
8. starts the reranker server;
9. runs the gate on all three, and reports success only if the gate passes.

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

## On an Apple silicon Mac

From a clone of this repository on the Mac:

```bash
model/setup.sh --cache-dir <directory>
```

`<directory>` is an existing directory you can write to, given as an absolute path. It holds everything setup puts on the Mac: the servers' Python environment (`<directory>/vllm-metal/venv`, with `uv`'s cache and the Python it installs beside it), the weights (`<directory>/hf`), and the servers' logs and pid files (`<directory>/vllm-metal/run`).

Setup then:

1. checks that `uv`, `git` and `curl` are on `PATH`; that none of the lab's servers is running, looking for their processes under any cache directory; and that the three ports are free (a connection to each on `127.0.0.1` is refused);
2. checks the macOS version and the total memory against the tier;
3. checks that the cache directory is writable and that its volume has room;
4. writes `model/.env` with a new API key;
5. installs the Python environment from `model/metal/requirements.txt` with `uv`, unless the environment was installed from that same lock;
6. downloads the weights of the chat model, the embedding model and the reranker;
7. starts the chat server, then the embedding server, then the reranker, each confirmed healthy before the next, with the same capacity checks as on NVIDIA;
8. runs the gate on all three, and reports success only if the gate passes.

The servers listen on `127.0.0.1` only: chat on port 8100, the embedding model on 8101, the reranker on 8102 (the lab publishes 8000 to 8002 on the Mac). `model/.env` gives their addresses as `http://host.docker.internal:<port>/v1`, the name by which the lab's containers reach the Mac. If the Mac is on battery power, setup says so and continues; the gate measures speed.

Each server is the leader of its own process group and runs with exactly this environment, and nothing else of your shell's: `VLLM_API_KEY` (the key, never on a command line); `PATH` (the environment's `bin`, then `/usr/bin:/bin:/usr/sbin:/sbin`); `HOME=<directory>/vllm-metal/home`; `HF_HOME=<directory>/hf`; `HF_HUB_OFFLINE=1` (no access to the Hugging Face hub); `HF_HUB_DISABLE_TELEMETRY=1`; `HF_HUB_DISABLE_IMPLICIT_TOKEN=1`; `VLLM_NO_USAGE_STATS=1`; `DO_NOT_TRACK=1`; and, for the embedding and reranker servers only, `VLLM_ENABLE_V1_MULTIPROCESSING=0`. No Hugging Face token reaches it.

### Stop, start, status and logs

`model/metal/servers.sh` starts and stops the servers. It reads `model/.env`, the profile and `model/metal/retrieval.env`.

```bash
model/metal/servers.sh status
model/metal/servers.sh stop                                        # all three: reranker, embedding, chat
model/metal/servers.sh start metal-qwen3.5-4b-mlx-4bit             # all three: chat first, the others once it answers /health
model/metal/servers.sh stop rerank
model/metal/servers.sh start metal-qwen3.5-4b-mlx-4bit rerank
```

`stop` ends each server's process group and waits until it has no member; a server whose first process has ended while others of its group are alive still counts as running. If a server's processes survive `SIGKILL`, `stop` says so, stops the others and exits 1. `start` refuses a server that is already running. A server's log is `<directory>/vllm-metal/run/<server>.log` (`chat`, `embed`, `rerank`), written again at each start; its pid file is beside it. The servers are not started again when the Mac restarts: start them with the command above.

### The Python environment

`model/metal/requirements.in` names the environment: the vLLM v0.34.0 and vLLM-Metal v0.34.0 release wheels, each with its sha256, and the PyTorch nightly build the vLLM-Metal wheel names (`vllm_metal/requirements-torch.txt`), as wheel URLs on PyTorch's index. That build replaces the torch, torchvision and torchaudio vLLM core asks for. `model/metal/requirements.txt` is the lock compiled from it: every package at one version; each package from an index or a URL checked against its checksum (the sha256 of each of its files); and two packages (`mlx-lm`, `mlx-vlm`) built at install time from pinned git commits, by tools that are not in the lock. Setup installs only the lock, with `uv pip install --no-deps --verify-hashes`, into an environment made with `uv venv --python 3.12.15`, and writes the lock's sha256 into the environment. An environment whose stamp equals the lock's sha256 is left as it is; any other, an empty or damaged stamp included, is removed and installed again.

To regenerate the lock after changing `requirements.in` (in a container with network access; it also does a dry run of setup's install for the Mac's platform before replacing the lock):

```bash
model/metal/lock.sh
```

### The reranker's template

vLLM-Metal serves the Qwen3 reranker (`mku64/Qwen3-Reranker-0.6B-mlx-8Bit`) as a sequence classifier, with model overrides and a prompt template. `model/metal/qwen3_reranker.jinja` is vLLM's own file `examples/pooling/score/template/qwen3_reranker.jinja` at tag `v0.34.0`, copied byte for byte (685 bytes, sha256 `e1ee98e69aab7b2da366edf1c50efcef37e34b4a0c50fb816336213e68d9047a`), under vLLM's licence, Apache-2.0. Every character is part of the prompt, so it carries no comment. Without it the reranker answers but ranks wrongly.

## Flags

| Flag | Meaning |
|---|---|
| `--cache-dir <directory>` | Where the weights are kept on the GPU machine (on a Mac, everything setup puts there): an absolute path with no white space, quote, `#`, `$` or backslash. Required, unless `--keep-env`. |
| `--bind <address>` | IPv4 address the servers are published on. Default `127.0.0.1`. Required with `--host`, where it may not be a loopback address. Refused on an Apple silicon Mac, where the servers listen on `127.0.0.1` only. |
| `--port <n>` | Port of the chat server. Default `8000`; `8100` on a Mac. |
| `--embed-port <n>` | Port of the embedding server. Default `8001`; `8101` on a Mac. |
| `--rerank-port <n>` | Port of the reranker server. Default `8002`; `8102` on a Mac. |
| `--host <docker-host>` | Docker address of the GPU machine, when it is not the machine setup runs on. Given on a Mac, it sets up that NVIDIA machine. |
| `--tier <name>` | Use `large`, `medium` or `small` instead of the largest that fits. It must still fit. On a Mac the one tier is `medium`, and no other name is accepted. |
| `--check` | Run the checks and the selection, print the result, change nothing. An existing `model/.env` does not stop it. |
| `--keep-env` | Use the existing `model/.env` as it is, key included. `--cache-dir`, `--bind`, `--port`, `--embed-port` and `--rerank-port` are then not accepted, and the address in the file is not checked again, with `--host` included. |

The three ports must differ, and setup refuses two that are equal. For that reason `--port 8001` given alone is refused on an NVIDIA machine: 8001 is the embedding server's default. On a Mac a port something already listens on is refused too, before anything is written.

Setup refuses to run if `DOCKER_HOST`, or any variable whose name starts with `MODEL_`, `CHAT_`, `EMBED_`, `RERANK_` or `COMPOSE_`, is set in your shell: such a variable would silently change what is started.

## What clients read

Setup writes these to `model/.env`, beside the address, the cache directory and the user the servers run as (`MODEL_RUN_UID`, `MODEL_RUN_GID`: on an NVIDIA machine the cache directory's owner, on a Mac the user who ran setup):

| Variable | Meaning |
|---|---|
| `MODEL_TOOLCHAIN` | `nvidia` or `metal` |
| `MODEL_RETRIEVAL_ENV` | The retrieval settings file the servers were started from, as a path under `model/`: `retrieval.env` or `metal/retrieval.env`. The lab's retrieval service reads that file. |
| `MODEL_API_KEY` | The key all three servers require, sent as a bearer token |
| `MODEL_BASE_URL` | The chat server: `http://<address>:<port>/v1`; on a Mac `http://host.docker.internal:<port>/v1` |
| `MODEL_EMBED_BASE_URL` | The embedding server: `http://<address>:<embed port>/v1`, serving `/embeddings` |
| `MODEL_RERANK_BASE_URL` | The reranker server: `http://<address>:<rerank port>/v1`, serving `/rerank` |
| `MODEL_PORT`, `MODEL_EMBED_PORT`, `MODEL_RERANK_PORT` | The three ports |

The names of the embedding model and the reranker, the embedding model's number of dimensions and the longest input each accepts are in the retrieval settings, `model/retrieval.env` or on a Mac `model/metal/retrieval.env`: `EMBED_MODEL_ID`, `EMBED_DIMENSIONS`, `EMBED_MAX_MODEL_LEN`, `RERANK_MODEL_ID`, `RERANK_MAX_MODEL_LEN`. The embedding model is the same in both files, so an index built with one toolchain is searched with the other. The knowledge piece also reads `EMBED_MODEL_REPO` and `EMBED_MODEL_REVISION` from it: with `EMBED_DIMENSIONS` they are the identity of its vectors, and its retrieval service refuses to use vectors made with another (`knowledge/README.md`).

## Tiers

A tier is a chat model and its settings, with the GPU memory it needs free. The embedding model and the reranker are the same on every tier; their settings are in `model/retrieval.env`. A tier's need is a sum: the chat server's peak memory, the embedding server's (2,964 MiB), the reranker server's (1,882 MiB) and a margin of 512 MiB. The figures are in `model/tiers.json`, and all of them come from one card, an NVIDIA RTX 3090 Ti with 24 GiB: the `medium` and `small` tiers are sized from it, not from a smaller card.

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

On an Apple silicon Mac there is one tier, in `model/metal/tiers.json`. Its need is the peak memory of the three servers together, 23,300 MiB, plus a margin of 512 MiB, compared with the Mac's total memory:

| Tier | Chat model | Context | Requests at once | Needs in total |
|---|---|---|---|---|
| `medium` | Qwen3.5-4B, MLX 4-bit (`mlx-community/Qwen3.5-4B-4bit`) | 32,768 tokens | 4 | 23,812 MiB |

Beside it, in `model/metal/retrieval.env`:

| Server | Model (name clients use) | Longest input | Notes |
|---|---|---|---|
| embedding | Qwen3-Embedding-0.6B (`qwen3-embedding-0.6b`) | 8,192 tokens | the same model, revision, served name, dimensions and longest input as on NVIDIA |
| reranker | Qwen3-Reranker-0.6B, MLX 8-bit (`qwen3-reranker-0.6b`) | 8,192 tokens | vLLM-Metal cannot serve bge-reranker-v2-m3 |

## Exit codes

| Exit | Meaning | Left behind |
|---|---|---|
| 0 | The three servers are running and passed the gate. With `--check`: the machine would get the tier printed. | `model/.env`, `model/gate-report.json`, the servers. With `--check`: nothing written, nothing started |
| 1 | On a Mac the Python environment could not be installed; a download failed; or a server started but was not shown fit. | `model/.env`; every server that started is stopped, its container (on a Mac, its log file) kept so its log can be read |
| 2 | Setup could not run: a bad flag; a variable named under Flags set in the shell; Docker not reachable; `model/.env` already there (without `--keep-env` or `--check`), or missing or incomplete with `--keep-env`, or recording the other toolchain; one of the lab's servers already running; the cache directory missing (on a Mac, or not writable); on a Mac `uv`, `git` or `curl` missing, or a port taken; the pinned Node image not runnable on the GPU machine; output of `nvidia-smi`, `sw_vers`, `sysctl` or of the disk probe not understood; a file of `model/` not as expected; `model/.env` or the old gate report not writable; or setup's own tool failing. | No server that setup started is left running; one found running already is left as it was. `model/.env` only if the failure came after it was written |
| 3 | The machine is not supported or is too small: neither Linux nor an Apple silicon Mac (without `--host`); no GPU, more than one, a driver or GPU too old, too little free GPU memory; on a Mac a macOS version below 15 or too little total memory; or too little disk. | Nothing written, nothing started |

## Running it again

- `model/.env` is never overwritten. To keep the same key and settings, pass `--keep-env`; to start over, delete the file. On a Mac, stop the servers first (`model/metal/servers.sh stop`): it finds them through `model/.env`.
- With `--keep-env` the toolchain `model/.env` records (`MODEL_TOOLCHAIN`) must be the one setup takes from the machine; otherwise setup stops and names both. A `model/.env` without `MODEL_TOOLCHAIN` and `MODEL_RETRIEVAL_ENV` is read as an NVIDIA machine's with `retrieval.env`.
- With a `model/.env` that lacks a variable setup writes, such as `MODEL_EMBED_PORT`, `MODEL_RERANK_PORT`, `MODEL_EMBED_BASE_URL` or `MODEL_RERANK_BASE_URL`, `--keep-env` stops and names what is missing. Delete the file and set up again. That writes a new key, so the agents must then be recreated to read it (`docker compose up -d --force-recreate` from the root of the repository).
- Setup stops if any of the lab's three servers is already running, because its memory would make the card look smaller than it is, and names the ones running. Stop them first:

  ```bash
  docker compose -p ai-on-aws-model stop
  ```

  With `--host`, put `DOCKER_HOST=<docker-host>` in front of that command. On a Mac the command is `model/metal/servers.sh stop`. Setup prints the exact command.

## Restarting

- Any one of the three servers can be restarted on its own with `docker restart <container>` while the other two run. Each gives vLLM an explicit start-up share of the card (`--gpu-memory-utilization 0.05`: in `CHAT_EXTRA_ARGS` in each profile, and in `model/retrieval.env`). Without it vLLM asks for 92% of the card to be free, and with the other two servers running it never is.
- `docker compose ... up -d chat embed rerank` (the command under [By hand](#by-hand)) starts them in order: the embedding and reranker servers wait until the chat server reports healthy.
- Setting up again needs all three stopped first (see above).

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

Thresholds are in `model/gate/gate.config.json`. They and the fixed set of queries are chosen, not measured, and they are the same for every tier: 20 rounds of 4 tool-calling conversations with at least 95% correct and no server fault; 4 prompts of at least 14,000 tokens at once; vectors of unit length within 0.001; the answering passage first in at least 90% of the fixed set, for the embedding server and for the reranker; 4 batches of 32 inputs, and 4 reranker requests, at once. Each request may take 180 seconds. The report has the sections `auth`, `toolCalling` and `context` for the chat server, `embedding` and `reranker`, and its `failures` names each check that failed.

Setup runs it for you. To run it yourself, from `model/gate/`, on any machine that can reach the servers:

```bash
docker compose --env-file ../.env --env-file ../profiles/qwen3.5-9b-w4a16.env --env-file ../retrieval.env run --rm gate
```

When the servers are published on a loopback address of the machine the gate runs on, add the override that puts the gate on the host's network, as setup does:

```bash
docker compose -f compose.yaml -f compose.host-network.yaml --env-file ../.env --env-file ../profiles/qwen3.5-9b-w4a16.env --env-file ../retrieval.env run --rm gate
```

It prints a JSON report and exits 0 on a pass, 1 if a check failed, and 2 if it could not run: a setting missing, a server that does not answer, a model list not answered with 200 to the right key, a chat server that reports no token usage, or any other error of its own.

## Known limits

- The Metal toolchain has one tier, `medium`; setup on a Mac selects it or stops.
- On a Mac the machine check compares the tier's need with the total memory, not the free memory; a server that cannot get its memory fails at start-up (exit 1).
- The Metal servers are not started again after the Mac restarts.
- The PyTorch build of the Metal environment is a dated nightly on PyTorch's index. When the index stops serving it, the install fails naming the package.
- The two packages built from git commits (`mlx-lm`, `mlx-vlm`) are built at install time; the build tools `uv` fetches for them are not in the lock.
- `uv` and the Hugging Face downloads run with only the settings setup gives them, so a proxy set in the shell does not reach them.

## Tests

The tests assert the invariants in [docs/architecture/model-server.md](../docs/architecture/model-server.md), one test each, where a test can show one (1, for the embedding and reranker servers' key checks, 2, 4, 5, 8, 9, 11 to 15, 17 and 18). Two probes, P1 and P2, show that the shipped tiers, profiles and retrieval settings of both toolchains read, that they and `model/.env.example` name every variable `compose.yaml` uses, and that every setting `model/metal/servers.sh` reads is in the file it reads it from. They run in a container, with no GPU and no network:

```bash
sh model/setup/run-tests.sh
```
