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

The lab is a set of pieces, one folder each. A piece that runs is one or more containers of its own.

```
ai-on-aws/
├── README.md             this page
├── LICENSE
├── AGENTS.md             the rules for working here
├── CLAUDE.md             points an AI assistant at AGENTS.md
├── .claude/agents/       the three kinds of agent AGENTS.md names
├── .gitignore, .dockerignore
├── compose.yaml          starts the running pieces together
├── package.json          dependencies and check commands for all TypeScript
├── package-lock.json
├── tsconfig.json
├── eslint.config.js
├── .devcontainer/        VS Code dev container
├── docs/
│   ├── architecture/     the system as it is
│   └── write-ups/        research, and what was learned
├── toolchain/            checks, builds and packages the TypeScript
├── model/                the model servers
├── client/               the web app people use: inquiries, agent runs, case review
├── shared/               TypeScript used by more than one piece
├── agents/               agents on the AgentCore Runtime contract
├── tools/                what agents call: MCP servers and APIs
├── knowledge/            the Bedrock Knowledge Bases stand-in
├── platform/             the identity provider stand-in
├── test-support/         stand-ins only tests use; copied into no piece's image
└── evaluation/           harness, datasets and attack cases
```

| Piece | What it is |
|---|---|
| [`toolchain/`](toolchain/README.md) | The image stages and commands that typecheck, lint and test every TypeScript file in the repository, whichever piece it belongs to, build the React app, and package a piece to run |
| [`model/`](model/README.md) | Three vLLM servers on one GPU: the chat model, an embedding model and a reranker. One command sets them up, and a gate decides whether the running servers are fit for the lab |
| [`client/`](client/README.md) | A medical information desk: a React app and its server. Signs people in, receives inquiries, hands them to agents, shows each run's result, shows what each agent did to those allowed to read traces, and is where people review cases |
| [`shared/`](shared/README.md) | The contracts between pieces: what an agent is sent and returns, what the case system sends, and the check every service makes of an access token |
| [`agents/`](agents/README.md) | Four agents, each its own container, each serving the AgentCore Runtime contract. Intake, built twice: with its loop written by hand, and on Strands. The label expert, on Strands, answers from a drug's approved label with citations checked in code. The orchestrator, on Strands, has every message screened for an adverse event by the intake agent on Strands and the label questions in it answered by the label expert, calling each with a token exchanged for that agent |
| [`tools/`](tools/README.md) | The agents' tools: MCP servers and APIs. Not developer tooling, which is `toolchain/`. One tool: the case system, which both intake agents write to |
| [`knowledge/`](knowledge/README.md) | Documents in, search, retrieval for agents. The documents are US drug labels from DailyMed: the labels of the FDARxBench benchmark, pinned by set id and version, fetched and checked by checksum, parsed into structured documents and split into citable chunks, each step checked for lost text. The chunks are indexed in OpenSearch and served to agents as two MCP tools behind the token check: find a drug's label, then search inside it. The search is keyword (BM25) by default; a setting of the service chooses vector search, keyword and vectors fused by rank, or fused and then reranked. The label expert calls it |
| [`platform/`](platform/README.md) | Local stand-ins for the AgentCore services around the runtime. One stand-in: an OpenID Connect provider (Keycloak) with one realm, started with the lab. The client signs people in through it; the agents, the case system and the retrieval service each check the access token on every request. Memory, policy and tracing have no stand-in |
| [`test-support/`](test-support/README.md) | Code only tests use: a stand-in OpenID Connect issuer for a test that cannot start the real one. Copied into no piece's image |
| [`evaluation/`](evaluation/README.md) | Two harnesses. One measures the label expert: a fixed, seeded sample of FDARxBench questions sent through the agent contract with a real token, every response stored, scores computed in code with Wilson intervals, two runs compared by the sign test, and answers graded by a judge model under a rubric. The other plays a committed set of attack, control and fault cases against all four agents through the client and decides each in code |

How the pieces share code and stay separate:

- **One language setup.** The files at the root (`package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`) apply to every piece written in TypeScript, so every piece is checked by the same command against the same dependency versions.
- **One container per running thing.** Each agent, tool or service runs as its own container, with its own port and settings, started from its own folder.
- **Other people's software is a pinned image.** The model servers, the search engine and the identity provider are such images: the lab's code does not go into them.
- **Security has no folder.** A control lives in the piece it protects, and the attacks that test it live in `evaluation/`.

## Getting started

### Run the model server

You need a machine with one NVIDIA GPU, Docker with Compose, and the NVIDIA Container Toolkit. On that machine, from a clone of this repository:

```bash
model/setup.sh --bind <address> --cache-dir <directory>
```

`<address>` is an IPv4 address of that machine that the lab's containers can reach: not `127.0.0.1`, which inside a container is the container itself. `<directory>` is an existing directory, given as an absolute path, where the model weights are kept.

Setup selects the largest chat model that fits the GPU's free memory, starts the three servers, and reports success only if they pass the lab's gate. The memory and disk it needs, the flags, and running the server on a different machine from the one you work on are in [model/README.md](model/README.md).

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
| `avery.auditor` | `auditor` | Read cases and their audit trails, and every run's trace; change nothing | `IDENTITY_AVERY_PASSWORD` in `platform/identity/.env` |

`platform/identity/setup.sh` writes `platform/identity/.env`, the secrets of the lab's identity provider, with random values; run again, it keeps every value already there and adds only the variables the file lacks. `docker compose up` starts the agents, the case system they write to, the client, the identity provider, the search engine and the retrieval service, on one network. It reads `model/.env`, which model setup wrote, to find the model server, and `platform/identity/.env`; without either file it stops and says what is missing. The identity provider is described in [platform/identity/README.md](platform/identity/README.md). If the model server is on a different machine from the one you work on, run setup from the machine you work on with `--host` and `--bind`, as described in [model/README.md](model/README.md), so that `model/.env` is here.

What each screen does is in [client/README.md](client/README.md), and what each agent does is in [agents/README.md](agents/README.md).

To check sign-in end to end on the running lab (the four people signed in through Keycloak, what each may and may not do, each agent's and each tool server's refusal of a request without a token, an inquiry through each intake agent, a question to the label expert and an inquiry through the orchestrator to both of the agents it calls, each run followed to its end, tokens presented straight to each service, sign-out), run the stack gate beside the identity provider's own gate:

```bash
platform/identity/stack-gate.sh ai-on-aws
platform/identity/gate.sh ai-on-aws
```

Both need the stack running. Both print a JSON report and exit 0 only if every statement holds; see [platform/identity/README.md](platform/identity/README.md). The stack gate enters four test inquiries from "Dr Gate" and may open three test cases in the stack it is run against. To check the retrieval path once the index is built (the token check, the index's count, both tools, their refusals):

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
