# AI on AWS: a local lab for AgentCore and Bedrock Knowledge Bases

A reproducible lab for exploring Amazon Bedrock AgentCore and a local stand-in for Bedrock Knowledge Bases, backed by a self-hosted model served with vLLM.

## Purpose

The lab is for looking closely at a few things, on hardware you control:

- how agents are built and hosted for AgentCore, with more than one agent working together;
- tool calling, and how reliable it is under load;
- retrieval over your own documents, in the shape of Bedrock Knowledge Bases;
- evaluation and security of the above.

Everything runs in containers. The machine you work on needs a shell and Docker, and nothing else installed.

## Status

Under construction.

| Piece | State |
|---|---|
| Model server (`model/`) | Works, set up by one command, measured on one GPU |
| Agents | Not started |
| Knowledge Bases stand-in | Not started |

## Getting started

The only thing to run today is the model server. You need a machine with one NVIDIA GPU, Docker with Compose, and the NVIDIA Container Toolkit.

On that machine, from a clone of this repository:

```bash
model/setup.sh --cache-dir <directory>
```

`<directory>` is an existing directory, given as an absolute path, where the model weights are kept.

Setup selects the largest model that fits the GPU's free memory, starts the server, and reports success only if the server passes the lab's gate. The memory and disk it needs, the flags, running the server on a different machine from the one you work on, and what has been measured are in [model/README.md](model/README.md).

## Layout

| Path | What it holds |
|---|---|
| [`model/`](model/README.md) | The model server: its setup command, Compose files, model profiles, tiers, and the gate that decides whether a running server is fit for the lab |
| [`docs/architecture/`](docs/architecture/) | The system as it is: what is always true, what runs where, who owns what |
| [`AGENTS.md`](AGENTS.md) | The rules for working in this repository, for people and for AI agents |
| `.claude/agents/` | The working roles (researcher, implementer, reviewer) as agent definitions |

## Where to read next

- To run the model server: [model/README.md](model/README.md).
- To understand how the model server is put together: [docs/architecture/model-server.md](docs/architecture/model-server.md).
- To change anything here: [AGENTS.md](AGENTS.md).
