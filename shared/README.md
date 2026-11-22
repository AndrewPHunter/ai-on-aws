# Shared

The contracts between pieces: the shapes one piece sends and another reads. A piece imports them from here, so both sides are checked against one definition. Also the one check more than one piece makes on what it is sent: the access token.

| File | Contract | Produced by | Read by |
|---|---|---|---|
| [`agent-contract.ts`](agent-contract.ts) | What an agent is sent at `POST /invocations` and what it returns: the reply, the label passages it cites, what it did to cases, and every step it took | Agents | The client and the evaluation harness |
| [`case-contract.ts`](case-contract.ts) | Cases, their versions, their audit trail (with whom an agent acted for, and a reviewer's subject), and a review decision (`{ decision, note? }`: the reviewer comes from the access token) | The case system | The client |
| [`access-token.ts`](access-token.ts) | The check of an access token presented as `Authorization: Bearer`: signature against the identity provider's keys (RS256 only), issuer, audience, allowed `client_id`, expiry and a minimum remaining life. Gives the caller, a named refusal, or "unavailable" when the provider cannot be asked | The identity provider's tokens | The agents, the case system and the retrieval service |

`agent-contract.ts` is schemas as well as types: whatever calls an agent checks the answer against them.

What an answer from drug labels carries:

| Field | What it is |
|---|---|
| `citations[]` | Each: `drug` (the label's names), `section`, `quote`, `set_id`, `version` (1 or more), `effective_date` (8 digits, YYYYMMDD, as the label carries it), `source` (the label's page, starting `https://`) and `passage` (the passage's id in the index). All required, so a reviewer can find and check the exact version quoted |
| `label_answer` | `answered`, `no_label`, `label_does_not_answer` or `not_a_label_question`. Set on every completed run by an agent that answers from drug labels; absent from every other agent and from a run that did not complete. Optional rather than nullable, so responses stored before it existed still parse |
| A `retrieval` step | `query`, `strategy` (how the retrieval service ranked the passages, as it reports it), and `hits[]`. Each hit: `drug`, `section`, `score`, `excerpt`, and `passage` (its id in the index), `handle` (the short name the model was shown, such as `P3`) and `shown` (false when the passage matched but was not given to the model) |

`access-token.ts` is configured with the values AgentCore Runtime's JWT authorizer takes (a discovery URL, an allowed audience, allowed client IDs read from `client_id`), and is given its clock and settings rather than reading them.

Three agents in [`agents/`](../agents/README.md) implement the agent contract: the intake agent, built once with a hand-written loop and once on Strands, and the label expert, on Strands. The label expert produces citations, `label_answer` and retrieval steps. Hand-off steps are defined here and no agent produces them.

## Always true

1. The token check returns a caller only for a token signed by the provider's published key, from the right issuer, for this audience, issued to an allowed client, with the required life left; each failure names which.
2. A provider that cannot be reached is "unavailable", never a refusal, and it recovers.
3. Keys are fetched once, and again only for an unknown key, at most once per wait.
4. No refusal sentence contains the token.
5. A request or a response outside the agent contract's schema is refused, and one inside it is returned unchanged.

`shared/test/` has one test for each, named `shared` and its number. The first four use real signed tokens from the stand-in issuer in [`test-support/`](../test-support/README.md).
