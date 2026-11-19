# AI on AWS: a local lab for AgentCore and Bedrock Knowledge Bases

A reproducible lab for exploring Amazon Bedrock AgentCore and a local stand-in for Bedrock Knowledge Bases, backed by a self-hosted model served with vLLM.

## Status

Under construction. One piece works today: the model server in `model/`, started by hand with the steps below. The agents, the Knowledge Bases stand-in and a one-command setup do not exist yet.

## Model server

One vLLM process serves one chat model with an OpenAI-compatible API, tool calling and a required API key. Every setting comes from two files passed explicitly: `model/.env` (machine-specific, never committed) and a profile in `model/profiles/` (the model, its context length and the size of its context cache).

### Measured on

Only this hardware has been measured; nothing else is claimed to work.

- NVIDIA RTX 3090 Ti (24 GiB), driver 595, NVIDIA Container Toolkit 1.20
- Docker 29 with Compose, on Ubuntu 24.04
- vLLM v0.34.0 (image pinned by digest; it needs driver 580 or newer)

Three profiles passed the gate on it. Each serves 4 requests at once, and each records its results at the top of its file.

| Profile | Model | Context | Peak GPU memory in the gate |
|---|---|---|---|
| `qwen3.5-9b-w4a16` | Qwen3.5-9B, 4-bit | 32,768 tokens | 16,134 MiB |
| `qwen3.5-4b-w4a16` | Qwen3.5-4B, 4-bit | 32,768 tokens | 10,780 MiB |
| `qwen3.5-4b-w4a16-20k` | Qwen3.5-4B, 4-bit | 20,480 tokens | 9,232 MiB |

The two smaller profiles are meant for cards with less memory, but they have only been run on the card above.

Disk needed on the GPU host: about 36 GB for the vLLM image, and about 11 GB of weights for the 9B model or 5 GB for the 4B.

### Start it

Run these from `model/` on the GPU host, or from another machine with `DOCKER_HOST` pointing at it. The commands below use the 9B profile; substitute another profile's name to use it.

1. Copy `.env.example` to `.env` and fill it in.
2. Download the pinned model revision:

   ```bash
   docker compose --env-file .env --env-file profiles/qwen3.5-9b-w4a16.env --profile download run --rm download
   ```

3. Start the server and wait for it to report healthy (a few minutes):

   ```bash
   docker compose --env-file .env --env-file profiles/qwen3.5-9b-w4a16.env up -d chat
   ```

### Check it

The gate is a script that decides whether the server is fit for the lab. It checks that requests without the key are rejected, that tool calling works under concurrent load, and that several long prompts are answered correctly at once. Thresholds are in `model/gate/gate.config.json`.

Run it from `model/gate/`, on any machine that can reach the server:

```bash
docker compose --env-file ../.env --env-file ../profiles/qwen3.5-9b-w4a16.env run --rm gate
```

It prints a JSON report and exits 0 on a pass, 1 if a check failed, and 2 if it could not run.
