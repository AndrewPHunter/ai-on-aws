# AI on AWS: a local lab for AgentCore and Bedrock Knowledge Bases

A reproducible lab for exploring Amazon Bedrock AgentCore and a local stand-in for Bedrock Knowledge Bases, backed by a self-hosted model served with vLLM.

## Purpose

The lab is for looking closely at a few things, on hardware you control:

- how agents are built and hosted for AgentCore, with more than one agent working together;
- tool calling, and how reliable it is under load;
- retrieval over your own documents, in the shape of Bedrock Knowledge Bases;
- evaluation and security of the above.

Everything runs in containers. The machine you work on needs a shell and Docker, and nothing else installed.

## Layout

The lab is a set of pieces, one folder each. A piece that runs is one or more containers of its own. Under construction: the state column says which pieces exist.

```
ai-on-aws/
├── README.md             this page
├── AGENTS.md             the rules for working here
├── package.json          dependencies and check commands for all TypeScript
├── package-lock.json
├── tsconfig.json
├── eslint.config.js
├── .devcontainer/        VS Code dev container
├── docs/
│   ├── architecture/     the system as it is
│   └── write-ups/        what was measured and learned
├── toolchain/            checks, and later builds and packages, the TypeScript
├── model/                the model server
├── shared/               TypeScript used by more than one piece
├── agents/               agents on the AgentCore Runtime contract
├── tools/                what agents call: MCP servers and APIs
├── knowledge/            the Bedrock Knowledge Bases stand-in
├── platform/             stand-ins for memory, identity, policy and tracing
└── evaluation/           harness, datasets and attack cases
```

| Piece | What it is | State |
|---|---|---|
| [`toolchain/`](toolchain/README.md) | The image stages and commands that typecheck, lint and test every TypeScript file in the repository, whichever piece it belongs to | Works |
| [`model/`](model/README.md) | One vLLM server for the chat model, its one-command setup, and the gate that decides whether a running server is fit for the lab | Works, measured on one GPU |
| [`shared/`](shared/README.md) | Packages used by more than one piece | Placeholder |
| [`agents/`](agents/README.md) | The agents, each its own container | Placeholder |
| [`tools/`](tools/README.md) | The agents' tools: MCP servers and APIs. Not developer tooling, which is `toolchain/` | Placeholder |
| [`knowledge/`](knowledge/README.md) | Documents in, search, retrieval for agents | Placeholder |
| [`platform/`](platform/README.md) | Local stand-ins for the AgentCore services around the runtime | Placeholder |
| [`evaluation/`](evaluation/README.md) | Measures the other pieces | Placeholder |

A placeholder folder holds a README that says what will live there, and nothing else.

How the pieces share code and stay separate:

- **One language setup.** The files at the root (`package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`) apply to every piece written in TypeScript, so every piece is checked by the same command against the same dependency versions.
- **One container per running thing.** Each agent, tool or service runs as its own container, with its own port and settings, started from its own folder.
- **Other people's software is a pinned image.** The model server is the first example: the lab's code does not go into it.
- **Security has no folder.** A control lives in the piece it protects, and the attacks that test it live in `evaluation/`.

## Getting started

### Run the model server

You need a machine with one NVIDIA GPU, Docker with Compose, and the NVIDIA Container Toolkit. On that machine, from a clone of this repository:

```bash
model/setup.sh --cache-dir <directory>
```

`<directory>` is an existing directory, given as an absolute path, where the model weights are kept.

Setup selects the largest model that fits the GPU's free memory, starts the server, and reports success only if the server passes the lab's gate. The memory and disk it needs, the flags, running the server on a different machine from the one you work on, and what has been measured are in [model/README.md](model/README.md).

### Check the code

On any machine with Docker, no GPU needed:

```bash
toolchain/check.sh
```

It typechecks, lints and tests all the TypeScript in the repository, in a container with no network. Details, and how to open the repository in the VS Code dev container, are in [toolchain/README.md](toolchain/README.md).

## Where to read next

- To run the model server: [model/README.md](model/README.md).
- To understand how a piece is put together: [docs/architecture/](docs/architecture/).
- To change anything here: [AGENTS.md](AGENTS.md).
