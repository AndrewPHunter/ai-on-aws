# Client

The front end of the lab: a medical information desk. Inquiries from clinicians arrive here, are handed to an agent, and come back with a reply, the passages of the drug label it relied on, and any adverse event case it opened. People review those cases here too.

It is a React app and a small Node server that the app talks to. Desk staff sign in through the lab's [identity provider](../platform/identity/README.md). All data in it is synthetic.

Every command on this page is run from the root of the repository.

## Run it

```bash
platform/identity/setup.sh
docker compose up -d --build --wait
```

Then open <http://localhost:3000>, by that name and not `127.0.0.1`: the identity provider sends the browser back to `localhost`, and the session cookie belongs to it. Sign in as one of the four people: `dana.desk` (who runs the intake agents and the orchestrator), `morgan.medinfo` (who also runs the label expert), `riley.reviewer` (who reads and decides cases) or `avery.auditor` (who reads cases and every run's trace); their passwords are `IDENTITY_DANA_PASSWORD`, `IDENTITY_MORGAN_PASSWORD`, `IDENTITY_RILEY_PASSWORD` and `IDENTITY_AVERY_PASSWORD` in `platform/identity/.env`, which the first command writes. What each person sees is set by the scopes their role is granted; see [what each person sees](#what-each-person-sees).

That starts the client together with the [agents](../agents/README.md), the [case system](../tools/case-system/README.md) and the [identity provider](../platform/identity/README.md), on one network. All are published on this machine only. The agents need the model server, so [set that up](../model/README.md) first.

```bash
docker compose down
```

stops them and keeps the inquiries and cases. Add `-v` to delete them.

## The screens

| Screen | What it is for |
|---|---|
| Sign in | The only screen without a session: one action, which goes to the identity provider. |
| Inquiries | Receive a message, from a prepared one or your own, and send it to an agent you may run. Only the inquiries you entered are listed. Read the reply, the label passages it cites, and any case it opened. Citations are numbered from 1, so a `[2]` in the reply can be found; each gives the drug, the section, the label's version and date, the quote, and a link to that version's page. When the agent answers from labels, one line says whether the label answered the question, and if not why. Send the same message again, to the same agent or another, and compare the runs by result, cases and time. Each inquiry shows who entered it, and each run who started it. A run's steps are not shown here. |
| Traces | For someone who may read traces: every run by anyone, newest first, with when, who, the agent, the result, the outcome and the time taken. Opening one shows the message as it was received, the run's result as the Inquiries screen shows it (the outcome when it was not completed, any case actions, whether the label answered, the reply and the label passages it cites), and, beside them, what the agent did: every step in order, with how long it took and what was sent and returned. Model calls, tool calls, label searches, an intake agent's report check (made by its code, with its finding in words) and calls to another agent each have their own read-out; each label-search hit shows the name the model was shown it by, and says when it matched but was not shown; a call to another agent shows what was sent, why there is no answer if there is none, and the other agent's outcome, reply and steps, listed inside it. |
| Cases | The review queue. A case shows its four parts as a form, every earlier version, and its audit trail; an agent's entry says whom the agent acted for ("Agent intake-strands, for Dana Desk"). Someone who may decide cases approves, rejects or asks for information, recorded under the name they signed in with; anyone else who may read cases sees that their account cannot decide them. |
| System | Each part the desk depends on, and whether it answers right now. |

## What each person sees

`GET /api/session` gives the person signed in and what they may do: `{ user: { name, username, roles }, may: { agents, read_cases, decide_cases, read_traces } }`. `may` comes only from the scopes the identity provider granted at sign-in; the role names are shown, never compared.

| Granted | The session may | The app shows |
|---|---|---|
| An agent's `scope` (`agents:intake`, `agents:expert`, `agents:orchestrator`) | Send an inquiry, or a new run of one of their own, to that agent | Inquiries, with that agent among those listed |
| `cases:read` | Read the case list and a case | Cases |
| `cases:review` | Decide a case | The decision controls on a case |
| `traces:read` | Read every person's runs with their steps, on the trace routes | Traces |
| None of these | Nothing that reaches an agent, the case system or a trace; `/api/session`, `/api/status`, `/api/samples`, an empty `/api/agents` and an empty list of their own inquiries still answer | A sentence saying the account has nothing to do here |

`/api/agents` lists only the agents the session may run. A call for anything else is answered 403 `not_allowed` before the identity provider or the target is asked. An inquiry, its runs and a new run on it are answered only to the person who entered it; to anyone else, exactly as an inquiry that does not exist (404 `inquiry_not_found`).

A run's steps are given only on the trace routes. Every other route gives a run with the agent's response less its `steps`.

| Route | Answers |
|---|---|
| `GET /api/inquiries`, `POST /api/inquiries` | The reader's own inquiries, newest first, at most 100, with `truncated`; a new inquiry, 202. Runs without steps |
| `GET /api/inquiries/<id>`, `POST /api/inquiries/<id>/runs` | 200 with the inquiry, 202 with the new run, both without steps; 404 `inquiry_not_found` to anyone but the person who entered it |
| `GET /api/traces` | 200 `{ traces, truncated }`: every person's runs, newest first, at most 100, each with when it started, who started it, the agent, its state, its outcome and the time it took. 403 `not_allowed` without `traces:read` |
| `GET /api/traces/<run_id>` | 200 `{ trace: { inquiry, run } }`: the message as it was received, and the run with the agent's whole response, steps included. A run still running is 200 with `state` `running` and no response yet. A stored response that no longer matches the agent contract is 200 with the run shown as `failed`, the store's reason as its `error`, and no response. 403 `not_allowed` without `traces:read`, decided before the store is read; 404 `unknown_run` for a run that does not exist |

In this phase the steps still arrive in the agent's response and are stored by the client with the rest of it, so `traces:read` is a permission on reading them, not yet a store of traces of their own.

## What works today

- **Inquiries, Cases and System work,** with each of the four [agents](../agents/README.md). An inquiry can be sent to any agent the signed-in person may run, and again to another.
- **The Traces list, a run's trace and the read-out for a call to another agent have been looked at in a browser with real output,** as the auditor, on 2026-11-23, at desktop and phone width. So have replies, case actions, and the model and tool step read-outs.
- **The read-outs for citations, whether the label answered, label searches and report checks have not been looked at in a browser with real output.** Nor have the Inquiries screen as it is now laid out without a run's steps, or a run's result on a run's trace. `toolchain/check.sh` shows that they typecheck, lint and build.
- **Label search and evaluation have no screen.**

## Always true

1. A message gets its identifier and receipt time once; sending it again reuses both.
2. Sending answers at once, and a run always ends as finished or failed, including after a restart.
3. An agent's answer outside the contract is a failed run with the reason.
4. Only a sign-in the provider vouched for creates a session, and only in the browser that started it.
5. Every call to an agent or the case system carries a token got for that target alone, with enough life left. It is got by a refresh first; refreshes of one session never overlap, and each uses the newest refresh token; a failed one ends the session.
6. The reviewer of a case is whoever is signed in, never a name the browser sends.
7. No token reaches the browser.
8. Signing out removes the session and revokes the refresh token; a failed revocation does not stop it.
9. A POST from another site is refused.
10. What a session may do comes from the scopes it was granted at sign-in: which agents it may run, whether it may read cases, whether it may decide one, whether it may read traces. A call for anything else is answered 403 before the identity provider or the target is asked.
11. An inquiry and its runs are read, and a run is started on it, only by the person who entered it. To anyone else it is answered as an unknown inquiry is. The one exception is the trace routes of invariant 12.
12. A run's steps leave the server only on the trace routes, and only to a session granted `traces:read`. Any other session is answered 403 there before the store is read, so the answer says nothing about whether a run exists. Every other route returns a run without its steps, to anyone. The trace routes cover every person's runs; an id that names no run is 404.

The server's tests in `test/` are one per item, named by its number. They run through the server with scripted agents, a scripted case system and an identity provider whose refresh is a function, except invariant 4 and those beside it in `auth.test.ts`, which use the stand-in provider, and invariant 5's two calls arriving together, which runs on the token function in `src/tokens.ts`.

## How it is put together

```
browser ── React app ──> client server ──> agents          POST /invocations      bearer token
   │      session cookie      │──────────> case system     review server          bearer token
   │                          │──────────> identity        discovery, token, keys
   └──── sign-in pages ──────────────────> identity        http://localhost:8090
                              └─ SQLite on a volume: inquiries and runs
```

- **The server is where a message is received.** It gives the message its identifier and receipt time once, before any agent sees it. Sending the message again reuses both, which is what lets the case system open one case per message.
- **A run does not block the page.** Sending answers at once with the run marked as working; the app asks again until it has finished or failed.
- **What an agent returns is checked against the contract** in [`shared/agent-contract.ts`](../shared/agent-contract.ts). An answer outside it is shown as a failed run with the reason.
- **The app never talks to an agent or the case system directly.** Only the server does, so the page holds no addresses or credentials.
- **Signing in is the server's job.** It runs the Authorization Code flow with PKCE against the identity provider, validates the ID token (signature against the provider's published keys, issuer, audience, nonce, expiry), and keeps the user and their tokens in memory under a random session identifier. The browser holds only that identifier, in an `HttpOnly`, `SameSite=Lax` cookie. Sessions end when the server restarts.
- **Sign-in asks for the scopes the targets need:** `openid`, each distinct agent `scope` configured, `cases:read` and `cases:review`, and `traces:read`, which no target is sent: the server checks it on the session. The provider leaves out any the person's role does not grant and still signs them in; the scopes it granted, read from the token response's `scope`, are kept on the session. The access token from sign-in is sent to nobody.
- **Every call to an agent or the case system carries a token got for that target alone,** as `Authorization: Bearer`. A target is a scope: the agent's `scope`, `cases:read` for reading cases, `cases:review` for a decision. The session keeps one token per scope. Before calling an agent the kept token must have as long left as the server waits for that agent (its `wait_seconds`); before calling the case system, 30 seconds. With less, or none, the server refreshes with `scope=openid <that scope>` and keeps the result under that scope.
- **Refreshes of one session run one at a time, in the order asked.** Each uses the newest refresh token the provider returned, and looks again for a kept token when its turn comes, so two calls for the same target share one refresh. If a refresh fails, the session ends, the request answers 401, nothing is sent, and the user signs in again. If it succeeds with a token that lacks the scope asked for, the request answers 403 `not_allowed` and the session goes on. Health checks carry no token. The agents and the case system each check the token and refuse a call without a valid one.
- **The reviewer of a case is whoever is signed in.** The server forwards a decision as `{ decision, note? }` with the token got for `cases:review` and no reviewer field; the case system takes the reviewer's name and subject from the token. A decision that names its own reviewer is refused here with 400, and one from a session not granted `cases:review` with 403. The case system refuses both behind it too, and its answers are passed back unchanged.
- **No token reaches the browser.** No response body, and no header but `Set-Cookie`, carries an access, refresh or ID token.
- **Signing out** removes the session, clears the cookie, revokes the refresh token at the revocation endpoint set by `OIDC_REVOCATION_ENDPOINT` (unless that is `none`), and sends the browser to the provider's end-session URL with `client_id` and the post-logout redirect URI, and no token. If the revocation fails, sign-out still ends the session here and the failure is logged.
- **Only the browser that started a sign-in can complete it.** `/auth/login` sets a second cookie, `desk_signin` (`HttpOnly`, `SameSite=Lax`, `Path=/auth`, 10 minutes), holding a random value kept with the pending sign-in; the callback is refused without it or with another sign-in's, and clears it.
- **A POST from a page on another site is refused,** by its `Origin` header.

| Folder | Holds |
|---|---|
| `src/` | The server: routes, sign-in and sessions, the inquiry store, the calls to agents and to the case system |
| `shared/api.ts` | The types of the server's API, read by both the server and the app |
| `web/` | The React app, built by Vite to static files that the server hands out |
| `test/` | Tests of the server |

## Settings

Set in [`compose.yaml`](compose.yaml).

| Setting | Meaning |
|---|---|
| `AGENTS` | The agents an inquiry can be sent to: a JSON list of `{ id, name, description, scope, url, wait_seconds? }`, where `scope` (`agents:intake`, `agents:expert` or `agents:orchestrator`) is what a token sent to the agent must hold and what a person must be granted to run it, and `wait_seconds` (a whole number from 30 to 295, 180 when absent) is how long the server waits for that agent's answer. 295 is the most because Node's `fetch` stops waiting at 300 s. Four are configured: both intake agents, the label expert, and the orchestrator, which is waited for 295 s |
| `CASE_REVIEW_URL` | Where the case system's review server is |
| `CLIENT_DB_PATH` | The SQLite file for inquiries and runs |
| `WEB_ROOT` | The folder holding the built app |
| `OIDC_DISCOVERY_URL` | Where the server fetches the identity provider's discovery document: `http://identity:8080/realms/lab/.well-known/openid-configuration` |
| `OIDC_ISSUER` | The issuer that document and every ID token must name, exactly: `http://localhost:8090/realms/lab` |
| `OIDC_CLIENT_ID` | `desk` |
| `OIDC_CLIENT_SECRET` | The desk client's secret: `IDENTITY_DESK_CLIENT_SECRET` from `platform/identity/.env`, the only value the container takes from that file |
| `OIDC_REDIRECT_URI` | `http://localhost:3000/auth/callback` |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | `http://localhost:3000/` |
| `OIDC_REVOCATION_ENDPOINT` | Where the refresh token is revoked at sign-out: `http://identity:8080/realms/lab/protocol/openid-connect/revoke`, or `none` for a provider without one. A setting, not taken from the discovery document, because Keycloak names this one endpoint at the browser's address (`localhost:8090`) even when its document is fetched from inside the network, and the server cannot reach that address |
| `APP_ORIGIN` | The origin the app is served from: `http://localhost:3000` |
| `ROLES_CLAIM` | The ID-token claim that lists the user's roles, shown on the session: `roles` |

The case system's two scopes, `cases:read` and `cases:review`, are fixed in the code. Every setting is required; the server stops at start-up naming any that is missing. The identity provider is not asked anything until someone signs in, so the server starts, and answers `/ping` and the app, while it is down.

## Known limits

- **Sessions live in the server's memory.** A restart signs everyone out, and a session is only removed by signing out or by a failed refresh.
- **What a session may do is fixed at sign-in.** A change to a person's role takes effect when they sign in again.
- **The cookie is not marked `Secure`,** because the lab is served over plain HTTP on this machine.
- **Inquiries recorded before sign-in existed** have no author, so nobody can read them through the desk.
- **A run that is in progress when the server stops is marked as failed** when it starts again. The agent may still have acted.
- **The React app has one test, of its formatting helpers.** It is typechecked, linted and built by the repository check. The screens from before sign-in were looked at by hand; the sign-in screen, the signed-in rail, the decision controls and the screen for an account with nothing to do have not been.
- **Sign-in has been tested against a stand-in provider only** (`test-support/issuer.ts`), not yet through this server against the lab's Keycloak.
