# Shared

The contracts between pieces: the shapes one piece sends and another reads. A piece imports them from here, so both sides are checked against one definition.

| File | Contract | Produced by | Read by |
|---|---|---|---|
| [`agent-contract.ts`](agent-contract.ts) | What an agent is sent at `POST /invocations` and what it returns: the reply, the label passages it cites, what it did to cases, and every step it took | Agents | The client, and later the evaluation harness |
| [`case-contract.ts`](case-contract.ts) | Cases, their versions, their audit trail, and a review decision | The case system | The client |

`agent-contract.ts` is schemas as well as types: whatever calls an agent checks the answer against them.

Two agents implement the agent contract: the intake agent in [`agents/`](../agents/README.md), built once with a hand-written loop and once on Strands. Citations, label-search steps and hand-off steps are defined here but nothing produces them yet.
