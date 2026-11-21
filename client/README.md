# Client

The front end of the lab: a medical information desk. Inquiries from clinicians arrive here, are handed to an agent, and come back with a reply, the passages of the drug label it relied on, and any adverse event case it opened. People review those cases here too.

It is a React app and a small Node server that the app talks to. All data in it is synthetic.

Every command on this page is run from the root of the repository.

## Run it

```bash
docker compose up -d --build --wait
```

Then open <http://127.0.0.1:3000>. That starts the client together with the [agents](../agents/README.md) and the [case system](../tools/case-system/README.md), on one network. All are published on this machine only. The agents need the model server, so [set that up](../model/README.md) first.

```bash
docker compose down
```

stops them and keeps the inquiries and cases. Add `-v` to delete them.

## The screens

| Screen | What it is for |
|---|---|
| Inquiries | Receive a message, from a prepared one or your own, and send it to an agent. Read the reply, the label passages it cites, and any case it opened. Send the same message again, to the same agent or another, and compare the runs. |
| What the agent did | Beside each run: every step in order, with how long it took and what was sent and returned. Model calls, tool calls, label searches and hand-offs between agents each have their own read-out. |
| Cases | The review queue. A case shows its four parts as a form, every earlier version, and its audit trail. Approve, reject or ask for information under your name. |
| System | Each part the desk depends on, and whether it answers right now. |

## What works today

- **Inquiries, Cases and System work,** with both builds of the [intake agent](../agents/README.md). An inquiry can be sent to either, and again to the other.
- **The read-outs for citations, label searches and hand-offs between agents have not been seen with real output,** because the intake agent produces none. Replies, case actions, model steps and tool steps have.
- **Label search and evaluation have no screen.** They are listed on System as not built.

## How it is put together

```
browser ── React app ──> client server ──> agents          POST /invocations
                              │──────────> case system     review server
                              └─ SQLite on a volume: inquiries and runs
```

- **The server is where a message is received.** It gives the message its identifier and receipt time once, before any agent sees it. Sending the message again reuses both, which is what lets the case system open one case per message.
- **A run does not block the page.** Sending answers at once with the run marked as working; the app asks again until it has finished or failed.
- **What an agent returns is checked against the contract** in [`shared/agent-contract.ts`](../shared/agent-contract.ts). An answer outside it is shown as a failed run with the reason.
- **The app never talks to an agent or the case system directly.** Only the server does, so the page holds no addresses or credentials.

| Folder | Holds |
|---|---|
| `src/` | The server: routes, the inquiry store, the calls to agents and to the case system |
| `shared/api.ts` | The types of the server's API, read by both the server and the app |
| `web/` | The React app, built by Vite to static files that the server hands out |
| `test/` | Tests of the server |

## Settings

Set in [`compose.yaml`](compose.yaml).

| Setting | Meaning |
|---|---|
| `AGENTS` | The agents an inquiry can be sent to: a JSON list of `{ id, name, description, url }` |
| `CASE_REVIEW_URL` | Where the case system's review server is |
| `CLIENT_DB_PATH` | The SQLite file for inquiries and runs |
| `WEB_ROOT` | The folder holding the built app |

## Known limits

- **Nobody is signed in.** The reviewer's name is whatever is typed in "Reviewing as".
- **A run that is in progress when the server stops is marked as failed** when it starts again. The agent may still have acted.
- **The React app has no automated tests.** It is typechecked, linted and built by the repository check, and was looked at by hand.
