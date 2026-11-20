# Model server

One vLLM process serves one chat model on one NVIDIA GPU, with an OpenAI-compatible API, tool calling and a required API key. How it is put together is in [docs/architecture/model-server.md](../docs/architecture/model-server.md).

Every command on this page is run from the root of the repository, unless its section says otherwise.

## What you need

- A machine with one NVIDIA GPU with at least 11,792 MiB of memory free. vLLM v0.34.0 needs driver 580 or newer and a GPU of compute capability 7.5 or newer.
- Docker with Compose and the NVIDIA Container Toolkit on that machine.
- Disk on that machine: about 36 GB for the vLLM image, and about 11 GB of weights for the 9B model or 5 GB for the 4B.
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
4. downloads the weights and starts the server;
5. confirms from the server's own start-up log that it has room for the tier's number of requests;
6. runs the gate, and reports success only if the gate passes.

To see what it would select without changing anything:

```bash
model/setup.sh --check --cache-dir <directory>
```

The server is published on `127.0.0.1:8000` unless you say otherwise.

## From another machine

To run setup on one machine and the server on another, give the GPU machine's Docker address and the address the server should be published on:

```bash
model/setup.sh --host ssh://<user>@<gpu-machine> --bind <address> --cache-dir <directory>
```

`<directory>` is then a directory on the GPU machine. Nothing from this repository needs to be on the GPU machine. The machine you run setup from also needs Docker.

## Flags

| Flag | Meaning |
|---|---|
| `--cache-dir <directory>` | Where the weights are kept on the GPU machine. Required, unless `--keep-env`. |
| `--bind <address>` | IPv4 address the server is published on. Default `127.0.0.1`. Required with `--host`, where it may not be a loopback address. |
| `--port <n>` | Port the server is published on. Default `8000`. |
| `--host <docker-host>` | Docker address of the GPU machine, when it is not the machine setup runs on. |
| `--tier <name>` | Use `large`, `medium` or `small` instead of the largest that fits. It must still fit. |
| `--check` | Run the checks and the selection, print the result, change nothing. |
| `--keep-env` | Use the existing `model/.env` as it is, key included. `--cache-dir`, `--bind` and `--port` are then not accepted. |

Setup refuses to run if `DOCKER_HOST`, or any variable whose name starts with `MODEL_`, `CHAT_` or `COMPOSE_`, is set in your shell: such a variable would silently change what is started.

## Tiers

A tier is a model and settings that passed the gate, with the GPU memory it needs free. The need is the peak measured in the gate, plus a margin of 512 MiB, plus 2,048 MiB kept back for the other models the lab will run on the same card. The figures are in `model/tiers.json`.

| Tier | Model | Context | Requests at once | Needs free |
|---|---|---|---|---|
| `large` | Qwen3.5-9B, 4-bit | 32,768 tokens | 4 | 18,694 MiB |
| `medium` | Qwen3.5-4B, 4-bit | 32,768 tokens | 4 | 13,340 MiB |
| `small` | Qwen3.5-4B, 4-bit | 20,480 tokens | 4 | 11,792 MiB |

Setup selects on the memory that is free when it runs, not on the size of the card. If nothing fits it stops and says how much is short; it never starts a tier that does not fit.

## Exit codes

| Exit | Meaning | Left behind |
|---|---|---|
| 0 | The server is running and passed the gate. | `model/.env`, `model/gate-report.json`, the server |
| 1 | The download failed, or the server started but was not shown fit. | `model/.env`; the server stopped, its container kept so its log can be read |
| 2 | Setup could not run: a bad flag, Docker not reachable, `model/.env` already there, the server already running, a missing directory, or setup's own tool failing. | No server left running. `model/.env` only if the failure came after it was written |
| 3 | The machine is not supported or is too small. | Nothing written, nothing started |

## Running it again

- `model/.env` is never overwritten. To keep the same key and settings, pass `--keep-env`; to start over, delete the file.
- Setup stops if the lab's server is already running, because the server's own memory would make the card look smaller than it is. Stop it first:

  ```bash
  docker compose -p ai-on-aws-model stop
  ```

  With `--host`, put `DOCKER_HOST=<docker-host>` in front of that command. Setup prints the exact command.

## What was measured

Only this hardware has been measured; nothing else is claimed to work.

- NVIDIA RTX 3090 Ti (24 GiB), driver 595, NVIDIA Container Toolkit 1.20
- Docker 29 with Compose, on Ubuntu 24.04
- vLLM v0.34.0 (image pinned by digest)

On it:

- Each of the three profiles passed the gate, serving 4 requests at once. Each profile records its results at the top of its file in `model/profiles/`.
- `model/setup.sh` was run on the GPU machine itself, and from a second machine with `--host`, and with `--tier small` and `--keep-env`. Each run ended with the gate passing.
- The `medium` and `small` tiers are meant for cards with less memory, but they have only been run on the card above. No run has been made on a 16 GiB or 12 GiB card.
- No run has been made on a machine where the weights or the vLLM image were not already present, so the download through setup is not measured.

## By hand

Setup automates these steps. To do them yourself, from `model/` on the GPU machine:

1. Copy `.env.example` to `.env` and fill it in.
2. Download the pinned model revision of a profile:

   ```bash
   docker compose --env-file .env --env-file profiles/qwen3.5-9b-w4a16.env --profile download run --rm download
   ```

3. Start the server and wait for it to report healthy (a few minutes):

   ```bash
   docker compose --env-file .env --env-file profiles/qwen3.5-9b-w4a16.env up -d chat
   ```

## The gate

The gate is a script that decides whether a running server is fit for the lab. It checks that requests without the key are rejected, that tool calling works under concurrent load, and that several long prompts are answered correctly at once. Thresholds are in `model/gate/gate.config.json`, and they are the same for every tier.

Setup runs it for you. To run it yourself, from `model/gate/`, on any machine that can reach the server:

```bash
docker compose --env-file ../.env --env-file ../profiles/qwen3.5-9b-w4a16.env run --rm gate
```

It prints a JSON report and exits 0 on a pass, 1 if a check failed, and 2 if it could not run.

## Tests

The decisions setup makes (flags, selection, disk space, the text of `model/.env`, the capacity check, exit codes) are pure functions with tests. They run in a container, with no GPU and no network:

```bash
sh model/setup/run-tests.sh
```
