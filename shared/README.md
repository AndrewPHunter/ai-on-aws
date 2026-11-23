# Shared

The contracts between pieces: the shapes one piece sends and another reads. A piece imports them from here, so both sides are checked against one definition. Also the one check more than one piece makes on what it is sent, the access token, and the one exchange an agent makes to get a token for the service it calls.

| File | Contract | Produced by | Read by |
|---|---|---|---|
| [`agent-contract.ts`](agent-contract.ts) | What an agent is sent at `POST /invocations` and what it returns: the reply, the label passages it cites, what it did to cases, and every step it took | Agents | The client and the evaluation harness |
| [`case-contract.ts`](case-contract.ts) | Cases, their versions, their audit trail (with whom an agent acted for, and a reviewer's subject), and a review decision (`{ decision, note? }`: the reviewer comes from the access token) | The case system | The client |
| [`access-token.ts`](access-token.ts) | The check of an access token presented as `Authorization: Bearer`: signature against the identity provider's keys (RS256 only), expiry, issuer, audience, allowed `client_id`, at least one required scope, and a minimum remaining life, in that order. Gives the caller (with the token's scopes), a named refusal, or "unavailable" when the provider cannot be asked. Also how every front door answers a refusal: 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."` for a missing scope, 401 for any other | The identity provider's tokens | The agents, the case system and the retrieval service |
| [`token-exchange.ts`](token-exchange.ts) | The token exchange (RFC 8693): the token an agent was given, sent as the agent, for a token for one audience and the scopes asked for. Gives the token and its expiry, a named refusal (a scope not granted, the provider's refusal, an answer that is not a bearer token), or "unavailable" (no answer in time, a network failure, a 5xx, a body that is not JSON). One request, never retried; no detail holds a token or the secret | The identity provider's token endpoint | The agents |

`agent-contract.ts` is schemas as well as types: whatever calls an agent checks the answer against them.

What an answer from drug labels carries:

| Field | What it is |
|---|---|
| `citations[]` | Each: `drug` (the label's names), `section`, `quote`, `set_id`, `version` (1 or more), `effective_date` (8 digits, YYYYMMDD, as the label carries it), `source` (the label's page, starting `https://`) and `passage` (the passage's id in the index). All required, so a reviewer can find and check the exact version quoted |
| `label_answer` | `answered`, `no_label`, `label_does_not_answer` or `not_a_label_question`. Set on every completed run by an agent that answers from drug labels; absent from every other agent and from a run that did not complete. Optional rather than nullable, so responses stored before it existed still parse |
| A `retrieval` step | `query`, `strategy` (how the retrieval service ranked the passages, as it reports it), and `hits[]`. Each hit: `drug`, `section`, `score`, `excerpt`, and `passage` (its id in the index), `handle` (the short name the model was shown, such as `P3`) and `shown` (false when the passage matched but was not given to the model) |

`access-token.ts` is configured with the values AgentCore Runtime's JWT authorizer takes (a discovery URL, an allowed audience, allowed client IDs read from `client_id`, allowed scopes), and is given its clock and settings rather than reading them. `token-exchange.ts` is given its settings, `fetch`, its clock and its time limit; on AWS, AgentCore Identity takes its place.

[`machine-token.ts`](machine-token.ts) is how a machine gets a token as its own client, by client credentials with its own secret: one request, never retried, the scopes left to the service to check. The evaluation harness and the knowledge gate use it, and their runs against the stack show it.

Four agents in [`agents/`](../agents/README.md) implement the agent contract: the intake agent, built once with a hand-written loop and once on Strands, the label expert and the orchestrator, both on Strands. The label expert produces citations, `label_answer` and retrieval steps. A `delegation` step is one call from an agent to another: `id`, `to_agent`, `requested_by`, `message` (`{ id, text }`), `replaces`, `failure` and `response`, the other agent's whole response or null. That response's steps are of the kinds an agent that calls no other produces (`model`, `tool`, `retrieval`, `error`), so a delegation never holds a delegation. The orchestrator produces them.

## Always true

1. The token check returns a caller only for a token signed by the provider's published key, from the right issuer, for this audience, issued to an allowed client, with the required life left; each failure names which.
2. A provider that cannot be reached, that names another issuer, or whose keys cannot be used is "unavailable", never a refusal, and it recovers.
3. Keys are fetched once, and again only for an unknown key, at most once per wait.
4. No refusal sentence contains the token.
5. A request or a response outside the agent contract's schema is refused, and one inside it is returned unchanged.
6. A token is accepted only if it carries at least one of the scopes the service requires. One that carries none is refused as `insufficient_scope`, and the answer every front door gives for that refusal is 403 naming the scopes; every other refusal stays 401.
7. The token exchange returns a token only when the provider granted every scope asked for. A provider's refusal, a grant that leaves a scope out, and a provider that does not answer are three different results, and none of their sentences holds a token or the client secret.

`shared/test/` has one test for each, named `shared` and its number. Tests 1 to 4 and 6 use real signed tokens from the stand-in issuer in [`test-support/`](../test-support/README.md).
