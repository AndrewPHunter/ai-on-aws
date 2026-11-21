# Agents

The agents that handle inquiries. Each runs as its own container from one image, and each serves the same HTTP contract, the one Amazon Bedrock AgentCore Runtime asks of a container: `POST /invocations` and `GET /ping` on port 8080.

Every command on this page is run from the root of the repository.

| Agent | What it does | State |
|---|---|---|
| Intake, hand-written loop | Notices an adverse event in a message and records it in the [case system](../tools/case-system/README.md). Does not answer clinical questions. | Works against the local model. Measured on seven prepared inquiries. |
| Intake, on Strands | The same agent with the loop left to the Strands SDK, for comparison | Not built |
| Label expert | Answers from the approved label, with the passages it relied on | Not built |
| Orchestrator | Decides which of the others a message needs | Not built |

## Run it

The agents need the model server. [Set it up](../model/README.md) first; that writes `model/.env`, which tells the agent where the model is and the key to use.

```bash
docker compose up -d --build --wait
```

That starts the agent with the case system and the [client](../client/README.md). Open <http://127.0.0.1:3000> and send an inquiry.

To call the agent directly:

```bash
curl -s http://127.0.0.1:8080/invocations -H 'content-type: application/json' -d '{"message":{"id":"m-1","received_at":"2026-01-01T09:00:00Z","sender":"Dr. A. Rivera, a.rivera@example.org","text":"My patient JD, 54, developed severe muscle pain on atorvastatin 40 mg."}}'
```

The request and the answer are defined in [`shared/agent-contract.ts`](../shared/agent-contract.ts). The answer carries the reply, what was done to cases, and every step taken.

## How the intake agent is put together

The flows, the rules of a tool call, and the controls it does not have are in [docs/architecture/intake-agent-handwritten.md](../docs/architecture/intake-agent-handwritten.md).

```
POST /invocations ─> contract server ─> the loop ─> model server      chat API with tools
                                           └──────> case system       three MCP tools, with context headers
```

| File | Holds | Shared with the Strands version |
|---|---|---|
| [`src/contract/server.ts`](src/contract/server.ts) | `/invocations` and `/ping`, written by hand | Yes |
| [`src/intake/prompt.ts`](src/intake/prompt.ts) | What the agent is told | Yes |
| [`src/tools/tool-set.ts`](src/tools/tool-set.ts) | What any set of tools looks like to a loop, and what a call can come back as | Yes |
| [`src/tools/case-system.ts`](src/tools/case-system.ts) | What is particular to the case system: the MCP connection with its context headers, which tools change a case, and what its answers mean for the run's record | Yes |
| [`src/run/record.ts`](src/run/record.ts) | Step timing and the run's deadline | Yes |
| [`src/model/chat.ts`](src/model/chat.ts) | The chat API client, with `fetch` | No |
| [`src/intake/handwritten.ts`](src/intake/handwritten.ts) | The loop | No |

The loop is the part a framework would own. Written by hand, these decisions are code you can read:

- **A tool that does not exist, or arguments that are not JSON,** go back to the model as an error. Nothing is called.
- **A write whose reply is lost is repeated once by the agent's code,** with identical content. The case system recognises an identical repeat, so there is one case either way. The model is not asked to retry, because a model rewords.
- **One message opens at most one case, at one version.** Once a run has opened a case, or been told by the case system that one is already open for this message, a second `create_case` or a follow-up to that case is refused in code.
- **If it is still not known whether a write happened, the run fails.** It does not write a reply.
- **A turn lost to thinking is asked again once, with thinking off.**
- **A run has a turn limit (6) and a time limit (150 s),** below the 180 s the client waits, and says which one stopped it.
- **The model never sets the message identifier, receipt time, sender or agent name.** The code sends them as headers on every call to the case system, which uses the sender to limit lookups and follow-ups to that sender's own cases.
- **Once a request is valid, the answer is always inside the contract:** an outcome and the steps taken so far, never a bare error status.

## Settings

Set in [`compose.yaml`](compose.yaml).

| Setting | Meaning |
|---|---|
| `MODEL_BASE_URL`, `MODEL_API_KEY` | Where the model server is and its key. Read from `model/.env`. |
| `MODEL_ID` | The model's name. Optional: if unset, the agent asks the server, which must serve exactly one model. |
| `CASE_MCP_URL` | The case system's MCP endpoint |
| `AGENT_ID` | The name this agent's changes are recorded under |

## What was measured

Against the local model (Qwen3.5-9B on vLLM), through the client, on the seven prepared inquiries.

- With the first prompt, five of seven behaved as intended. After two prompt revisions and one code change, seven of seven did.
- A run took 3 to 7 seconds.
- Seven inquiries, one run each, with the prompt adjusted against those same seven. This says the agent can do the job on these messages. It does not say how often it will on others.

## Known limits

- **The agent trusts the case system's address and is not authenticated to it,** and nothing authenticates callers of `/invocations`.
- **The message text is put between `<message>` tags.** A message that contains the closing tag has not been tried.
- **A follow-up can replace detailed values with vaguer ones.** In one run the patient "JD, a 54-year-old man" became "JD", the dose was dropped, and the original description of the event was replaced by the new information alone. The earlier version keeps the originals.
- **The retry without thinking has run only in tests,** against a scripted stand-in for the model. In the run made after it was added, the model answered without it.
- **Not run on AgentCore Runtime.**
