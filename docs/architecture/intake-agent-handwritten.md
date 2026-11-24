# Intake agent, hand-written loop

The intake agent receives a clinician's message, uses a model to identify an adverse event report, and records it in the case system. A hand-written loop controls the model turns and tool calls. Code prevents a run from opening a second case and prevents an uncertain write from being reported as success. For startup instructions, see [agents/README.md](../../agents/README.md).

The [Strands implementation](intake-agent-strands.md) shares the prompt, run rules, record, settings and startup. Shared modules are identified below.

## Terms

| Term | Meaning |
|---|---|
| Caller | A client that posts to `/invocations` with an accepted access token. In the lab, the client's server acts for the signed-in staff member |
| Access token | The caller's `Authorization: Bearer` token, issued by the identity provider. Checked by `shared/access-token.ts` |
| Message | One inbound message: an identifier, a receipt time, a sender, and text. The caller sets all four |
| Run | The handling of one message by one call to `/invocations` |
| Turn | One model turn within a run. Usually one request; up to three when failed requests are retried |
| Tool set | A list of tool descriptions and a function that calls them. The case system's is the only one |
| Write | A tool call that changes a case: `create_case` or `add_follow_up`. These are the agent's only two tools |
| Follow-up | A message that adds to an earlier report. When it names the case's id, the model adds it to that case with `add_follow_up`; when it names none, it is recorded as a new case with `create_case`, as any report is. The agent cannot look a case up |
| Receipt | The response to a write: case id, status, version and missing fields. It contains no stored case content |
| Step | One entry in the run's record: a model turn, a tool call, an error, or the report check |
| Report check | One request to the model, separate from the run's conversation and made by code, asking whether the message describes an adverse event. Made when the model replies and the run has recorded no case (see "The report check") |
| Finding | What the report check found: `adverse_event` for yes, `none` for no, `unknown` when the check could not be made or answered neither |
| Context headers | `x-message-id`, `x-received-at`, `x-sender`, sent on every request to the case system beside the case-system token |
| Case-system token | The token the agent gets for the case system by exchanging the caller's access token, as itself, at the identity provider: audience `case-system`, scope `cases:write` alone. The only token the case system sees |

## Modules and their boundaries

```mermaid
flowchart LR
    Caller["Caller"]

    subgraph Agent["Agent container, port 8080"]
        Main["intake/main-handwritten.ts<br/>wiring"]
        Serve["intake/serve.ts, settings.ts,<br/>run/serve.ts, sampling.ts<br/>SHARED: startup, limits, sampling"]
        Server["contract/server.ts<br/>this agent's own: POST /invocations, GET /ping"]
        Loop["intake/handwritten.ts<br/>the loop"]
        Run["intake/run.ts, run/state.ts,<br/>steps.ts, turns.ts, endings.ts<br/>SHARED: rules of a run,<br/>its record, how it ends"]
        Prompt["intake/prompt.ts<br/>SHARED: system prompt, user turn"]
        Check["intake/report-check.ts<br/>SHARED: the report check"]
        Record["run/record.ts<br/>SHARED: step timing, run deadline"]
        ToolSet["tools/tool-set.ts<br/>ToolSet, ToolOutcome"]
        CaseTools["tools/case-system.ts<br/>MCP client, context headers,<br/>meaning of a result"]
        Exchange["tools/tool-token.ts<br/>SHARED: the exchange for<br/>the case-system token"]
        Chat["model/chat.ts<br/>chat API client"]
    end

    Contract["shared/agent-contract.ts<br/>request and response schemas"]
    Model["Model server"]
    Cases["Case system"]
    Identity["Identity provider"]

    Caller -->|"HTTP, JSON"| Server
    Main -->|"names the implementation,<br/>builds the handler"| Serve
    Serve -->|"starts"| Server
    Main -. "gives the loop its model<br/>and its tool connection" .-> Loop
    Main -. "puts the exchange<br/>before the tool connection" .-> Exchange
    Exchange -->|"token exchange,<br/>as the agent"| Identity
    Server -->|"Handler"| Loop
    Loop --> Prompt
    Loop -->|"at the model's reply"| Check
    Check -->|"rule at the reply"| Run
    Check -. "ChatModel.complete,<br/>wired in main-handwritten.ts" .-> Chat
    Loop -->|"asks before and after each call,<br/>records steps, ends the run"| Run
    Run --> Record
    Loop -->|"ChatModel.complete"| Chat
    Loop -->|"ToolSet.call"| ToolSet
    Loop -->|"isCaseTool,<br/>missingCaseTools"| CaseTools
    CaseTools -. "is a" .-> ToolSet
    Run -->|"caseActionFrom"| CaseTools
    Server -->|"validates with"| Contract
    Chat -->|"HTTP, bearer key"| Model
    CaseTools -->|"MCP over HTTP,<br/>context headers"| Cases
```

| Module | Owns | Knows nothing about |
|---|---|---|
| `contract/server.ts` | This implementation's HTTP routes, request validation and contract responses, and the `agent.run` span around the handler. Strands agents use the [SDK server](agent-runtime.md) | Model, tools, cases, handler logic |
| `intake/handwritten.ts` | Model/tool sequencing and application of shared rules; its own checks for unknown tools and invalid JSON; model retries | HTTP, MCP, model server address, tool transport |
| `intake/run.ts` (shared) | Run state and rules: one case per run, unanswered-write retries, unsettled writes and reply handling | Loop implementation, model, tool transport |
| `run/state.ts`, `run/limits.ts`, `run/steps.ts`, `run/turns.ts`, `run/endings.ts` (shared) | Common state, limits, step records, thinking retry and outcome wording | Loop implementation, model, tool transport |
| `intake/prompt.ts` | What the model is told, and how the message is laid out for it | Everything else |
| `intake/report-check.ts` (shared) | Report-check prompt, request and finding. `atReply` runs and records the check when the shared rule requires it | Run conversation, tools, loop continuation |
| `run/record.ts` | Measuring a step and counting down the run's time | What is being timed |
| `tools/tool-set.ts` | The shape of any tool set and of what a call can come back as | Any particular tool |
| `tools/case-system.ts` | The MCP connection, the context headers, the two tools a run needs and is shown (`CASE_TOOLS`, `isCaseTool`), which tools write, and what an answer means for the run's record | The model, the loop |
| `tools/tool-token.ts` (shared with the other agents) | Token exchange, target audience and scopes, and exchange failure reasons | Model, loop, MCP |
| `tools/mcp-answers.ts` (shared with the label expert) | MCP connection errors and tool payload parsing. `tools/case-system.ts` supplies the service name for error messages | Service-specific rules |
| `model/chat.ts` | One model request, response parsing and classification of retryable failures and of failures with no answer. It performs no retries | Tool meaning, cases, loop |
| `run/spans.ts` | The `model.call` and `tool.call` spans: their attributes and outcomes. `agent.run` is made in `contract/server.ts` | What the call does, the loop |
| `intake/serve.ts`, `intake/settings.ts`, `run/serve.ts`, `run/sampling.ts` (shared) | Reading the environment, the limits and sampling settings, asking which model is served, starting the server | The rules of a run, which implementation runs |
| `model/served.ts` (shared) | The model settings, the question "which model do you serve", and the wording of a model failure | Chat requests |
| `intake/main-handwritten.ts` | Connecting this implementation's modules, the exchange before the tool connection among them | The rules of a run |

The loop receives its dependencies through `IntakeDeps`: model, tool connection, report check, clock, wait function and randomness. It uses `missingCaseTools` and `isCaseTool` to require both case tools and exclude all others. The shared rules in `intake/run.ts` interpret results through `caseActionFrom` and apply the rules for `create_case` and `add_follow_up`.

## One request, end to end

```mermaid
sequenceDiagram
    autonumber
    participant C as Caller
    participant S as contract/server.ts
    participant L as intake/handwritten.ts
    participant X as tools/tool-token.ts
    participant I as Identity provider
    participant T as tools/case-system.ts
    participant K as Case system
    participant M as model/chat.ts
    participant V as Model server

    C->>S: POST /invocations with a message and Authorization: Bearer
    S->>S: access-token check (shared/access-token.ts), before the body is read
    S->>S: readJson, then invocationRequestSchema
    S->>L: handleInquiry with the caller
    L->>X: connectTools with the caller's token
    X->>I: token exchange, as the agent, for audience case-system
    I-->>X: the case-system token
    X->>T: connectCaseTools with the case-system token
    T->>K: initialize and tools/list, with context headers and the case-system token
    K-->>T: tool descriptions
    T-->>L: ToolSet
    L->>L: keeps create_case and add_follow_up, drops any other tool
    loop each turn, at most 6
        L->>M: complete with conversation and tool descriptions
        M->>V: POST /chat/completions
        V-->>M: text, or requests for tools
        M-->>L: Completion
        alt the model asked for tools
            L->>L: runToolCall asks refusalBeforeCall (intake/run.ts)
            L->>T: ToolSet.call
            T->>K: tools/call, with context headers and the case-system token
            K-->>T: result or refusal
            T-->>L: ToolOutcome
            L->>L: afterCall (intake/run.ts) records what it means for cases
        else the model wrote a reply
            opt the run has recorded no case and no report check was made
                L->>M: complete with the check's prompt and the message's text, no tools, thinking off
                M->>V: POST /chat/completions
                V-->>M: yes, no, or anything else
                M-->>L: the finding only
            end
            L->>L: afterReply (intake/run.ts): complete, tell once, or stop
            L-->>S: InvocationResponse, unless told once: then one more turn
        end
    end
    S->>S: invocationResponseSchema
    S-->>C: 200 with outcome, reply, case actions, steps
```

The functions responsible for each stage are:

| # | Where | What happens |
|---|---|---|
| 1 | `createContractServer` in `contract/server.ts`, this agent's own server | Routes `POST /invocations` to `invoke`. `GET /ping` answers `Healthy`, needs no token, and does not check the model or the case system |
| 1a | `invoke` → the access-token check | Checks the `Authorization` header before the body is read (see "The caller's token"). A refused token gets 401, or 403 when all it lacks is the scope, and a check that cannot be made gets 503; nothing else runs |
| 2 | `invoke` → `readJson` | Reads the body, at most 1,000,000 bytes, as JSON |
| 3 | `invoke` | Checks the body against `invocationRequestSchema`. A body that fails gets 400, and nothing else runs |
| 4 | Handler in `run/serve.ts` → `ready` | Uses `MODEL_ID` or discovers the model through `servedModelId` (`GET /models`, at most 10 s), then builds the client and handler through `main-handwritten.ts`. Discovery failure returns `failed` with an error step; the next request retries discovery |
| 5 | `handleInquiry` in `intake/handwritten.ts` → `startRun` in `intake/run.ts` | Starts the run: its `Deadline`, and empty lists of steps and case actions |
| 5a | `connectWithToolToken` in `tools/tool-token.ts`, wired before `connectCaseTools` | Exchanges the caller's token once for a case-system token. The exchange and connection share the tool limit, bounded by the run's remaining time. Failure ends the run before connection or inference; see the failure wording below |
| 6 | `connectCaseTools` in `tools/case-system.ts` | Connects with the message's three context headers and case-system bearer token on every request. Connection and tool listing each receive the time left by the exchange, bounded by the run deadline. Both case tools are required; only those tools are exposed to the model |
| 7 | `loop` | Starts the conversation: `SYSTEM_PROMPT`, then `userTurn(message)` |
| 8 | `loop` → `askModel` → `ChatModel.complete` in `model/chat.ts` | Sends the conversation and the tool descriptions. The time allowed is the smaller of the model limit and what the run has left. A request that fails may be sent again (see "A failed request to the model") |
| 9 | `loop` | Records a model step. If the model asked for tools, steps 10 to 13 follow. If it asked for none and wrote a reply, `atReply` in `intake/report-check.ts` decides what follows (see "The report check"). If it asked for none and wrote nothing, the turn is asked again once with thinking off, or the run ends (see "How a run ends") |
| 10 | `loop` → `runToolCall`, once per tool the model asked for, in order | Decides whether the call is made: its own two checks, then `refusalBeforeCall` in `intake/run.ts` (see "One tool call") |
| 11 | `runToolCall` → `callOnce` → `ToolSet.call` | Makes the MCP call and records a tool step (`recordToolCall`) |
| 12 | `runToolCall` → `afterCall` in `intake/run.ts` → `caseActionFrom` | Turns the case system's answer into a case action, remembers the case this run opened or found open, and says whether the call is done, to be repeated, or unsettled |
| 13 | `loop` | Appends one tool message per call to the conversation, and goes to step 8 |
| 14 | `completed`, `stoppedAt...`, `failed` in `run/endings.ts` | Builds the response: outcome, stop reason, reply, case actions, steps |
| 14a | `handleInquiry` → `holdingToFinding` in `intake/run.ts` | Gives a `stopped` ending the report check's sentence when the check found an adverse event and no case was recorded (see "The report check") |
| 15 | `handleInquiry` | Closes the MCP connection |
| 16 | `invoke` | Checks the response against `invocationResponseSchema` and sends it with 200 |

A refused token exchange ends the run with "The agent could not get a token for the case system: " followed by the provider's refusal. An unavailable exchange returns "The agent could not get a token for the case system: the identity provider could not be reached or did not answer in time." No address appears in that reason. The exchange is not retried.

If tool discovery omits `create_case` or `add_follow_up`, the run fails before inference and names the missing tools. Other discovered tools are excluded; any model request for one is refused as `unknown_tool`.

## One tool call

`runToolCall` validates each proposed call, executes it when allowed, and returns the result to the model. The loop checks the tool name and JSON arguments. Shared rules in `refusalBeforeCall` enforce one case per run; `afterCall` decides whether a write has settled or needs its one retry.

```mermaid
flowchart TD
    A["The model asks for a tool"] --> B{"One of the listed tools?"}
    B -- no --> R1["Refused: unknown_tool"]
    B -- yes --> C{"Arguments a JSON object?"}
    C -- no --> R2["Refused: arguments_not_json"]
    C -- yes --> D{"create_case, when this run<br/>already has a case?"}
    D -- yes --> R3["Refused: case_already_opened_in_this_run"]
    D -- no --> E{"add_follow_up to the case<br/>this run has?"}
    E -- yes --> R4["Refused: follow_up_to_case_opened_in_this_run"]
    E -- no --> F["callOnce, requested by the model"]
    F --> G{"Did the case system answer?"}
    G -- yes --> OK["Its answer goes to the model"]
    G -- no --> I["callOnce again, same content,<br/>requested by the agent"]
    I --> J{"Did it answer?"}
    J -- yes --> OK
    J -- no --> U["Run is unsettled:<br/>it ends as failed"]
```

- A refusal makes no call. It is recorded as a tool step with `is_error`, and the model is told why.
- "This run has a case" means the case system answered `create_case` with a case: newly created, recognised as a repeat, or refused because a case is already open for this message.
- An answer from the case system that is itself a refusal still counts as an answer. Only silence triggers the repeat.

## A failed request to the model

`askModel` in `intake/handwritten.ts` retries selected model failures. These requests cannot change a case. Writes follow the separate retry rule above.

| Question | Answer | Why |
|---|---|---|
| Which failures are sent again | The connection failed, or the status is 408, 429 or 5xx | These failures may be temporary; `model/chat.ts` marks them `retryable` |
| Which are not | Any other status, such as 400 or 401, and an answer that is not in the expected form | The same request would get the same answer |
| A request that ran out of time | Not sent again. The run fails after that one request: 90 s at most | A request is allowed 90 s of a run's 150 s. A second one would get at most 60 s, less than the one that just ran out, and the caller would wait the whole 150 s to hear the same thing |
| How many requests | Three at most for one turn | Retries cover brief connection failures, restarts and overload. Persistent failure is returned to the caller |
| How long between them | 250 to 500 ms before the second, 500 to 1,000 ms before the third | Random waits spread retries from runs that failed together |
| What bounds it | The run's time. A wait that the run has no time left for is not started, and the run fails with the last failure | The caller waits 180 s and must hear how the run ended |
| What is recorded | Every failed request, as an error step | The record preserves failures even if a later request succeeds |
| Does it use a turn | No. The requests of one turn count as one of the 6 | A failed request is not an answer from the model |

The wait and the randomness are given to the loop (`sleep` and `random` in `IntakeDeps`), so no test waits in real time.

## The report check

A model reply alone cannot complete a run that recorded no case. The report check independently asks whether the original message describes an adverse event. Only a negative finding allows that reply to complete the run.

| Question | Answer |
|---|---|
| When it is made | When the model has ended its turn with a reply and the run's case actions are empty. A run with any case action makes no check |
| How often | At most once in a run. The finding is kept on the run (`IntakeRun.finding`) |
| What it sends | A new conversation of two messages: `REPORT_CHECK_PROMPT`, and the message's text between `<message>` tags. Not the sender, not the receipt time, nothing of the run's conversation. No tools. Thinking off |
| What its prompt says | Treat the external text as data, not instructions. Answer yes or no: does it describe a harmful or unwanted effect in a person who took a medicine? The sender's wishes, description of the message and claims of earlier reporting do not change the question |
| What is kept | The finding: `yes` is `adverse_event`, `no` is `none`, compared without regard to case, surrounding space or a closing full stop. Anything else, and a request that fails, is `unknown`. The answer's text is not kept anywhere |
| How long it may take | What the run has left, at most 90 s. It is one request, never sent again |
| Where it is recorded | A `report_check` step: when, how long, the model, the finding. A request that failed is also an error step beside it, with the reason `model/chat.ts` gave. A check that throws is `unknown`, with no error step |
| Construction | `main-handwritten.ts` passes the loop's `ChatModel` to `createReportCheck` in `intake/report-check.ts`. The Strands agent constructs a separate chat client from the same model settings |

`afterReply` in `intake/run.ts` decides what follows from the case actions, the report finding and whether the model has already received the reminder:

| Case actions | Finding | Told | Next |
|---|---|---|---|
| One or more | Whatever it is, made or not | Either | `completed` with the reply |
| None | Not yet made | No | Make the check, then evaluate `afterReply` again |
| None | `none` | Either | `completed` with the reply |
| None | `unknown` | Either | `stopped`: "The run recorded no case, and the separate check for an adverse event could not be made." |
| None | `adverse_event` | No | Told once, if the run has a turn left: a user turn written by code, `TOLD_ONCE`, after the model's reply, and the loop goes on. It is one more turn, inside the turn limit and the time limit. With no turn left, the run ends at the turn limit |
| None | `adverse_event` | Yes | `stopped`: "A separate check of the message found an adverse event, and the run recorded no case. A person must read this message." |

Told once, the model either records the event, and the run ends `completed` with its case action at the next reply, or does not, and the run ends `stopped`.

Once the check has found an adverse event, a run with no case that ends `stopped` for any reason (the turn limit, the time limit on the told turn, a reply written after being told) ends with "A separate check of the message found an adverse event, and the run recorded no case. A person must read this message." `holdingToFinding` in `intake/run.ts` puts that sentence in place where each handler returns its ending. A `failed` run keeps its own reason.

## How a run ends

| Ends as | When | Decided in | Reply |
|---|---|---|---|
| `completed` | The model asks for no tools and writes text, and the run has a case action or its report check found no adverse event | `loop`, by `afterReply` | The model's text |
| `stopped` | The model replies with no case recorded, and the report check could not be made or answered neither yes nor no | `loop`, by `afterReply` | Empty |
| `stopped` | The model replies with no case recorded after being told once to record what the report check found | `loop`, by `afterReply` | Empty |
| `stopped`, with the report check's sentence | The report check found an adverse event, no case was recorded, and the run then stopped at the turn limit or the time limit | `handleInquiry`, by `holdingToFinding` | Empty |
| `stopped` | The run's time is used up when a turn is about to start | `loop` | Empty |
| `stopped` | The turn limit is reached | `loop` | Empty |
| `stopped` | The model asks for no tools and writes nothing | `loop` | Empty |
| `failed` | At the start, the caller's token cannot be exchanged for the case-system token, or the case system cannot be reached, refuses the token, cannot check it, or does not offer both `create_case` and `add_follow_up` | `connectWithToolToken`, `handleInquiry` | Empty |
| `failed` | A request to the model still fails after being sent three times, or fails in a way that sending again would not change | `askModel`, then `loop` | Empty |
| `failed` | A write got no answer twice | `runToolCall`, then `loop` | Empty |
| `failed` | `MODEL_ID` is unset and the model server could not say which one model it serves: not reached, not in time, another status, or not exactly one model | Handler in `run/serve.ts` | Empty |
| `failed` | The handler threw | `invoke` in `contract/server.ts` | Empty |

An empty reply gets one retry if the turn exhausted its output allowance (`finish_reason` `length`) while thinking was on. `askAgainWithoutThinking` disables thinking for the rest of the run. The empty turn remains in the record and counts against the turn limit.

If the exhausted turn contains text, `atReply` applies the normal reply rules. A completed run can therefore return truncated text. The Strands implementation stops with no reply in this case.

These answers are not outcomes of a run: 401 for a refused token, 403 for a token that lacks the scope, 503 when the token cannot be checked, 400 for a body over the limit, not JSON, or outside the contract, 404 for another path, 405 for another method on `/invocations`, and 500 if the agent's own response is outside the contract or the request could not be handled.

## The caller's token

`settingsFrom` in `intake/serve.ts` delegates token settings to `agentSettingsFrom` in `run/serve.ts`:

| Setting | Role or lab value |
|---|---|
| `AUTH_DISCOVERY_URL`, `AUTH_ISSUER` | Provider discovery endpoint and expected issuer |
| `AUTH_ALLOWED_AUDIENCE` | `intake-handwritten`, this agent's id |
| `AUTH_ALLOWED_CLIENTS` | `desk,lab-explorer` |
| `AUTH_REQUIRED_SCOPES` | `agents:intake` |
| `AUTH_ROLES_CLAIM` | `roles` |
| Minimum token life | 150 s, the run limit |
| `EXCHANGE_TOKEN_ENDPOINT`, `EXCHANGE_CLIENT_SECRET` | Exchange endpoint and client secret; `AGENT_ID` is the client id. The agent never writes the secret to its output |

| Order | Check | Refused as |
|---|---|---|
| 1 | An `Authorization: Bearer` header | `missing` |
| 2 | A JWT whose header names RS256 | `malformed`, or `bad_signature` for any other algorithm, `none` included |
| 3 | Signature against the provider's published keys (fetched once and cached; fetched again, at most every 30 s, for a key not yet seen) | `bad_signature` |
| 4 | Not past `exp` | `expired` |
| 5 | `iss` equals `AUTH_ISSUER` | `wrong_issuer` |
| 6 | `aud` contains `AUTH_ALLOWED_AUDIENCE` | `wrong_audience` |
| 7 | `client_id` is in `AUTH_ALLOWED_CLIENTS` | `wrong_client` |
| 8 | `scope` holds at least one of `AUTH_REQUIRED_SCOPES` | `insufficient_scope`: 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="agents:intake"` and `{"error":"forbidden","reason":"insufficient_scope","detail"}` |
| 9 | An `exp` claim, with at least 150 s left before it | `malformed` without one, `expires_too_soon` |
| 10 | `sub`, `preferred_username`, `name` present and not empty; the roles claim a list of names if present | `malformed` |

A refusal is 401 with `WWW-Authenticate: Bearer error="invalid_token"` and `{"error":"unauthorized","reason","detail"}`, except a token without the scope, which is 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="agents:intake"` and `{"error":"forbidden","reason","detail"}`. The check returns 503 `identity_unavailable` if discovery or key retrieval exceeds 5 s, returns a non-200 status, or supplies unusable metadata: a different issuer, no key set or unusable keys. Neither token refusal nor provider failure calls the handler or includes the token in the response. Failed fetches are not cached, so the next request retries the provider.

The case system never sees this token. The agent exchanges it for the case-system token (step 5a), which the case system checks with its own settings (`tools/case-system/compose.yaml`). A token the agent accepts whose exchange is refused fails the run before anything is connected, with the reason in step 5a.

## What the agent exports

With `TELEMETRY_ENDPOINT` set, the agent exports one span for each operation as that operation ends, through [`shared/telemetry.ts`](../../shared/telemetry.ts), to the [trace store](../../platform/telemetry/README.md). A span does not wait for the run: when a run later throws, runs out of time, or its answer never reaches the caller, the spans of the calls it made are already on their way. With the setting unset or empty the same code runs and records nothing, and the agent says so once at start. The response's `steps` are unchanged and remain a separate record.

| Span | Kind | Made in | Attributes | Outcome |
|---|---|---|---|---|
| `agent.run` | server | `invoke` in `contract/server.ts`, around the handler | `gen_ai.agent.id`, `lab.inquiry.id` (the message's id) | The response's: `completed`, `stopped` or `failed`. `failed` when the handler throws or answers outside the contract; the answer is the same as without telemetry |
| `model.call` | client | `modelCallSpan` in `run/spans.ts`, for each request `askModel` sends and for the report check's request in `createReportCheck` | `gen_ai.request.model`, `lab.operation.id`, `lab.attempt`, `lab.finish_reason`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`. A count the model server did not report is left out, never 0 | `executed`; `response_lost` when no answer came (the time ran out or the connection failed); `failed` for any other failure |
| `tool.call` | client | `toolCallSpan` and `refusedToolCallSpan` in `run/spans.ts`, from `callOnce` and `runToolCall` | `gen_ai.tool.name` (only a tool the model was shown), `lab.requested_by` (`model` or `agent`, as the step records it), `lab.operation.id`, `lab.attempt` | `executed`; `refused` when the agent's rules refuse the call and nothing is sent, or the case system answers with a refusal; `response_lost` when no answer came |

`agent.run` is a child of the request's `traceparent` when it has a usable one, and starts a new trace otherwise. Every `model.call` and `tool.call` is a child of `agent.run`, and each ends before the next operation starts.

| Operation | `lab.operation.id` | `lab.attempt` |
|---|---|---|
| Turn *n* | `model:turn-<n>` | 1 to 3, one for each request sent for the turn |
| The report check | `model:report-check` | 1 |
| The *k*-th tool call the model asked for in turn *n* | `tool:turn-<n>:<k>` | 1, and 2 for the one repeat of a write that got no answer |

Each request to the case system carries a `traceparent` written inside the span of the tool call it belongs to: `connectCaseTools` gives the MCP transport a `fetch` that writes it on every request it sends, so the case system's span for a call is a child of that call's `tool.call`. The requests that connect, list the tools and close carry the run's span.

A span never holds the message's text or sender, a tool's arguments or result, the model's reply, a token, a key or an address. A tool name the model invented is not recorded. A value the module would refuse, such as a message id over 256 characters, an empty finish reason or a token count that is not a whole number, is left out of the span and the call goes on.

On SIGTERM or SIGINT the agent closes its server, gives the spans still waiting up to 5 s to be sent, and logs how many spans ended, were exported, failed, were dropped and were not sent.

## Always true

1. A request that matches the contract, with an accepted token, gets 200 with an outcome and every step taken, whatever went wrong after it was accepted. Two exceptions: a handler that throws is answered 200 `failed` with no steps, and a response of the agent's own outside the contract is 500.
2. The model makes no call. A call the agent's rules refuse never reaches the case system, and the model is told it was refused. Every call that does reach it is one the model asked for, or the one repeat the agent's code makes itself.
3. The message identifier, the receipt time and the sender reach the case system as headers set by code when the connection is opened, beside the token the agent got for the case system. None is in the tool descriptions, so the model cannot supply them. The agent's own name is not sent: the case system takes it from that token.
3a. No handler runs, and no body is read, for a request without an accepted access token. A token is accepted only if it has at least the run's 150 s left, so it cannot expire during the run it starts.
3b. The case system checks the token the agent sends, before it reads the request. A refusal when the agent connects fails the run with "The case system refused the agent's token."; a case system that cannot check tokens, with "The case system could not check the agent's token."; a case system that does not offer both of the agent's tools, with the tools that are missing. The model is not asked in any of these cases.
4. A run opens at most one case for its message and adds no version to that case.
5. The agent has no lookup: no tool it is offered returns what a case holds. A follow-up is accepted only on a case the message's sender has reported on, named by its id; the case system enforces that from the sender header, and a case from another sender is answered exactly as a case that does not exist. A follow-up that names no case is recorded as a new case.
6. A write that got no answer is repeated at most once, by code, with identical content. The model is not asked to repeat it.
7. If it is not known whether a write happened, the run fails and carries no reply.
8. Every tool the model asks for gets exactly one tool message back, in the order asked.
9. Every model turn, every tool call, every refusal and every failed request to the model is a step in the response.
10. Case actions are built from the case system's answers, never from what the model wrote.
11. A run has at most 6 turns with the model, makes at most 3 requests for each, and starts no turn after 150 seconds.
12. The response contains no token, no address and no key.
13. The agent stores nothing, and runs share no state. What it knows about a run is in the response, and as metadata in the spans it exports; what it changed is in the case system.
14. A run that recorded no case ends `completed` only when the report check found no adverse event. The report check is one separate request to the model, made by code, at most once in a run: it is shown the message and nothing else, it is given no tools, and only its answer of yes or no is kept, never its text. The check is a step in the response, and a request for it that failed is also an error step with the reason. When it finds an adverse event, the model is told once, in a sentence written by code, to record it, if the run has a turn left. A run in which the check found an adverse event and which then ends `stopped` with no case, for whatever reason, ends with "A separate check of the message found an adverse event, and the run recorded no case. A person must read this message." When the check cannot be made, or answers neither yes nor no, the run ends `stopped` with "The run recorded no case, and the separate check for an adverse event could not be made." A run that recorded a case makes no report check.
15. Every request to the model, the report check's included, and every tool call is a span that ends when the call ends, so it is exported even when the run later throws.
16. A call the rules refuse is a `tool.call` span with outcome `refused`, and nothing is sent. A write repeated after getting no answer is a second `tool.call` span with the same `lab.operation.id` and the next `lab.attempt`, requested by the agent.
17. A request to the case system for a tool call carries the `traceparent` of that call's own `tool.call` span.

`agents/test/intake.test.ts` has one test for each item, `intake 1` to `intake 17`, calling the handler with a scripted model and scripted tools, and for 15 to 17 a telemetry handle with an in-memory exporter. `intake 17` connects to the scripted MCP server in `agents/test/support.ts`, because the header is written by the MCP connection. `intake 12` shows the token; the handler is given no address and no key. 3a and 3b have no test there, because the handler makes neither check. In 3a, `runtime 1` shows a request answered before its body is read and `shared 1` a token refused for having less life left than the service asks for. In 3b, `case-system 8` shows the token judged before the request is read, and a connection that fails and a case system that offers one of the two tools are rows of `intake 1`.

## Where untrusted text goes

```mermaid
flowchart LR
    U["Message text and sender<br/>UNTRUSTED"] --> P["userTurn<br/>placed between message tags,<br/>as given"]
    SP["SYSTEM_PROMPT<br/>trusted"] --> MD["Model"]
    P --> MD
    MD -->|"tool name and arguments<br/>UNTRUSTED model output"| R["runToolCall<br/>checks name, JSON, one-case rules"]
    R -->|"arguments as given"| K["Case system<br/>stores the text"]
    K -->|"receipts: case id, status,<br/>version, what is missing<br/>returned as tool output"| MD
    MD -->|"reply<br/>UNTRUSTED model output, unchecked"| C["Caller"]
    U --> RC["report check<br/>message text alone, between message tags,<br/>with REPORT_CHECK_PROMPT, no tools"]
    RC --> MD2["Model, a separate request"]
    MD2 -->|"answer<br/>UNTRUSTED, read as yes or no only"| F["finding<br/>adverse_event, none or unknown"]
    F -->|"afterReply"| R2["run: completes, tells the model once<br/>in code's words, or stops"]
    R -->|"steps: full arguments and results"| C
```

The report check receives only the message text. Its output is reduced to a finding; code supplies the fixed reminder when another turn is allowed.

The model can affect the case system only through the two tools. Whatever instructions it follows, `runToolCall` and the case system still enforce the boundaries: no tool approves, rejects or deletes a case; a message opens one case; a person reviews every case.

## Not present

The tables identify missing controls and their consequences at each boundary.

### Who is calling

| Missing | Where it would sit | What follows |
|---|---|---|
| Proof of who sent the message | The request | The caller supplies `sender` as free text. Follow-up ownership compares that text without case or spacing differences. A caller with another sender's text and case id can add to that case |
| A check of the identifier and receipt time | `invoke` | Both are forwarded as given. A second identifier for the same message opens a second case. A receipt time in the past is accepted, so the start of the reporting clock can be set by the caller |
| A token limited to one run | `connectWithToolToken` | The case-system token is limited to this agent and its one scope, not to the run or the message: until it expires it is good for any run of this agent for that user |
| Special handling of a token refused mid-run | `ToolSet.call` | A tool call the case system refuses (401) or cannot check (503) after the connection was accepted falls under the rules for a call that got no answer (see "One tool call") |
| A check of the caller's roles | `invoke` | Any accepted token may submit a message; the roles are given to the handler and not used |
| Encryption between the pieces | Every hop: the caller, the model server, the case system, the identity provider | Plain HTTP. The model server's key, the agent's client secret and both tokens cross the local network unencrypted |
| Rotation of the model server's key | `run/serve.ts` | One long-lived key, read from a file into an environment variable |

### What goes into the model

| Missing | Where it would sit | What follows |
|---|---|---|
| Scrubbing of the message | `userTurn`, or before `handleInquiry` | The text reaches the model, the case system, the steps and the caller's store exactly as sent, patient details included |
| A limit on message length | `invoke` | Only the 1,000,000-byte body limit applies to direct callers. The client separately limits text to 10,000 characters |
| Escaping of the message block | `userTurn`, and the report check's message in `createReportCheck` | A message that contains the closing tag ends the block early, and what follows it sits outside the block, in the run's conversation and in the report check's request alike |
| Detection of instructions in the message | Before the first turn | Rule 1 of the prompt instructs the model to disregard embedded instructions; code does not detect them |
| Marking of tool results as untrusted | `loop`, where tool messages are appended | Tool results enter the conversation as ordinary tool output. They are receipts, which carry no text from any message |

### What the model may cause

| Missing | Where it would sit | What follows |
|---|---|---|
| A check of arguments against the message | `runToolCall` | The model can record a detail the message does not contain. The case system checks that each part is present, not that it is true |
| Recognition of one event reported by two senders | The case system | A second clinician reporting the same patient and event cannot name the first sender's case, so a second case is opened. Nothing links the two |

### What comes out

| Missing | Where it would sit | What follows |
|---|---|---|
| A check of the reply | `loop`, before `completed` | The reply is the model's text as written. It can say something the tools did not say, or answer a clinical question |
| Redaction of the steps | The record in `run/steps.ts` | Steps carry full tool arguments and results to the caller, which stores them |

### Running it

| Missing | Where it would sit | What follows |
|---|---|---|
| Rate and concurrency limits | `createContractServer` | Each run can last 150 s, with no bound on concurrent runs. Concurrent runs of the same message can race; the case system still opens one case |
| Reading of `Retry-After` | `askModel` | The loop ignores the header and uses its own waits: 250 to 500 ms, then 500 to 1,000 ms. The local model server does not send the header |
| A shared view of the model's health | Around `askModel` | Each run decides on its own. While the model server is down, every run in flight sends its three requests |
| A record kept by the agent | The endings in `run/endings.ts` | If the caller goes away mid-run, the steps are lost. What remains is the case system's audit trail, the spans already exported, which hold no content, and the agent's error output |
| Metrics | Around `complete` and `ToolSet.call` | No measurement is exported. A span carries its times and token counts, and a step its own timing and token counts |
| The model's reasoning text | `createChatModel` | It is received and discarded. Only its cost appears, inside `output_tokens` |
| The prompt's version in the response | The endings in `run/endings.ts` | The response names the model. It does not say which prompt, temperature or seed produced it |
| A health check of what it depends on | `GET /ping` | `/ping` says `Healthy` when the model server or the case system is down |

## Limits and settings

| Setting | Value | Set in |
|---|---|---|
| Turns in a run | 6 | `intake/settings.ts` |
| Time for a run | 150 s | `intake/settings.ts` |
| Time for one model request | 90 s, or what the run has left | `intake/settings.ts`, `Deadline.within` |
| Requests for one turn | 3 at most | `MODEL_RETRY` in `intake/handwritten.ts` |
| Report checks in a run | 1 at most, one request, not sent again | `afterReply` in `intake/run.ts`, `createReportCheck` in `intake/report-check.ts` |
| Time for the report check | 90 s, or what the run has left | `intake/settings.ts`, `Deadline.within` |
| Thinking, for the report check | Off | `createReportCheck` in `intake/report-check.ts` |
| Wait before a further request | 250 to 500 ms, then 500 to 1,000 ms | `waitBeforeRequest` in `intake/handwritten.ts` |
| Time for one tool call | 10 s, or what the run has left | `intake/settings.ts`, `Deadline.within` |
| Time to exchange the caller's token | 10 s, or what the run has left, shared with connecting | `intake/settings.ts`, `Deadline.within` |
| Time to connect to the case system, and to list its tools | What the exchange left of that limit, each | `connectWithToolToken` in `tools/tool-token.ts` |
| Time to ask the model server which model it serves | 10 s | `run/serve.ts` |
| Time to fetch the identity provider's discovery document or its keys | 5 s | `run/serve.ts` |
| Request body | 1,000,000 bytes | `contract/server.ts` |
| Model temperature, seed | 0, fixed | `run/sampling.ts` |
| Output allowance for a turn | 2,048 tokens, thinking included | `run/sampling.ts` |
| Thinking | On, until a turn is lost to it | `loop` |
| Model server address and key | `MODEL_BASE_URL`, `MODEL_API_KEY` | `model/.env`, through `agents/compose.yaml` |
| Model name | Asked of the model server, unless `MODEL_ID` is set | `run/serve.ts` |
| Case system address | `CASE_MCP_URL` | `agents/compose.yaml` |
| Agent's name | `AGENT_ID` | `agents/compose.yaml` |
| Access-token check | `AUTH_DISCOVERY_URL`, `AUTH_ISSUER`, `AUTH_ALLOWED_AUDIENCE`, `AUTH_ALLOWED_CLIENTS`, `AUTH_REQUIRED_SCOPES`, `AUTH_ROLES_CLAIM` | `agents/compose.yaml` |
| Token exchange | `EXCHANGE_TOKEN_ENDPOINT`, `EXCHANGE_CLIENT_SECRET`; the client id is `AGENT_ID` | `agents/compose.yaml`; the secret from `platform/identity/.env` |
| Minimum life left on a token | 150 s, the run's time limit | `agentSettingsFrom` in `run/serve.ts`, with the limits from `intake/settings.ts` |
| Wait before fetching the keys again | 30 s | `run/serve.ts` |
| Where spans are exported | `TELEMETRY_ENDPOINT`, optional: unset or empty, nothing is exported. Not an http or https URL: the agent stops at start (exit 2) naming the setting | `agents/compose.yaml`, read in `run/serve.ts` |
| Span queue | `LAB_QUEUE`: at most 2,048 waiting, batches of at most 512, sent at least every second, 5 s for an export | `shared/telemetry.ts` |
| Time to send waiting spans at shutdown | 5 s | `run/serve.ts` |

## Who owns what

| Owner | Owns |
|---|---|
| `shared/agent-contract.ts` | The shape of a request and a response |
| The caller | The message's identifier, receipt time and sender, its access token, and keeping the response |
| The identity provider | Who the caller is: the access token's claims and the keys that sign it. Whether the agent gets a case-system token for the caller, and with which scopes |
| The agent | The order of work, the rules of a tool call, and the run's record |
| The case system | Whether a case exists, whether it is complete, its versions and its audit trail, the one-case-per-message rule, and which sender may add to a case |
| The model server | Which model answers |
| A reviewer | Whether a case is approved, rejected or sent back for information |
