# Shared

The contracts between pieces: the shapes one piece sends and another reads. A piece imports them from here, so both sides are checked against one definition.

| File | Contract | Produced by | Read by |
|---|---|---|---|
| [`agent-contract.ts`](agent-contract.ts) | What an agent is sent at `POST /invocations` and what it returns: the reply, the label passages it cites, what it did to cases, and every step it took | Agents | The client, and later the evaluation harness |
| [`case-contract.ts`](case-contract.ts) | Cases, their versions, their audit trail, and a review decision | The case system | The client |

`agent-contract.ts` is schemas as well as types: whatever calls an agent checks the answer against them.

No agent exists yet, so the agent contract has been exercised only by the client's tests, against a stand-in written for those tests.
