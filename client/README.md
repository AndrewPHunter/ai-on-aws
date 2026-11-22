# Client

The front end of the lab: a medical information desk. Inquiries from clinicians arrive here, are handed to an agent, and come back with a reply, the passages of the drug label it relied on, and any adverse event case it opened. People review those cases here too.

It is a React app and a small Node server that the app talks to. Desk staff sign in through the lab's [identity provider](../platform/identity/README.md). All data in it is synthetic.

Every command on this page is run from the root of the repository.

## Run it

```bash
platform/identity/setup.sh
docker compose up -d --build --wait
```

Then open <http://localhost:3000>, by that name and not `127.0.0.1`: the identity provider sends the browser back to `localhost`, and the session cookie belongs to it. Sign in as `riley.reviewer` (a reviewer) or `dana.desk` (not a reviewer); their passwords are `IDENTITY_RILEY_PASSWORD` and `IDENTITY_DANA_PASSWORD` in `platform/identity/.env`, which the first command writes.

That starts the client together with the [agents](../agents/README.md), the [case system](../tools/case-system/README.md) and the [identity provider](../platform/identity/README.md), on one network. All are published on this machine only. The agents need the model server, so [set that up](../model/README.md) first.

```bash
docker compose down
```

stops them and keeps the inquiries and cases. Add `-v` to delete them.

## The screens

| Screen | What it is for |
|---|---|
| Sign in | The only screen without a session: one action, which goes to the identity provider. |
| Inquiries | Receive a message, from a prepared one or your own, and send it to an agent. Read the reply, the label passages it cites, and any case it opened. Citations are numbered from 1, so a `[2]` in the reply can be found; each gives the drug, the section, the label's version and date, the quote, and a link to that version's page. When the agent answers from labels, one line says whether the label answered the question, and if not why. In the run's steps, each label-search hit shows the name the model was shown it by, and says when it matched but was not shown. Send the same message again, to the same agent or another, and compare the runs. Each inquiry shows who entered it, and each run who started it. |
| What the agent did | Beside each run: every step in order, with how long it took and what was sent and returned. Model calls, tool calls, label searches and hand-offs between agents each have their own read-out. |
| Cases | The review queue. A case shows its four parts as a form, every earlier version, and its audit trail; an agent's entry says whom the agent acted for ("Agent intake-strands, for Dana Desk"). A reviewer approves, rejects or asks for information, recorded under the name they signed in with; anyone else sees that only a reviewer can decide. |
| System | Each part the desk depends on, and whether it answers right now. |

## What works today

- **Inquiries, Cases and System work,** with both builds of the [intake agent](../agents/README.md). An inquiry can be sent to either, and again to the other.
- **The read-outs for citations, whether the label answered, label searches and hand-offs between agents have not been seen with real output,** because the intake agent produces none. Replies, case actions, model steps and tool steps have.
- **Label search and evaluation have no screen.** They are listed on System as not built.

## Always true

1. A message gets its identifier and receipt time once; sending it again reuses both.
2. Sending answers at once, and a run always ends as finished or failed, including after a restart.
3. An agent's answer outside the contract is a failed run with the reason.
4. Only a sign-in the provider vouched for creates a session, and only in the browser that started it.
5. Every call to an agent or the case system carries the user's token with enough life left; it is renewed first, and a failed renewal ends the session.
6. The reviewer of a case is whoever is signed in, never a name the browser sends.
7. No token reaches the browser.
8. Signing out removes the session and revokes the refresh token; a failed revocation does not stop it.
9. A POST from another site is refused.

The server's tests in `test/` are one per item, named by its number.

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
- **Every call to an agent or the case system carries the signed-in user's access token** as `Authorization: Bearer`. Before calling an agent the token must have 180 seconds left, the time the server waits for an agent; before calling the case system, 30. With less, the server renews it first; if renewal fails, the request answers 401, nothing is sent, and the user signs in again. Health checks carry no token. The agents and the case system each check the token and refuse a call without a valid one.
- **The reviewer of a case is whoever is signed in.** The server forwards a decision as `{ decision, note? }` with the user's token and no reviewer field; the case system takes the reviewer's name and subject from the token. A decision that names its own reviewer is refused here with 400, and one from someone without the `reviewer` role with 403. The case system makes the same two refusals behind it, and its answers are passed back unchanged.
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
| `AGENTS` | The agents an inquiry can be sent to: a JSON list of `{ id, name, description, url }` |
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
| `ROLES_CLAIM` | The ID-token claim that lists the user's roles: `roles` |
| `REVIEWER_ROLE` | The role a reviewer holds: `reviewer` |

Every setting is required; the server stops at start-up naming any that is missing. The identity provider is not asked anything until someone signs in, so the server starts, and answers `/ping` and the app, while it is down.

## Known limits

- **Sessions live in the server's memory.** A restart signs everyone out, and a session is only removed by signing out or by a failed renewal.
- **The cookie is not marked `Secure`,** because the lab is served over plain HTTP on this machine.
- **Inquiries and runs recorded before sign-in existed** show no author.
- **A run that is in progress when the server stops is marked as failed** when it starts again. The agent may still have acted.
- **The React app has no automated tests.** It is typechecked, linted and built by the repository check. The screens from before sign-in were looked at by hand; the sign-in screen, the signed-in rail and the reviewer-only decision have not been.
- **Sign-in has been tested against a stand-in provider only** (`test-support/issuer.ts`), not yet through this server against the lab's Keycloak.
