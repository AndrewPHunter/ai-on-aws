# Case system

A small system of record for adverse event cases. Agents open cases and add to them through MCP; people review them through a separate HTTP interface. It is the thing an agent changes, so it is where "exactly once" and "a person approves" are enforced.

All data in it is synthetic. It is a lab stand-in, not a pharmacovigilance system.

Every request but `GET /ping`, on both servers, needs an access token from the lab's [identity provider](../../platform/identity/README.md) as `Authorization: Bearer`, issued to the `desk` client for `lab-case-system`. On the agent server it is the token of the signed-in user the agent acts for, passed on by the agent; on the review server it is the reviewer's own, sent by the client. The reviewer is whoever the token names, and deciding a case needs the `reviewer` role.

Every command on this page is run from the root of the repository.

## Run it

```bash
docker compose -f tools/case-system/compose.yaml up -d --build --wait
```

That starts the case system on its own; without the identity provider on the same network it answers every request but `/ping` with 503. `docker compose up -d --build --wait` at the root starts it together with the [client](../../client/README.md), which is how the review screens reach it.

| Port | For | What it serves |
|---|---|---|
| 8000 | Agents | MCP over HTTP at `POST /mcp`, and `GET /ping` |
| 8001 | Reviewers | `GET /cases`, `GET /cases/<id>`, `POST /cases/<id>/review` |

Both are published on this machine only. Cases are kept in a SQLite file on a Docker volume, so they survive the container being removed. The volume is `ai-on-aws-case-system_cases` when the case system is started on its own, and `ai-on-aws_cases` when it is started from the root with the client; the two do not share cases. To keep the file in a directory of your own instead, change the `cases:/data` line in `compose.yaml` to that directory's path.

```bash
docker compose -f tools/case-system/compose.yaml down
```

stops it and keeps the cases. Add `-v` to delete them.

## What an agent can do

Three tools, and no others:

| Tool | What it does |
|---|---|
| `create_case` | Opens a case from the message being handled, with whichever of the four elements the message gives |
| `find_case` | Looks cases up: by identifier, by part of the drug or patient, or "from the message being handled". Newest first, at most 50, and it says when more matched than it lists |
| `add_follow_up` | Adds information to an existing case as a new version |

The four elements are an identifiable patient, an identifiable reporter, a suspect drug and an adverse event.

## Always true

1. Whether a case is complete is decided by code: all four elements present, or it lists what is missing.
2. One case per inbound message: the same content returns the same case; different content is refused and changes nothing.
3. A follow-up adds a version and never overwrites; one from the same message is recorded once.
4. A follow-up sends the case back to review, whatever its status was.
5. Only a person decides a case, through the review server, from the statuses allowed; the reviewer is the token's holder.
6. An agent sees and adds to only the sender's own cases; another sender's case is answered exactly as one that does not exist.
7. Every change is in the audit trail with who, when and which message, including replays and refused conflicts. The person and the agent are the ones the token names: the agent is the client the token was issued to, never a name the request carries.
8. No call is accepted without knowing who is calling, and the token is judged before anything else is read.
9. A tool or a route is reached only with a token that carries its scope: `create_case` and `add_follow_up` need `cases:write`, `find_case` needs `cases:lookup`, reading cases needs `cases:read`, deciding one needs `cases:review`. A tool whose scope the token lacks is not offered, and calling it changes nothing.

## The rules it enforces

- **Complete or not is decided here, by code.** A case with all four elements is `awaiting_review`. A case missing any is `incomplete` and lists what is missing. The check is that each element is present; whether it is good enough is the reviewer's judgement.
- **One case per inbound message.** A second `create_case` for the same message with the same content returns the case already opened. With different content it is refused, names the existing case, and changes nothing.
- **Follow-ups add, they never overwrite.** Each one is a new version; earlier versions stay readable. A follow-up from the same message is recorded once.
- **A follow-up sends the case back to review**, or leaves it incomplete, whatever its status was, including approved.
- **Only a person changes a case to approved, rejected or needs information.** Those are not MCP tools. They are a request to the review server, which takes the reviewer's name from the access token and refuses a body that names one.
- **An agent sees and adds to only the sender's own cases.** `find_case` returns only cases that the sender of the message being handled has reported on, and `add_follow_up` is accepted only on such a case. A case from another sender is answered exactly as a case that does not exist. Two spellings of a sender that differ only in case and spacing are the same sender. Reviewers see every case.
- **Every change is in an audit trail** with who made it, when, and which message it came from. Replays and refused conflicts are recorded too.

Statuses and who sets them:

| Status | Set by |
|---|---|
| `incomplete`, `awaiting_review` | The system, after an agent's create or follow-up |
| `approved`, `rejected` | A reviewer, from `awaiting_review` only |
| `needs_information` | A reviewer, from `awaiting_review` or `incomplete`, with a note |

## Who is calling: the context headers

The model does not choose which message or agent a change is recorded against. The agent's own code sends that with each MCP request:

| Header | Meaning |
|---|---|
| `x-message-id` | The agent's identifier for the inbound message it is handling |
| `x-received-at` | When that message was received, as a date and time |
| `x-agent-id` | Which agent is calling |
| `x-sender` | Who sent the message, as the caller gave it, percent-encoded |

Without them every tool call is refused and nothing is recorded or returned. Listing the tools works without them. Sending only some of them, a receipt time that is not a time, or a receipt time more than five minutes ahead of the server's clock, is refused with status 400.

The access token comes first, before the headers or the body are read. Every audit entry for an agent's change records the agent as the actor and, beside it, the user the agent acted for: the token's `name` and subject.

| Answer | When |
|---|---|
| 401, `WWW-Authenticate: Bearer error="invalid_token"`, `{"error":"unauthorized","reason","detail"}` | No token, or one that is malformed, signed by another key or not with RS256, from another issuer, not for `lab-case-system`, not issued to `desk`, or expired. `reason` names which |
| 503 `identity_unavailable` | The identity provider's discovery document or keys cannot be fetched, or it names another issuer |

## Settings

Set in [`compose.yaml`](compose.yaml). Every one is required; the case system stops at start-up naming any that is missing.

| Setting | Meaning |
|---|---|
| `CASE_DB_PATH` | The SQLite file |
| `AUTH_DISCOVERY_URL` | Where the identity provider's discovery document is: `http://identity:8080/realms/lab/.well-known/openid-configuration` |
| `AUTH_ISSUER` | The issuer it and every token must name, exactly: `http://localhost:8090/realms/lab` |
| `AUTH_ALLOWED_AUDIENCE` | A value the token's `aud` must contain: `lab-case-system` |
| `AUTH_ALLOWED_CLIENTS` | The `client_id` values accepted, separated by commas: `desk` |
| `AUTH_ROLES_CLAIM` | The claim holding the caller's roles: `roles` |
| `AUTH_REVIEWER_ROLE` | The role a token must list to decide a case: `reviewer` |

A token needs only to be valid when it arrives (no minimum remaining life).

## Review a case

With an access token of a signed-in user in `$ACCESS_TOKEN`:

```bash
curl -s http://127.0.0.1:8001/cases?status=awaiting_review -H "authorization: Bearer $ACCESS_TOKEN"
```

```bash
curl -s -X POST http://127.0.0.1:8001/cases/AE-000001/review -H "authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' -d '{"decision":"approve"}'
```

`decision` is `approve`, `reject` or `request_information`; the last needs a `note`. The reviewer recorded is the token's `name`, with its subject. A body that names a `reviewer` is refused with 400. A token without the `reviewer` role is refused with 403 `not_a_reviewer`, decided before the case is looked up, so the answer says nothing about whether it exists. `GET /cases/<id>` returns the case with every version and its audit trail; an agent's entries carry `acting_for`, a reviewer's carry `actor_subject`.

## What was measured

- The repository check runs 11 tests for this piece, named `case-system` and a number: one for each invariant under "Always true", numbered as they are, and three probes of the wiring, P1 to P3. Invariants 1 to 7 are shown on the store over an in-memory database (for invariant 5, the statuses a decision is allowed from). Invariant 8 and the probes drive the real servers over loopback, P1 and P3 with the MCP SDK's own client: P1, the three tools offered and a create recorded against the context headers and the token's user; P2, a decision through the review route recorded under the token's user, and refused for a body naming a reviewer or a caller without the role; P3, another sender's case answered over MCP as one that does not exist. Their token check is a function that names a caller, refuses or is unavailable; verifying a token is tested in [`shared/`](../../shared/README.md).
- By hand against the running container, on an arm64 Mac: a case created, the same call repeated, the container removed and started again on the same volume, and the same call repeated a third time. One case existed throughout, and the audit trail showed one creation and two replays.

## Known limits

- **The context headers are not established to reach the server through AgentCore.** The Runtime documentation read for this says session headers are forwarded and shows an allowlist setting for others; whether these three pass through Runtime or Gateway has not been tried. Whether the Strands MCP client can send them has not been tried either.
- **A conflict is reported to the model, and what the model does next is not controlled here.** After a refused create it could send the reworded content as a follow-up, which adds a version and sends the case back to review.
- **The context headers are trusted as sent.** A call needs a signed-in user's access token, but the agent's own name (`x-agent-id`) is a header it claims: anything holding a valid token can claim to be any agent, handling a message from any sender. The limit to a sender's own cases is only as good as that sender text, which the signed-in user vouches for.
- **The token is the user's, passed on unchanged by the agent.** It is not exchanged for a narrower one, so it is valid here for anything that user may do here.
- **One event reported by two senders becomes two cases.** The second sender cannot find the first sender's case, and nothing links them.
- **A store written before senders were kept** opens, but its existing cases have no sender, so no agent lookup finds them. Reviewers still see them.
- **Any holder of a valid token can list and read every case** on the review server; only deciding needs the `reviewer` role.
- **A store written before tokens were checked** opens; its existing audit entries have no `acting_for` and no `actor_subject`.
- **One case per message.** A message that reports two patients produces one case.
- **SQLite support in Node 22 is marked experimental** and prints a warning at start. It was chosen because it adds no dependency that needs compiling.
- **The storage does not carry to AgentCore Runtime as it is.** Runtime sessions do not keep a local disk; the interface (stateless MCP over HTTP at `/mcp` on port 8000) is what matches.
