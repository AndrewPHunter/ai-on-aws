# Case system

A small system of record for adverse event cases. Agents open cases and add to them through MCP; people review them through a separate HTTP interface. It is the thing an agent changes, so it is where "exactly once" and "a person approves" are enforced.

All data in it is synthetic. It is a lab stand-in, not a pharmacovigilance system.

Every request but `GET /ping`, on both servers, needs an access token from the lab's [identity provider](../../platform/identity/README.md) as `Authorization: Bearer`, for the audience `case-system`. Each server accepts tokens issued to its own callers only. On the agent server it is a token issued to an intake agent's client (`intake-handwritten` or `intake-strands`), which the agent gets by exchanging the signed-in user's token; the agent is that client, acting for that user. On the review server it is the reviewer's own, issued to the `desk` client and sent by the client; the reviewer is whoever the token names. Each tool and each route needs its own scope:

| Tool or route | Scope |
|---|---|
| `create_case`, `add_follow_up` | `cases:write` |
| `find_case` | `cases:lookup` |
| `GET /cases`, `GET /cases/<id>` | `cases:read` |
| `POST /cases/<id>/review` | `cases:review` |

Every command on this page is run from the root of the repository.

## Run it

```bash
docker compose -f tools/case-system/compose.yaml up -d --build --wait
```

That starts the case system on its own; without the identity provider on the same network it answers `/ping`, answers 401 to a request with no token, a malformed one or one not signed with RS256, and answers every other request with 503. `docker compose up -d --build --wait` at the root starts it together with the [client](../../client/README.md), which is how the review screens reach it.

| Port | For | What it serves |
|---|---|---|
| 8000 | Agents | MCP over HTTP at `POST /mcp`, and `GET /ping` |
| 8001 | Reviewers | `GET /cases`, `GET /cases/<id>`, `POST /cases/<id>/review`, and `GET /ping` |

Both are published on this machine only. Cases are kept in a SQLite file on a Docker volume, so they survive the container being removed. The volume is `ai-on-aws-case-system_cases` when the case system is started on its own, and `ai-on-aws_cases` when it is started from the root with the client; the two do not share cases. To keep the file in a directory of your own instead, change the `cases:/data` line in `compose.yaml` to that directory's path.

```bash
docker compose -f tools/case-system/compose.yaml down
```

stops it and keeps the cases. Add `-v` to delete them.

## What an agent can do

Three tools, and no others. The MCP server offers each only to a token holding its scope; a call to one not offered is answered with the MCP library's unknown-tool error and changes nothing.

| Tool | What it does | What it answers with |
|---|---|---|
| `create_case` | Opens a case from the message being handled, with whichever of the four elements the message gives | `{ outcome, case: <receipt> }`, `outcome` being `created` or `replayed` |
| `add_follow_up` | Adds information to an existing case as a new version | `{ outcome, case: <receipt> }`, `outcome` being `recorded` or `replayed` |
| `find_case` | Looks cases up: by identifier, by part of the drug or patient, or "from the message being handled". Newest first, at most 50, and it says when more matched than it lists | `{ cases, truncated }`, each case whole |

A receipt is `{ case_id, status, version, missing }`: which case, where it stands, and the elements it still lacks. A tool that changes a case never answers with what the case holds. A refused conflict (`case_already_opened_for_this_message`, `follow_up_already_recorded_for_this_message`) names the case as it stands by the same receipt.

`find_case` is offered only to a token holding `cases:lookup`, and in the lab's realm no client may ask for that scope, so no agent has a lookup. Whole cases are read by people, on the review server.

The four elements are an identifiable patient, an identifiable reporter, a suspect drug and an adverse event.

## Always true

1. Whether a case is complete is decided by code: all four elements present, or it lists what is missing.
2. One case per inbound message: the same content returns the same case; different content is refused and changes nothing.
3. A follow-up adds a version and never overwrites; one from the same message is recorded once.
4. A follow-up sends the case back to review, whatever its status was, unless the case still lacks an element: then it stays incomplete.
5. Only a person decides a case, through the review server, from the statuses allowed; the reviewer is the token's holder.
6. An agent sees and adds to only the sender's own cases; another sender's case is answered exactly as one that does not exist.
7. Every change is in the audit trail with who, when and which message, including replays and refused conflicts. The person and the agent are the ones the token names: the agent is the client the token was issued to, never a name the request carries.
8. No call but `GET /ping` is accepted without knowing who is calling, and the token is judged before anything else is read.
9. A tool or a route is reached only with a token that carries its scope: `create_case` and `add_follow_up` need `cases:write`, `find_case` needs `cases:lookup`, reading cases needs `cases:read`, deciding one needs `cases:review`. A tool whose scope the token lacks is not offered, and calling it changes nothing.
10. A tool that changes a case answers with a receipt: the case's id, status, version and what it still lacks. It never answers with what the case holds.

The tests in `test/` are named `case-system` and the item's number, one for each item, with three probes, P1 to P3, that drive both servers over loopback. P1 and P2 show the token's part of items 7 and 5: the agent recorded is the token's client whatever header a request carries, and the reviewer is the token's holder.

## The rules it enforces

- **Complete or not is decided here, by code.** A case with all four elements is `awaiting_review`. A case missing any is `incomplete` and lists what is missing. The check is that each element is present; whether it is good enough is the reviewer's judgement.
- **One case per inbound message.** A second `create_case` for the same message with the same content answers with the receipt of the case already opened. With different content it is refused, names the existing case, and changes nothing.
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

The model does not choose which message or agent a change is recorded against. The agent is the client the access token was issued to. The agent's own code sends the message with each MCP request:

| Header | Meaning |
|---|---|
| `x-message-id` | The agent's identifier for the inbound message it is handling |
| `x-received-at` | When that message was received, as a date and time |
| `x-sender` | Who sent the message, as the caller gave it, percent-encoded |

Without them every tool call is refused and nothing is recorded or returned. Listing the tools works without them. Sending only some of them, a receipt time that is not a time, or a receipt time more than five minutes ahead of the server's clock, is refused with status 400.

An `x-agent-id` header is not read. The access token comes first, before the headers or the body are read. Every audit entry for an agent's change records the token's client as the actor and, beside it, the user the agent acted for: the token's `name` and subject.

| Answer | When |
|---|---|
| 401, `WWW-Authenticate: Bearer error="invalid_token"`, `{"error":"unauthorized","reason","detail"}` | No token, or one that is malformed, signed by another key or not with RS256, from another issuer, not for `case-system`, not issued to a client this server accepts, or expired. `reason` names which |
| 403, `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."`, `{"error":"forbidden","reason":"insufficient_scope","detail"}` | A token holding none of the server's scopes, or, on the review server, not the route's own scope, which the header names |
| 503 `identity_unavailable` | The identity provider's discovery document or keys cannot be fetched, or it names another issuer |
| 404 `case_not_found` | The review server, for a case id that names no case |
| 400 | The review server: a `status` filter that is not a status; a decision of `request_information` without a note (`note_required`); a body that names a `reviewer` |
| 409 `not_allowed` | The review server: a decision on a case whose status does not allow it |
| 404 | The agent server, for any path but `/mcp` and `/ping` |

## Settings

Set in [`compose.yaml`](compose.yaml). Every one is required; the case system stops at start-up naming any that is missing.

| Setting | Meaning |
|---|---|
| `CASE_DB_PATH` | The SQLite file |
| `AUTH_DISCOVERY_URL` | Where the identity provider's discovery document is: `http://identity:8080/realms/lab/.well-known/openid-configuration` |
| `AUTH_ISSUER` | The issuer it and every token must name, exactly: `http://localhost:8090/realms/lab` |
| `AUTH_ALLOWED_AUDIENCE` | A value the token's `aud` must contain: `case-system` |
| `AUTH_AGENT_SERVER_CLIENTS` | The `client_id` values the agent server accepts, separated by commas: `intake-handwritten,intake-strands` |
| `AUTH_REVIEW_SERVER_CLIENTS` | The `client_id` values the review server accepts, separated by commas: `desk` |
| `AUTH_ROLES_CLAIM` | The claim holding the caller's roles: `roles` |

The scopes are set in code, not by a setting: each server's token check requires at least one of its own tools' or routes' scopes. A token needs only to be valid when it arrives (no minimum remaining life).

## Review a case

With an access token of a signed-in user, issued to `desk` with `cases:read` (to list) or `cases:review` (to decide), in `$ACCESS_TOKEN`:

```bash
curl -s 'http://127.0.0.1:8001/cases?status=awaiting_review' -H "authorization: Bearer $ACCESS_TOKEN"
```

```bash
curl -s -X POST http://127.0.0.1:8001/cases/AE-000001/review -H "authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' -d '{"decision":"approve"}'
```

`decision` is `approve`, `reject` or `request_information`; the last needs a `note`. The reviewer recorded is the token's `name`, with its subject. A body that names a `reviewer` is refused with 400. A token without `cases:review` is refused with 403 `insufficient_scope`, decided before the case is looked up, so the answer says nothing about whether it exists. `GET /cases/<id>` returns the case with every version and its audit trail; an agent's entries carry `acting_for`, a reviewer's carry `actor_subject`.

## Known limits

- **The context headers travel straight from the agent to this server.** Nothing here passes them through AgentCore Runtime or Gateway.
- **A conflict is reported to the model, and what the model does next is not controlled here.** After a refused create it could send the reworded content as a follow-up, which adds a version and sends the case back to review.
- **The context headers are trusted as sent.** The agent is the token's client, but the message and its sender are headers the agent's code claims: an intake agent's token can record a change against any message, from any sender. The limit to a sender's own cases is only as good as that sender text, which the signed-in user vouches for.
- **One event reported by two senders becomes two cases.** The second sender cannot find the first sender's case, and nothing links them.
- **A token with `cases:read` can list and read every case** on the review server, from every sender.
- **One case per message.** A message that reports two patients produces one case.
- **SQLite support in Node 22 is marked experimental** and prints a warning at start. It was chosen because it adds no dependency that needs compiling.
- **The storage does not carry to AgentCore Runtime as it is.** Runtime sessions do not keep a local disk; the interface (stateless MCP over HTTP at `/mcp` on port 8000) is what matches.
