# Agents

The agents that handle inquiries. Each runs as its own container from one image, and each serves the same HTTP contract, the one Amazon Bedrock AgentCore Runtime asks of a container: `POST /invocations` and `GET /ping` on port 8080.

`POST /invocations` requires an access token from the lab's [identity provider](../platform/identity/README.md), as `Authorization: Bearer`, checked before anything else: the check AgentCore Runtime's JWT authorizer makes in front of the container, made here too. The agent passes the caller's token on to the case system on every request. `GET /ping` needs none.

Every command on this page is run from the root of the repository.

| Agent | What it does | State |
|---|---|---|
| Intake, hand-written loop | Notices an adverse event in a message and records it in the [case system](../tools/case-system/README.md). Does not answer clinical questions. | Works against the local model. Measured on seven prepared inquiries. |
| Intake, on Strands | The same agent with the loop left to the Strands SDK, for comparison | Works against the local model. Measured on the same seven. |
| Label expert | Answers from the approved label, with the passages it relied on | Not built |
| Orchestrator | Decides which of the others a message needs | Not built |

## Run it

The agents need the model server. [Set it up](../model/README.md) first; that writes `model/.env`, which tells the agent where the model is and the key to use.

```bash
docker compose up -d --build --wait
```

That starts both intake agents with the case system, the identity provider and the [client](../client/README.md). Open <http://localhost:3000>, sign in, choose an agent and send an inquiry.

To call an agent directly, use port 8080 for the hand-written one and 8081 for the one on Strands, with an access token issued to the `desk` client that has at least 150 seconds left. Without one the answer is 401:

```bash
curl -s http://127.0.0.1:8080/invocations -H 'content-type: application/json' -H "authorization: Bearer $ACCESS_TOKEN" -d '{"message":{"id":"m-1","received_at":"2026-01-01T09:00:00Z","sender":"Dr. A. Rivera, a.rivera@example.org","text":"My patient JD, 54, developed severe muscle pain on atorvastatin 40 mg."}}'
```

| Answer | When |
|---|---|
| 401, `WWW-Authenticate: Bearer error="invalid_token"`, `{"error":"unauthorized","reason","detail"}` | No token, or one that is malformed, signed by another key or not with RS256, from another issuer, not for `lab-agents`, not issued to an allowed client, expired, or with less than 150 s left. `reason` names which |
| 503 `identity_unavailable` | The identity provider's discovery document or keys cannot be fetched, or it names another issuer |

The request and the answer are defined in [`shared/agent-contract.ts`](../shared/agent-contract.ts). The answer carries the reply, what was done to cases, and every step taken.

## How the intake agent is put together

The intake agent is built twice. Everything that makes it this agent is one copy that both use. Each then has its own loop.

```
                                        ┌─> hand-written loop ─> chat client ──────────┐
POST /invocations ─> contract server ───┤        both ask the shared rules             ├─> model server
                                        └─> Strands Agent ─────> Strands OpenAI model ─┘
                                                 └── either ──> case system      three MCP tools, with context headers
```

The flows, the rules of a tool call, and the controls neither has are in two documents:

- [docs/architecture/intake-agent-handwritten.md](../docs/architecture/intake-agent-handwritten.md)
- [docs/architecture/intake-agent-strands.md](../docs/architecture/intake-agent-strands.md), which covers only what differs

| File | Holds | Used by |
|---|---|---|
| [`src/contract/server.ts`](src/contract/server.ts) | `/invocations` and `/ping`, written by hand | Both |
| [`src/intake/prompt.ts`](src/intake/prompt.ts) | What the agent is told | Both |
| [`src/intake/run.ts`](src/intake/run.ts) | The rules of a run, its record, and the wording of every ending | Both |
| [`src/intake/settings.ts`](src/intake/settings.ts) | The limits and the sampling settings | Both |
| [`src/intake/serve.ts`](src/intake/serve.ts) | Startup: the environment, which model is served, the server | Both |
| [`src/run/record.ts`](src/run/record.ts) | Step timing and the run's deadline | Both |
| [`src/model/served.ts`](src/model/served.ts) | The model settings, which model the server serves, the wording of a model failure | Both |
| [`src/tools/case-system.ts`](src/tools/case-system.ts) | What is particular to the case system: its context headers, which tools change a case, how to read its answers, and what they mean for the run's record. Also the hand-written agent's MCP connection | Both |
| [`src/tools/tool-set.ts`](src/tools/tool-set.ts) | What a call can come back as (`ToolOutcome`), and what a set of tools looks like to the hand-written loop | Both use `ToolOutcome` |
| [`src/intake/handwritten.ts`](src/intake/handwritten.ts) | The hand-written loop | Hand-written |
| [`src/model/chat.ts`](src/model/chat.ts) | The chat API client, with `fetch` | Hand-written |
| [`src/intake/strands.ts`](src/intake/strands.ts) | The Strands `Agent`, its four hooks, and the tool wrapper that adds a time limit | Strands |

The rules both apply, from [`src/intake/run.ts`](src/intake/run.ts):

- **A write whose reply is lost is repeated once by the agent's code,** with identical content. The case system recognises an identical repeat, so there is one case either way. The model is not asked to retry, because a model rewords.
- **One message opens at most one case, at one version.** Once a run has opened a case, or been told by the case system that one is already open for this message, a second `create_case` or a follow-up to that case is refused in code.
- **If it is still not known whether a write happened, the run fails.** It does not write a reply.
- **A turn lost to thinking is asked again once, with thinking off.**
- **A run has a turn limit (6) and a time limit (150 s),** below the 180 s the client waits, and says which one stopped it.
- **The model never sets the message identifier, receipt time, sender or agent name.** The code sends them as headers on every call to the case system, which uses the sender to limit lookups and follow-ups to that sender's own cases.
- **Once a request is valid, the answer is always inside the contract:** an outcome and the steps taken so far, never a bare error status.

## Where the two differ

The Strands agent uses Strands the way it comes: its own loop, its own MCP client, and its OpenAI model on that model's default API (the Responses API). The hand-written agent speaks chat completions with `fetch`.

One table of 31 behaviours in [`test/intake.test.ts`](test/intake.test.ts) runs against both agents. 20 rows are asserted identically for both. The other 11 each name one of these nine differences:

| Situation | Hand-written loop | Strands 1.25.0 |
|---|---|---|
| Tool arguments are not JSON | Tells the model and carries on | Ends the run with an error |
| A reply is cut off part way by the output allowance | Returns the cut-off reply | Returns no reply |
| A turn is asked again after being lost to thinking | Counts towards the 6 turns | Not counted, so a run can have 7 turns |
| A tool result that is an error, as the model is told it | As it is | With `[ERROR] ` in front |
| How thinking is turned off | `chat_template_kwargs` | `reasoning.effort: 'none'` |
| How a turn ended, as recorded in a step | `stop`, `tool_calls`, `length` | `endTurn`, `toolUse`, `maxTokens` |
| A failed request to the model that is sent again | Recorded as an error step | Not recorded: the OpenAI client sends it again inside itself |
| The model never answers | One request | Sent again until the run's time limit |
| The model answers 429 three times in a row | The run fails | Strands waits and asks again |

Both send a failed request to the model again, in the same turn, when that could help: the connection failed, or the status is 408, 429 or 5xx. A rejected request (400) is not sent again.

- **The hand-written loop** makes at most three requests for a turn, waiting up to half a second and then up to a second. It does not send a request again that ran out of time. It is in [`src/intake/handwritten.ts`](src/intake/handwritten.ts).
- **Strands** is left as it comes. The OpenAI client inside it makes at most three requests, timed-out ones included. On top of that, Strands retries a throttled call (429) up to six times with a longer, random wait.
- **The run's time limit stops both.** A model that never answers therefore fails a hand-written run at 90 s and a Strands run at 150 s.

Two more things were written for Strands:

- **A time limit on a tool call.** Strands' own MCP tool sets none, so a lost reply waits for the whole run.
- **Four settings that are not its defaults:** tool calls one at a time, no printing of the conversation to the log, a new `Agent` for every message, and no trimming of the conversation.

The reasons for each are in [the Strands document](../docs/architecture/intake-agent-strands.md).

## Settings

Set in [`compose.yaml`](compose.yaml), for each agent. The limits and sampling settings are in [`src/intake/settings.ts`](src/intake/settings.ts) and are the same for both.

| Setting | Meaning |
|---|---|
| `MODEL_BASE_URL`, `MODEL_API_KEY` | Where the model server is and its key. Read from `model/.env`. |
| `MODEL_ID` | The model's name. Optional: if unset, the agent asks the server, which must serve exactly one model. |
| `CASE_MCP_URL` | The case system's MCP endpoint |
| `AGENT_ID` | The name this agent's changes are recorded under |
| `AUTH_DISCOVERY_URL` | Where the identity provider's discovery document is: `http://identity:8080/realms/lab/.well-known/openid-configuration` |
| `AUTH_ISSUER` | The issuer it and every token must name, exactly: `http://localhost:8090/realms/lab` |
| `AUTH_ALLOWED_AUDIENCE` | A value the token's `aud` must contain: `lab-agents` |
| `AUTH_ALLOWED_CLIENTS` | The `client_id` values accepted, separated by commas: `desk` |
| `AUTH_ROLES_CLAIM` | The claim holding the caller's roles: `roles` |

Every setting but `MODEL_ID` is required; the agent stops at start-up naming any that is missing. A token must have at least the run's time limit (150 s) left. The keys are fetched again, at most every 30 s, when a token names one not yet seen.

## What was measured

Against the local model (Qwen3.5-9B on vLLM), through the client, on the seven prepared inquiries.

- With the first prompt, five of seven behaved as intended on the hand-written agent. After two prompt revisions and one code change, seven of seven did.
- Each agent was then sent the seven on its own empty store. Both gave the intended result for all seven and left the same three cases at the same statuses and versions.
- The output was not always the same, with the same seed and a temperature of 0, even between two runs of one agent.
- A run took 3 to 9 seconds on either agent.
- Seven inquiries, with the prompt adjusted against those same seven on the hand-written agent. This says both agents can do the job on these messages. It does not say how often they will on others.
- No turn in these runs had more than one tool call, and no request to the model failed.

## Known limits

- **The case system does not check the token the agent sends,** and the agent trusts the case system's address. The agent's name is still a header it claims.
- **The caller's roles are read but not used:** any accepted token may submit a message.
- **The token check has run in tests only,** against a stand-in issuer, not yet in an agent container against the lab's Keycloak.
- **The message text is put between `<message>` tags.** A message that contains the closing tag has not been tried.
- **A follow-up can replace detailed values with vaguer ones.** In one run the patient "JD, a 54-year-old man" became "JD", the dose was dropped, and the original description of the event was replaced by the new information alone. The earlier version keeps the originals.
- **The retry without thinking has run only in tests,** against a scripted stand-in for the model. In the runs made after it was added, the model answered without it.
- **Sending a failed model request again has run in tests, and once for each agent against an address where nothing listens.** It has not run against a model server that fails some of the time. The hand-written loop does not read a `Retry-After` header.
- **Both agents run from one image,** so the hand-written agent's image also holds Strands, the OpenAI client and the AWS SDK's Bedrock client, which it does not use.
- **Not run on AgentCore Runtime.**
