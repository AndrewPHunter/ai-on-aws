# Orchestrator, on Strands

One agent in one container. It receives any inquiry and gets both halves of it done by the two agents that each do one: the [intake agent](intake-agent-strands.md) records an adverse event as a case, and the [label expert](expert-agent.md) answers a question from an approved label. It calls each over the agent contract, as a client does, with a token it gets for that agent.

It serves the same contract as the other agents, through the same startup (`run/serve.ts`), on AWS's SDK server behind the local edge ([agent-runtime.md](agent-runtime.md)).

## Terms

| Term | Meaning |
|---|---|
| Sub-agent | The intake agent on Strands, or the label expert |
| Screening | Sending the message to the intake agent, which decides whether it reports an adverse event and records it |
| Label question | One question about one medicine, written by the orchestrator's model, put to the label expert as a message of its own |
| Round | The label questions the model asks in one turn. They are put at the same time |
| Replaces | A question may name an earlier question it replaces. The reply then shows the later one |
| Delegation | One call to a sub-agent, recorded as a `delegation` step with what was sent and what came back |

## The problem

One inquiry can hold an adverse event report, a question a label answers, both, or neither. Each sub-agent handles one half:

| Agent | Does | Does not |
|---|---|---|
| Intake | Records an adverse event as a case, once per message, even when the message is mainly a question | Answer any question |
| Label expert | Answers from one approved label, every statement checked in code against cited passages | Record anything; it declines a bare adverse event report |

## Constraints

| Constraint | What it forces |
|---|---|
| An adverse event that is not recorded must never look like success | Screening runs on every message, by code. A model's choice cannot skip it, and a run cannot end `completed` without it |
| The case system opens one case per message id | The intake agent receives the original message under its own id. No model-written text reaches it |
| The expert answers from one label, and its checks live in its handler | The expert is called through its contract. A question about two medicines is two calls |
| Text from the message is untrusted | The model cannot stop screening, change what the intake agent receives, or put text in the reply |
| The client and the agents' front doors wait at most 300 s for an answer (Node's `fetch`) | The whole run is limited to 280 s |

## One message

Code screens every message through the intake agent. A model, in Strands' own loop, puts label questions to the expert, reads what comes back, and may ask again. Code writes the reply, placing the expert's checked text word for word.

```mermaid
sequenceDiagram
  participant C as Caller
  participant O as Orchestrator
  participant X as Identity provider
  participant M as Model
  participant I as Intake agent
  participant E as Label expert
  C->>O: POST /invocations (message)
  par screening, by code, always
    O->>X: exchange the caller's token for the intake agent
    O->>I: POST /invocations (the message, unchanged)
    I-->>O: response (case actions)
  and label questions, in the model's loop
    loop at most two rounds
      O->>M: the message, and any results so far
      M-->>O: ask_label_expert(drug, question, replaces)
      O->>O: check each question against the message and the limits
      O->>X: exchange the caller's token for the label expert
      O->>E: POST /invocations (one question each, at the same time)
      E-->>O: response (reply, citations, label answer)
    end
    O->>M: the results
    M-->>O: done
  end
  O->>O: write the reply in code
  O-->>C: response, with a delegation step for each call to a sub-agent
```

## Who decides what

| Part | Decided by | How |
|---|---|---|
| Whether the message is screened | Code | Always, at the start of the run |
| Whether the message reports an adverse event | The intake agent's own model and rules | Unchanged |
| Which label questions to ask, and whether to ask again | The orchestrator's model | One tool, `ask_label_expert({ drug, question, replaces })`, in Strands' default loop. Tool calls of one turn run together, which is Strands' default |
| Whether a question is put | Code | Every number in the question must be in the message (the expert's number rule); at most two questions a round and two rounds; the run must have a sub-agent call's time left |
| What the model reads back | Code | For each question: the expert's label answer, or that it did not complete, its stop reason and its reply |
| The answer to a label question | The label expert | Unchanged |
| The reply | Code | A sentence for each case action, each question as it was put with the expert's reply word for word, and a plain sentence for anything unfinished. What the model wrote is in the run's steps |
| How the run ends | Code | The table under "How it ends" |

## Who the orchestrator is to the sub-agents

| Step | Token |
|---|---|
| The client calls the orchestrator | For the orchestrator alone: audience `orchestrator`, scope `agents:orchestrator`, granted by the roles `desk` and `medical-information` |
| The orchestrator calls the intake agent | Exchanged, as client `orchestrator`: audience `intake-strands`, scope `agents:intake` |
| The orchestrator calls the label expert | Exchanged: audience `expert`, scope `agents:expert:delegated`. Only the orchestrator's client may ask for this scope |
| The sub-agent calls its tool server | Exchanged again by the sub-agent, as it does for any caller |

The expert accepts `agents:expert` or `agents:expert:delegated`. So desk staff reach the expert through the orchestrator and cannot call it directly.

## Always true

1. Every accepted message is sent to the intake agent once, unchanged and under its own id, by code, whatever the model does or fails to do.
2. A label question is put to the expert only if every number in it is in the message, it is within two questions a round and two rounds, and the run has a sub-agent call's time left. A question not put is told to the model and named in the reply. Each question put is one call to the expert; the orchestrator sends none again.
3. The model is shown, for each question, the expert's label answer or that it did not complete, its stop reason and its reply, and nothing else of the run: not the intake agent's result.
4. The reply is written by code. No text from the orchestrator's model is in it, and each expert reply shown is word for word, except that its citation numbers are moved to their place in the combined list. A question that was replaced is not shown.
5. Citations are those of the expert replies shown, in that order, so that each number in the reply names its own citation. Case actions are the intake agent's. `label_answer` is absent.
6. A run ends `completed` only when screening completed and every question asked was answered, or replaced by one that was. Each other ending is the row of "How it ends" that describes it.
7. Each sub-agent is sent a token the orchestrator exchanged for that agent, with its audience and scope, and never the token the orchestrator was called with. An exchange that fails is that call's failure.
8. Every call to a sub-agent is a `delegation` step holding what was sent, and the sub-agent's whole response or the reason there is none.
9. Whatever goes wrong, a run ends with an outcome inside the contract, within 280 s and after at most three model turns.
10. Runs share no state.

## How it ends

| Screening | Label questions | Outcome | `stop_reason` | Reply begins |
|---|---|---|---|---|
| Completed | None asked, or every question (or its replacement) answered | `completed` | none | The results |
| Completed | One not put, one neither answered nor replaced, or the model's loop failed | `stopped` | `label_question_unanswered` | "A question in this message was not answered", then what was obtained |
| Did not complete | A label answer obtained | `stopped` | `adverse_event_screening_incomplete` | "This message has not been screened for an adverse event", why, and "Send it again.", then the label answer |
| Did not complete | Nothing obtained | `failed` | the reason | The reason |

Screening completed means the intake agent's response has outcome `completed`. A question is answered when the expert's response to it has outcome `completed`, whatever its label answer: "no label was found" is an answer. The orchestrator sends no failed call again. Sending the same message again is safe: the case system opens one case per message.

## How it fails

| Failure | Result |
|---|---|
| A sub-agent cannot be reached, answers with a status that is not 200, answers outside the contract, or does not answer in 155 s | A `delegation` step with the reason. For a label question the model is told and may ask another |
| An exchange is refused, or the identity provider does not answer | The same |
| The model's loop fails, or ends with a question unanswered | Screening still runs. `stopped`, `label_question_unanswered` |
| The model asks a question holding a number the message does not | The question is not put; the model is told; the reply says so |
| The message contains instructions | They can change which questions are put. They cannot stop screening, change the message the intake agent receives, or add text to the reply |
| An expert's reply contains instructions | The model reads it, so it can change later questions, inside the same limits and the same question check |

## The numbers

| Number | Value |
|---|---|
| Model turns in a run | 3 |
| Questions in a round | 2 |
| Each model turn | 30 s |
| Each call to a sub-agent | 155 s: the sub-agent's own 150 s, and the round trip |
| The whole run | 280 s |
| A round starts no later than | 125 s into the run, so its calls end inside the run |
| Token life the orchestrator requires | 280 s, the whole run. A sub-agent requires 150 s, and a call starts with at least 155 s left |
| What the client waits for the orchestrator, and the token life it requires first | 295 s and 290 s. The other agents keep 180 s |

## Not present

| Missing | What follows |
|---|---|
| The orchestrator's name in the case system's audit trail | A case opened through the orchestrator names the intake agent as the acting agent. The exchanged token names only the last agent in the chain |
| Asking the sender a question and waiting for the answer | The agent contract is one message in and one response out |
| A third round | A question the first two rounds leave unanswered is named in the reply |
| A measure of how well it splits and asks again | Not measured yet |
