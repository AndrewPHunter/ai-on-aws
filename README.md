# AI on AWS: a local lab for AgentCore and Bedrock Knowledge Bases

A reproducible lab for exploring Amazon Bedrock AgentCore and a local stand-in for Bedrock Knowledge Bases, backed by a self-hosted model served with vLLM.

## Purpose

The lab is for looking closely at a few things, on hardware you control:

- how agents are built and hosted for AgentCore, with more than one agent working together: an orchestrator that calls two other agents over the same contract, each with a token exchanged for that agent;
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
├── compose.yaml          starts the running pieces together
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
├── client/               the web app people use: inquiries, agent runs, case review
├── shared/               TypeScript used by more than one piece
├── agents/               agents on the AgentCore Runtime contract
├── tools/                what agents call: MCP servers and APIs
├── knowledge/            the Bedrock Knowledge Bases stand-in
├── platform/             stand-ins for memory, identity, policy and tracing
├── test-support/         stand-ins only tests use; copied into no piece's image
└── evaluation/           harness, datasets and attack cases
```

| Piece | What it is | State |
|---|---|---|
| [`toolchain/`](toolchain/README.md) | The image stages and commands that typecheck, lint and test every TypeScript file in the repository, whichever piece it belongs to | Works |
| [`model/`](model/README.md) | One vLLM server for the chat model, its one-command setup, and the gate that decides whether a running server is fit for the lab | Works, measured on one GPU |
| [`client/`](client/README.md) | A medical information desk: a React app and its server. Receives inquiries, hands them to agents, shows what each agent did, and is where people review cases | Works with all four agents. The read-outs for citations, label searches and calls to another agent have not been looked at with real output. No screen yet for evaluation |
| [`shared/`](shared/README.md) | The contracts between pieces | Two contracts: what an agent is sent and returns, and what the case system sends. Both intake agents, the label expert and the orchestrator implement the first |
| [`agents/`](agents/README.md) | The agents, each its own container, each serving the AgentCore Runtime contract | Four agents. Intake, built twice: with its loop written by hand, and on Strands; both work against the local model. The label expert, on Strands, answers from a drug's approved label with checked citations; tested against stand-ins, not measured against the local model. The orchestrator, on Strands, has every message screened for an adverse event by the intake agent on Strands and the label questions in it answered by the label expert, calling each with a token exchanged for that agent; tested with scripted sub-agents and a scripted model server, not measured against the local model ([docs/architecture/orchestrator.md](docs/architecture/orchestrator.md)) |
| [`tools/`](tools/README.md) | The agents' tools: MCP servers and APIs. Not developer tooling, which is `toolchain/` | One tool: the case system, used by both intake agents |
| [`knowledge/`](knowledge/README.md) | Documents in, search, retrieval for agents. The documents are US drug labels from DailyMed, prescription and over-the-counter | The corpus: the labels of the FDARxBench benchmark that DailyMed serves, pinned by set id and version, fetched and checked by checksum, counted, parsed into structured documents, and split into citable chunks, each step checked for lost text. The chunks are indexed in OpenSearch and served to agents as two MCP tools behind the token check: find a drug's label, then search inside it. The search is keyword (BM25) by default; a setting of the service chooses vector search, keyword and vectors fused by rank, or fused and then reranked instead, with vectors from an embedding model and a reranker served on the GPU machine. The label expert calls it |
| [`platform/`](platform/README.md) | Local stand-ins for the AgentCore services around the runtime | One stand-in: an OpenID Connect provider (Keycloak) with one realm, started with the lab. The client signs desk staff in through it and validates their ID tokens; the agents and the case system each check the access token on every request. No stand-in yet for memory, policy or tracing |
| [`test-support/`](test-support/README.md) | Code only tests use: stand-ins for services a test cannot start. Copied into no piece's image | One stand-in: an OpenID Connect issuer, used by the tests of the client and the shared token check |
| [`evaluation/`](evaluation/README.md) | Measures the other pieces | A harness for the label expert: a fixed, seeded sample of FDARxBench questions sent through the agent contract with a real token, every response stored, scores computed in code (declining, the right label, citations and retrieval by section, numbers, effort) with Wilson intervals, two runs compared by the sign test, and answer correctness graded by a judge model whose agreement with a person is measured |

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

### Run the lab

With the model server set up as above, on the machine you work on:

```bash
knowledge/fetch.sh
knowledge/parse.sh
knowledge/chunk.sh
platform/identity/setup.sh
docker compose up -d --build --wait
knowledge/index.sh ai-on-aws
```

The first three get the drug labels the corpus pins, parse them, and split them into chunks (see [knowledge/README.md](knowledge/README.md)); the last loads the chunks into the running stack's search engine. Without it the retrieval service answers that the index has not been built.

Then open <http://localhost:3000> (use `localhost`, not `127.0.0.1`: sign-in returns to `localhost`) and sign in as one of the lab's four synthetic people:

| Username | Role | May | Password |
|---|---|---|---|
| `dana.desk` | `desk` | Enter inquiries and run the intake agents and the orchestrator | `IDENTITY_DANA_PASSWORD` in `platform/identity/.env` |
| `morgan.medinfo` | `medical-information` | Do what the desk does, and run the label expert | `IDENTITY_MORGAN_PASSWORD` in `platform/identity/.env` |
| `riley.reviewer` | `safety-reviewer` | Read cases and decide them | `IDENTITY_RILEY_PASSWORD` in `platform/identity/.env` |
| `avery.auditor` | `auditor` | Read cases and their audit trails; change nothing | `IDENTITY_AVERY_PASSWORD` in `platform/identity/.env` |

`platform/identity/setup.sh` writes `platform/identity/.env`, the secrets of the lab's identity provider, with random values; run again, it changes nothing. `docker compose up` starts the agents, the case system they write to, the client, the identity provider, the search engine and the retrieval service, on one network. It reads `model/.env`, which model setup wrote, to find the model server, and `platform/identity/.env`; without either file it stops and says what is missing. The identity provider is described in [platform/identity/README.md](platform/identity/README.md). If the model server is on a different machine from the one you work on, run setup with `--host` from the machine you work on, as described in [model/README.md](model/README.md), so that `model/.env` is here.

What each screen does is in [client/README.md](client/README.md), and what each agent does is in [agents/README.md](agents/README.md).

To check sign-in end to end on the running lab (the four people signed in through Keycloak, what each may and may not do, each agent's and each tool server's refusal of a request without a token, an inquiry through each intake agent, a question to the label expert and an inquiry through the orchestrator to both of the agents it calls, each run followed to its end, tokens presented straight to each service, sign-out), run the stack gate beside the identity provider's own gate:

```bash
platform/identity/stack-gate.sh ai-on-aws
platform/identity/gate.sh ai-on-aws
```

Both print a JSON report and exit 0 only if every statement holds; see [platform/identity/README.md](platform/identity/README.md). To check the retrieval path once the index is built (the token check, the index's count, both tools, their refusals):

```bash
knowledge/gate.sh ai-on-aws
```

### Check the code

On any machine with Docker, no GPU needed:

```bash
toolchain/check.sh
```

It typechecks, lints and tests all the TypeScript in the repository and builds the React app, in a container with no network. Details, and how to open the repository in the VS Code dev container, are in [toolchain/README.md](toolchain/README.md).

## Where to read next

- To run the model server: [model/README.md](model/README.md).
- To understand how a piece is put together: [docs/architecture/](docs/architecture/).
- To change anything here: [AGENTS.md](AGENTS.md).

## Licence

MIT: see [LICENSE](LICENSE). The drug labels and the benchmark the lab fetches are not part of this repository and carry their own terms.
