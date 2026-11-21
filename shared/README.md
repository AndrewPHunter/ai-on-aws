# Shared

The contracts between pieces: the shapes one piece sends and another reads. A piece imports them from here, so both sides are checked against one definition. Also the one check more than one piece makes on what it is sent: the access token.

| File | Contract | Produced by | Read by |
|---|---|---|---|
| [`agent-contract.ts`](agent-contract.ts) | What an agent is sent at `POST /invocations` and what it returns: the reply, the label passages it cites, what it did to cases, and every step it took | Agents | The client, and later the evaluation harness |
| [`case-contract.ts`](case-contract.ts) | Cases, their versions, their audit trail (with whom an agent acted for, and a reviewer's subject), and a review decision (`{ decision, note? }`: the reviewer comes from the access token) | The case system | The client |
| [`access-token.ts`](access-token.ts) | The check of an access token presented as `Authorization: Bearer`: signature against the identity provider's keys (RS256 only), issuer, audience, allowed `client_id`, expiry and a minimum remaining life. Gives the caller, a named refusal, or "unavailable" when the provider cannot be asked | The identity provider's tokens | The agents and the case system |

`agent-contract.ts` is schemas as well as types: whatever calls an agent checks the answer against them.

`access-token.ts` is configured with the values AgentCore Runtime's JWT authorizer takes (a discovery URL, an allowed audience, allowed client IDs read from `client_id`), and is given its clock and settings rather than reading them.

Two agents implement the agent contract: the intake agent in [`agents/`](../agents/README.md), built once with a hand-written loop and once on Strands. Citations, label-search steps and hand-off steps are defined here but nothing produces them yet.
