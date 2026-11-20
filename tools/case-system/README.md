# Case system

A small system of record for adverse event cases. Agents open cases and add to them through MCP; people review them through a separate HTTP interface. It is the thing an agent changes, so it is where "exactly once" and "a person approves" are enforced.

All data in it is synthetic. It is a lab stand-in, not a pharmacovigilance system.

Every command on this page is run from the root of the repository.

## Run it

```bash
docker compose -f tools/case-system/compose.yaml up -d --build --wait
```

| Port | For | What it serves |
|---|---|---|
| 8000 | Agents | MCP over HTTP at `POST /mcp`, and `GET /ping` |
| 8001 | Reviewers | `GET /cases`, `GET /cases/<id>`, `POST /cases/<id>/review` |

Both are published on this machine only. Cases are kept in a SQLite file on the Docker volume `ai-on-aws-case-system_cases`, so they survive the container being removed. To keep the file in a directory of your own instead, change the `cases:/data` line in `compose.yaml` to that directory's path.

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

## The rules it enforces

- **Complete or not is decided here, by code.** A case with all four elements is `awaiting_review`. A case missing any is `incomplete` and lists what is missing. The check is that each element is present; whether it is good enough is the reviewer's judgement.
- **One case per inbound message.** A second `create_case` for the same message with the same content returns the case already opened. With different content it is refused, names the existing case, and changes nothing.
- **Follow-ups add, they never overwrite.** Each one is a new version; earlier versions stay readable. A follow-up from the same message is recorded once.
- **A follow-up sends the case back to review**, or leaves it incomplete, whatever its status was, including approved.
- **Only a person changes a case to approved, rejected or needs information.** Those are not MCP tools. They are a request to the review server, which requires the reviewer's name.
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

Without them, `create_case` and `add_follow_up` are refused and record nothing. Listing tools and plain lookups work without them. Sending only some of them, a receipt time that is not a time, or a receipt time more than five minutes ahead of the server's clock, is refused with status 400.

## Review a case

```bash
curl -s http://127.0.0.1:8001/cases?status=awaiting_review
```

```bash
curl -s -X POST http://127.0.0.1:8001/cases/AE-000001/review -H 'content-type: application/json' -d '{"reviewer":"<your name>","decision":"approve"}'
```

`decision` is `approve`, `reject` or `request_information`; the last needs a `note`. `GET /cases/<id>` returns the case with every version and its audit trail.

## What was measured

- The repository check runs 25 tests for this piece, 14 on the store and 11 that drive the real servers over loopback with the MCP SDK's own client. Run on an arm64 Mac only.
- By hand against the running container, on an arm64 Mac: a case created, the same call repeated, the container removed and started again on the same volume, and the same call repeated a third time. One case existed throughout, and the audit trail showed one creation and two replays.

## Known limits

- **The context headers are not established to reach the server through AgentCore.** The Runtime documentation read for this says session headers are forwarded and shows an allowlist setting for others; whether these three pass through Runtime or Gateway has not been tried. Whether the Strands MCP client can send them has not been tried either.
- **A conflict is reported to the model, and what the model does next is not controlled here.** After a refused create it could send the reworded content as a follow-up, which adds a version and sends the case back to review.
- **The context headers are trusted as sent.** Nothing authenticates the caller, so anything that can reach port 8000 can claim to be any agent.
- **The review server is not authenticated either.** The reviewer's name is whatever the request says. A model has no tool that reaches it, but a process that can reach port 8001 could.
- **One case per message.** A message that reports two patients produces one case.
- **SQLite support in Node 22 is marked experimental** and prints a warning at start. It was chosen because it adds no dependency that needs compiling.
- **The storage does not carry to AgentCore Runtime as it is.** Runtime sessions do not keep a local disk; the interface (stateless MCP over HTTP at `/mcp` on port 8000) is what matches.
