# The intake agent as an actor

An agent is an actor in which a step of the behaviour is decided by inference; the intake agent has two such steps, its model's turn and the report check. This document reads the intake agent that way. It holds for both implementations, the [hand-written loop](intake-agent-handwritten.md) and the one [on Strands](intake-agent-strands.md); where they differ, a table says so. Terms and module boundaries are in those two documents.

## The parts of an actor, and where each one is

| An actor has | In the intake agent | Where |
|---|---|---|
| A mailbox | `POST /invocations`, with an accepted access token. One message per request | `contract/server.ts` for the hand-written loop; the local edge (`contract/edge.ts`) and AWS's SDK app (`contract/sdk-app.ts`) for Strands |
| State that nothing else can touch | The run: its steps, its case actions, the case it opened, whether a write is unsettled, what its report check found, whether the model has been told to record it, its deadline. And the conversation with the model | `IntakeRun` in `intake/run.ts`, built on `RunState` in `run/state.ts`; the conversation held by the loop |
| A behaviour: what it does when a message arrives | Ask the model, apply the rules, call the case system, answer | `intake/handwritten.ts`, or Strands' `Agent` with four hooks in `intake/strands.ts` |
| Messages it sends to other actors | Requests to the model server (the run's turns, and at most one report check) and to the case system, requests to the identity provider (its discovery document and keys, and one token exchange a run), and one answer to the caller | `model/chat.ts` or Strands' `OpenAIModel` for the turns, `model/chat.ts` in both for the report check (`intake/report-check.ts`); `tools/case-system.ts` or Strands' `McpClient`; `shared/access-token.ts` |
| A lifetime | One message. Each message gets a new run with new state, and nothing is kept once it is answered | `startRun` in `intake/run.ts` |

Two steps of the behaviour are not written in code. What to do next, given the conversation so far, is asked of the agent's model; that is where it decides whether the message is a report. When the model replies and the run has recorded no case, the report check asks the same question again: a second inference, made by code in a separate request that is shown the message alone, whose yes or no code then acts on. Every other step is ordinary code.

## The actors and their messages

```mermaid
flowchart LR
    Caller["Caller<br/>the client's server, and for the agent<br/>on Strands the orchestrator too"]
    Agent["Intake agent<br/>one run per message"]
    Model["Model server<br/>inference"]
    Cases["Case system"]
    Identity["Identity provider"]
    Reviewer["Reviewer<br/>a person"]

    Caller -->|"message: id, receipt time,<br/>sender, text, with an access token"| Agent
    Agent -->|"answer: outcome, reply,<br/>case actions, steps,<br/>citations always empty"| Caller
    Agent -->|"conversation and<br/>tool descriptions"| Model
    Model -->|"text, or requests<br/>for tools"| Agent
    Agent -->|"tool call, with context headers<br/>and the case-system token"| Cases
    Cases -->|"result, refusal,<br/>or nothing"| Agent
    Agent -->|"discovery document, signing keys,<br/>and one token exchange a run"| Identity
    Cases -->|"discovery document<br/>and signing keys"| Identity
    Reviewer -->|"approve, reject or<br/>ask for information"| Cases
```

Every message is a request that waits for its answer, with a time limit. None is sent and forgotten.

| Actor | State it owns | What it decides |
|---|---|---|
| Caller | The message's identifier, receipt time and sender; the access token; the answers it was given | Which agent is sent the message, and whether to send it again |
| Intake agent | One run, discarded when answered | The order of work, whether a call may be made, and how the run ends |
| Model server | Nothing between requests | What to write, or which tool to ask for, given the conversation it is sent |
| Case system | Cases, their versions and the audit trail | Whether a case exists, is complete or is a repeat, and which sender may add to it |
| Identity provider | Who the caller is: the token's claims and the keys that sign it | Which tokens it issues |
| Reviewer | Nothing | Whether a case is approved, rejected or sent back for information |

## The behaviour for one message

A six-sided box is decided by the agent's model. The report check is a slanted box, a message to the model server, whose answer is a second inference made by code; the diamond after it reads that answer as yes, no or neither. Every other diamond is decided by code. A slanted box is a message sent to another actor. A rounded box is an ending.

```mermaid
flowchart TD
    Arrive(["A message arrives"]) --> Token{"An accepted<br/>access token?"}
    Token -- no --> RefusedToken(["Refused with status 401,<br/>403 if it lacks only the scope,<br/>or 503 if it cannot be checked.<br/>The body is not read"])
    Token -- yes --> Valid{"Does it match<br/>the contract?"}
    Valid -- no --> Refused(["Refused with status 400.<br/>Nothing runs"])
    Valid -- yes --> Start["Start a run:<br/>new state, a deadline"]
    Start --> Connect[/"Exchange the caller's token for<br/>the case-system token, connect to<br/>the case system and list its tools"/]
    Connect --> Reached{"Exchanged, reached,<br/>the token accepted and<br/>both tools offered?"}
    Reached -- no --> FailedStart(["failed"])
    Reached -- yes --> Limits{"Any turns and<br/>time left?"}

    Limits -- no --> StoppedLimit(["stopped: the limit is named,<br/>or, once the report check found<br/>an adverse event, that a person<br/>must read this message"])
    Limits -- yes --> Ask[/"Ask the model:<br/>the conversation and the tools"/]
    Ask --> Answered{"Did it answer?"}
    Answered -- "no, and resending<br/>could help" --> Ask
    Answered -- no --> FailedModel(["failed"])
    Answered -- yes --> Infer{{"INFERENCE<br/>Write a reply,<br/>or ask for tools?"}}

    Infer -- "wrote text" --> Recorded{"A case action<br/>in this run?"}
    Recorded -- yes --> Completed(["completed:<br/>the text is the reply"])
    Recorded -- no --> Checked{"Report check<br/>made already?"}
    Checked -- no --> Check[/"Report check: ask the model, separately,<br/>with the message alone and no tools,<br/>whether it describes an adverse event"/]
    Check --> Finding{"Its finding"}
    Checked -- yes --> Finding
    Finding -- "no" --> Completed
    Finding -- "neither yes nor no,<br/>or not made" --> StoppedCheck(["stopped:<br/>the check could not be made"])
    Finding -- "yes" --> Told{"Told already?"}
    Told -- no --> TellOnce["Tell the model once,<br/>in code's words, to record it"]
    TellOnce --> Limits
    Told -- yes --> StoppedFound(["stopped:<br/>a person must read this message"])
    Infer -- "wrote nothing" --> Lost{"Cut off by the output<br/>allowance, with thinking on?"}
    Lost -- no --> StoppedEmpty(["stopped:<br/>no reply"])
    Lost -- yes --> ThinkingOff["Turn thinking off"]
    ThinkingOff --> Limits

    Infer -- "asked for tools" --> Tools["Handle each tool request,<br/>in order (next diagram),<br/>none after an unsettled write"]
    Tools --> Settled{"Is a write<br/>unsettled?"}
    Settled -- yes --> Unsettled(["failed: not known whether<br/>the case was recorded. No reply"])
    Settled -- no --> Limits

    classDef inference stroke-width:3px,stroke-dasharray:6 3
    class Infer inference
```

A turn is one pass from "Any turns and time left?" through the model and back. A run has at most 6 turns and 150 seconds.

## The behaviour for one tool request

Inference asked for the tool. Every box here is code. Both tools the model is shown change a case, so a call that got no answer is always a write that may or may not have happened.

```mermaid
flowchart TD
    Asked(["The model asked for a tool"]) --> Known{"Does the tool exist,<br/>with JSON arguments?"}
    Known -- no --> Tell["The model is told why.<br/>Nothing is called"]
    Known -- yes --> Allowed{"A second case, or a follow-up<br/>to this run's own case?"}
    Allowed -- yes --> Tell
    Allowed -- no --> Call[/"Call the case system"/]

    Call --> Reply{"Did it answer?"}
    Reply -- yes --> Record["Record the result.<br/>Note any case it opened or found"]
    Reply -- no --> Repeated{"Repeated<br/>already?"}
    Repeated -- "no: repeat it,<br/>same content" --> Call
    Repeated -- yes --> Unsettled(["The write is unsettled.<br/>The run fails"])

    Tell --> Append(["What the model is told<br/>goes into the conversation"])
    Record --> Append
```

### Where an implementation differs from the diagrams

| Step | Hand-written loop | Strands |
|---|---|---|
| "Did it answer?" for the model | The loop sends a failed request again: up to 3 requests for a turn, never one that ran out of time | The OpenAI client inside Strands sends it again, timed-out ones included; Strands adds its own retry when the model throttles |
| "Does the tool exist, with JSON arguments?" | The loop's own check | Strands' check. Arguments that are not JSON end the run as `failed` instead of being told to the model |
| "wrote text", when the text was cut off by the output allowance | A reply like any other: the diagram goes on from "wrote text" | `stopped`, with no reply |
| "Turn thinking off" | Uses one of the 6 turns | Does not use a turn |
| "Tell the model once" | One more turn of the same loop | A second `invoke` of the same `Agent`, with the same hooks and cancel signal and the turns the first left |
| "Report check" | Made by the loop's own chat client | Made outside Strands, by this agent's code, with the chat client |
| Where the diamonds are evaluated | Inline, in the order drawn | In hooks Strands calls before and after each model call and tool call |
| "An accepted access token?" and "Does it match the contract?" | `contract/server.ts` | The local edge checks the token, then AWS's SDK app checks the body and `contract/sdk-app.ts` checks the token again. Their 400 answers have the SDK's shapes ([agent-runtime.md](agent-runtime.md)) |

## Who decides what

| Decision | Decided by | Held in check by |
|---|---|---|
| Whether the message reports an adverse event | Inference | The prompt, and the report check: a second, separate inference made by code, whose yes or no decides, through `afterReply` in `intake/run.ts`, whether a run that recorded no case may end `completed` |
| Which tool to ask for, and its arguments | Inference | Code: the tool must exist and the arguments must be JSON. The case system: each part of a report must be present |
| Whether a call is made | Code | `refusalBeforeCall` in `intake/run.ts` |
| Whether a write that got no answer is repeated | Code | `afterCall` in `intake/run.ts`: once, with identical content |
| Whether a case exists, is a repeat or is complete | The case system | Its own rules, keyed on the message identifier and the sender |
| What the reply says | Inference | Nothing. The reply is returned as written |
| How the run ends | Code | The named endings in `run/endings.ts` |
| Whether a case is approved, rejected or sent back for information | A person | The case system records who and when |
| Whether a request is let in | Code | The access-token check in `shared/access-token.ts`, against the identity provider's keys |

## Always true, in this view

1. Inference sends no message to another actor. It returns a proposal to the agent's code, which makes the call or refuses it.
2. State changes in two places only: the run's own state, which is private and discarded, and the case system, which owns its own.
3. Runs share no state. Two runs of one message meet only at the case system, which opens one case.
4. Every message has a time limit and a defined result when no answer comes.
5. The agent does not fail towards its caller. Once a message is accepted, every failure is an outcome with the steps taken; a handler that throws is an outcome with no steps. The one exception is the hand-written server's 500 when the agent's own response is outside the contract; on the SDK server that is a `failed` outcome too.

## What happens to each message when no answer comes

| Message | When no answer comes | Sent at most | Sending it twice is safe because |
|---|---|---|---|
| Caller to agent | The caller stops waiting at 180 s and records the run as failed | Once for a run. A person may start another run of the same message | The case system recognises the message identifier |
| Agent to model, the report check | The finding is `unknown`, and the run ends `stopped` | Once, in both implementations, by the chat client | It is not sent twice |
| Agent to model | Hand-written loop: a failed connection or a status of 408, 429 or 5xx is sent again; a request that ran out of time is not. Strands: the OpenAI client sends it again, timed-out ones included, and Strands asks again on throttling | Hand-written loop: 3 times for a turn. Strands: 3 for each of up to 6 attempts, within the run's time | Asking the model changes nothing |
| Agent to identity provider, the token exchange | The run ends `failed`: the agent could not get a token for the case system | Once a run | It is not sent twice |
| Agent to identity provider, the discovery document and keys | The token cannot be checked: 503, and the request is not handled. The next request asks again | The discovery document and the keys once, then kept; the keys again for a key not yet seen, at most every 30 s | It is a read |
| Agent to case system, a write | Repeated once by code. If that also gets no answer, the run fails as not known | Twice | The case system recognises identical content for the same message |

## Design choices in this actor

The actor model leaves each of these open. This is what the intake agent chose, and why.

| Choice | What this agent does | Why | What follows |
|---|---|---|---|
| How a message is delivered | A request that is held open until the answer. No queue in front of the agent | The desk wants the outcome of this message: the reply and any case it opened. `/invocations` on AgentCore Runtime is a request and its answer | The caller waits up to 180 s. The client does that waiting in the background, so the person at the desk is not held |
| How long the actor lives | One run for one message. Its state is discarded when it answers | Each message is handled the same whatever came before, and one sender's conversation cannot reach another's. What must last is in the case system | The agent knows nothing of earlier messages. A follow-up reaches an earlier case only by the case id its message names |
| What happens when a run fails | The failure is reported to the caller as an outcome. Nothing restarts the run | Whether to try again is a decision for a person at the desk. Trying again is safe, because the case system opens one case for a message | Another run is started by a person |
| Whether it hands work to other actors | It hands none on | Recording an adverse event is one job with two tools | One agent does the whole job |
