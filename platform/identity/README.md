# Identity provider

An OpenID Connect provider for the lab: Keycloak 26.8.2 in development mode, with one realm, `lab`, imported from [`realm/lab-realm.json`](realm/lab-realm.json) every time it starts.

It is a local stand-in for the identity provider that AgentCore's JWT authorizer trusts. On AWS that authorizer is configured with a discovery URL, the allowed audiences (`aud`), the allowed client IDs (read from a claim named `client_id`), and optional rules on custom claims. The tokens issued here carry those claims in that shape, so the code that checks them depends on nothing particular to Keycloak.

Each token the client sends is for one target, named by its scope. The client's server signs staff in here, validates their ID tokens, and gets a token for each call by refresh: an agent's scope for an agent, `cases:read` or `cases:review` for the case system. Each agent accepts a token for itself with its scope, and exchanges it, as itself with its own secret, for a token for what it calls: the intake agents for the case system, the label expert for the retrieval service, the orchestrator for the intake agent on Strands and for the label expert, which each exchange the token they are sent again for their own tool server. The case system accepts tokens from the intake agents on its agents' server and from the client on its review server, records the agent from the token's client and the person from its user, and takes the reviewer from it. The retrieval service (`knowledge/`) accepts tokens with audience `knowledge` and scope `labels:search` from the label expert and the knowledge gate, and takes nothing else from them. Two machines, the evaluation runner and the knowledge gate, get tokens as their own clients by client credentials.

How it is put together: [docs/architecture/identity.md](../../docs/architecture/identity.md).

## Always true

1. No secret or password is in a tracked file: every one in the realm file is a placeholder that `setup.sh` generates, `.env.example` names, and the compose file passes to the provider.
2. A role that lets someone run an agent also grants every scope that agent's client may ask for.
3. Only an agent's client can exchange a token, and no client takes a password in place of a sign-in.
4. Every person and every machine account has a fixed identifier, so the subject in their tokens does not change when the provider starts again.
5. Running set-up again changes no value that is already set, and writes a value for each variable that has none.

The repository check runs one test for each, `identity 1` to `identity 5`, on the tracked files; `setup.sh` runs from a copy in a temporary directory. What the running provider issues and refuses is shown by the gate.

## Set up and start

On the machine you work on, from the repository root:

```bash
platform/identity/setup.sh
docker compose -f platform/identity/compose.yaml up -d --wait
```

`setup.sh` writes `platform/identity/.env` with a random value for every variable in [`.env.example`](.env.example): the Keycloak administrator's username and password, the secret of each client that has one (`desk`, the four agents, the two machines), and each person's password. It needs only a shell and Docker; the values are made in the pinned Node image, with no network. If the file already holds every variable it changes nothing. If it exists but lacks some, it writes a random value for each of those, appended or on its empty `NAME=` line, keeps every other line as it is, and names on standard error the variables it added; every secret and password already set stays the same. A variable in `.env.example` that it does not know how to make a value for stops it, named, with the file unchanged. It never prints a value.

`docker compose up --wait` returns once the realm's discovery document answers 200. The lab's root `compose.yaml` includes this service, so `docker compose up` at the root starts it with everything else, and also needs `platform/identity/.env`: without it nothing starts.

The realm is imported from the file at every start, and the provider keeps nothing between starts (see "Development only"). Stopping and starting it, or removing it with its volumes, gives the same realm with the same accounts (and account ids), passwords and client secrets, and new signing keys.

### After changing the realm file

The file is read only when the container starts, so an edit to [`realm/lab-realm.json`](realm/lab-realm.json) changes nothing while the provider runs, and `docker compose up -d` does not restart it (its configuration has not changed). Restart it:

```bash
docker compose restart identity                                    # the whole lab, from the repository root
docker compose -f platform/identity/compose.yaml restart identity  # the provider started on its own
```

Stopping the container empties the tmpfs that holds its database, so the start imports the file as it now is, with new signing keys. Every token issued before the restart is then refused, and everyone signed in to the desk signs in again. Run the gate afterwards to check the realm still issues the tokens described here. A realm that does not import never becomes healthy.

A realm file that names a variable `platform/identity/.env` lacks also needs `setup.sh` run again and a rebuilt stack: see [Changing the realm file](../../docs/architecture/identity.md#changing-the-realm-file).

## Users

Four synthetic people, each with one lab role and a permanent password, and two service accounts, one for each machine.

| Username | Name | Email | Realm roles | Password |
|---|---|---|---|---|
| `dana.desk` | Dana Desk | `dana.desk@example.org` | `desk`, `default-roles-lab` | `IDENTITY_DANA_PASSWORD` in `platform/identity/.env` |
| `morgan.medinfo` | Morgan Medinfo | `morgan.medinfo@example.org` | `medical-information`, `default-roles-lab` | `IDENTITY_MORGAN_PASSWORD` in `platform/identity/.env` |
| `riley.reviewer` | Riley Reviewer | `riley.reviewer@example.org` | `safety-reviewer`, `default-roles-lab` | `IDENTITY_RILEY_PASSWORD` in `platform/identity/.env` |
| `avery.auditor` | Avery Auditor | `avery.auditor@example.org` | `auditor`, `default-roles-lab` | `IDENTITY_AVERY_PASSWORD` in `platform/identity/.env` |
| `service-account-evaluation` | Evaluation Harness | — | `evaluation`, `default-roles-lab` | None: it is the `evaluation` client, by its secret |
| `service-account-knowledge-gate` | Knowledge Gate | — | `knowledge-gate`, `default-roles-lab` | None: it is the `knowledge-gate` client, by its secret |

| Role | Grants | So the holder may |
|---|---|---|
| `desk` | `agents:intake`, `agents:expert:delegated`, `agents:orchestrator`, `cases:write`, `labels:search` | Enter inquiries and run the intake agents and the orchestrator |
| `medical-information` | `agents:intake`, `agents:expert`, `agents:expert:delegated`, `agents:orchestrator`, `cases:write`, `labels:search` | Do what the desk does, and run the label expert |
| `safety-reviewer` | `cases:read`, `cases:review` | Read cases and decide them |
| `auditor` | `cases:read`, `traces:read` | Read cases and their audit trails, and every run's trace in the client; change nothing |
| `evaluation` | `agents:expert`, `labels:search` | Call the label expert |
| `knowledge-gate` | `labels:search` | Search the retrieval service |

`cases:write` and `labels:search` go with the roles that run an agent (invariant 2), because the agent asks for them when it exchanges that person's token, and an exchange that leaves out a scope asked for ends the run. `agents:intake` and `agents:expert:delegated` go with the roles that run the orchestrator for the same reason: it asks for them when it exchanges the person's token for each sub-agent. `desk` grants `labels:search` because the label expert exchanges a desk user's token, sent to it by the orchestrator, for the retrieval service. `agents:expert:delegated` is no use to the `desk` client, which may not ask for it.

`cases:lookup` is in the realm, names the audience `case-system`, and guards the case system's `find_case`. No client may ask for it, so no token carries it and an intake agent is offered no lookup (gate statement G9 shows an intake agent's client refused it). No role is mapped to it either; that alone is not the control.

`traces:read` lets a session read every run's trace, steps included, in the client. Only `auditor` grants it and only `desk` may ask for it. It names no audience: the client checks the session's grant, and no service receives a token carrying it. The steps travel in the agent's response and are stored by the client; this scope decides only who may read them there.

The administrator for the admin console at <http://localhost:8090/admin/> is `IDENTITY_ADMIN_USERNAME` with `IDENTITY_ADMIN_PASSWORD`, in the same file. Changes made in the console are lost at the next start.

## The client and the other clients

`desk`, for the desk's server, is the one client people sign in through.

| Setting | Value |
|---|---|
| Type | Confidential: it has a secret, `IDENTITY_DESK_CLIENT_SECRET` in `platform/identity/.env` |
| Flow | Authorization Code only. No password grant, no implicit flow, no service account, no device grant, no token exchange |
| PKCE | Required, method `S256` |
| Redirect URI | `http://localhost:3000/auth/callback`, exactly |
| Post-logout redirect URI | `http://localhost:3000/` |
| May ask for | `agents:intake`, `agents:expert`, `agents:orchestrator`, `cases:read`, `cases:review`, `traces:read`. It is the only client that may ask for `traces:read`. Asking for `labels:search` or `agents:expert:delegated`, which it may not, is refused with `invalid_scope` (gate statement G6) |

| Client | For | How it gets a token | May ask for | Secret |
|---|---|---|---|---|
| `intake-handwritten`, `intake-strands` | The two intake agents | Token exchange of the token it was called with | `cases:write`. Asking for `cases:lookup` is refused with `invalid_scope` (gate statement G9) | `IDENTITY_INTAKE_HANDWRITTEN_CLIENT_SECRET`, `IDENTITY_INTAKE_STRANDS_CLIENT_SECRET` |
| `expert` | The label expert | Token exchange of the token it was called with | `labels:search` | `IDENTITY_EXPERT_CLIENT_SECRET` |
| `orchestrator` | The orchestrator | Token exchange of the token it was called with, once for each call to a sub-agent | `agents:intake`, `agents:expert:delegated`. It is the only client that may ask for `agents:expert:delegated` | `IDENTITY_ORCHESTRATOR_CLIENT_SECRET` |
| `evaluation` | The evaluation runner | Client credentials, as its service account | `agents:expert` | `IDENTITY_EVALUATION_CLIENT_SECRET` |
| `knowledge-gate` | The knowledge gate | Client credentials, as its service account | `labels:search` | `IDENTITY_KNOWLEDGE_GATE_CLIENT_SECRET` |
| `case-system`, `knowledge` | Named as audiences only | None | Nothing | None |

Only the four agents' clients can exchange a token. No client has the password grant, the implicit flow or the device grant.

## Access token claims

An access token is a JWT signed with RS256 by a key published at the realm's `jwks_uri`, and carries:

| Claim | Value |
|---|---|
| `iss` | `http://localhost:8090/realms/lab`, whichever address was used to reach the provider |
| `aud` | The audiences of the scopes granted, and no other: `intake-handwritten` and `intake-strands` for `agents:intake`, `expert` for `agents:expert` and `agents:expert:delegated`, `orchestrator` for `agents:orchestrator`, `case-system` for the four case scopes, `knowledge` for `labels:search`, none for `traces:read`. An exchanged token names the one audience the agent asked for |
| `client_id` | The client it was issued to: `desk` for a person's token, the agent for an exchanged token, `evaluation` or `knowledge-gate` for a machine's |
| `scope` | The scopes granted, separated by spaces. Keycloak adds others, such as `profile` and `email`, which no service reads |
| `roles` | A top-level array of the account's realm role names: its one lab role, and Keycloak's default role `default-roles-lab` with the roles it includes (`offline_access`, `uma_authorization`), so it is never empty |
| `sub`, `preferred_username`, `name` | The account's id, username and full name. The id is fixed in the realm file, so `sub` is the same after every start. An exchanged token carries the person's |
| `exp` − `iat` | 600 seconds. An exchanged token keeps the `exp` of the token it was exchanged for |

`client_id` and `roles` are added by mappers on each client, and `aud` by the audience mappers of each scope, in the realm file; Keycloak puts none of them in a token by default (its own token names the client in `azp` and the roles under `realm_access`). A person's token from sign-in carries no `realm_access` or `resource_access` claim. Other claims Keycloak adds (`azp`, `sid`, `email` and so on) are not part of this contract.

A person's role bounds the scopes a request can get. Keycloak leaves out a scope `desk` may ask for that the role does not grant, and still answers 200, so a token request that succeeds proves nothing: each service checks the audience, the client and the scope itself.

An account that holds no realm role at all would get no `roles` claim: Keycloak leaves an empty list out. That is why every account holds the default role.

## ID token

The ID token issued with it, also signed with RS256 by a key at `jwks_uri`, names the same issuer, has `desk` as its audience, and carries the same top-level `roles` array. The same `roles` mapper on the `desk` client puts it in both tokens. The ID token is what tells the desk's server who signed in. What they may do there comes from the scopes the token response grants.

## Two addresses

| Who | Reaches the provider at | Gets |
|---|---|---|
| A browser on this machine | `http://localhost:8090` | Sign-in and sign-out pages on `http://localhost:8090` |
| A container on the lab's network | `http://identity:8080` | Discovery, token endpoint, keys and userinfo on `http://identity:8080` |

The issuer is `http://localhost:8090/realms/lab` on both. Keycloak does this through two settings in `compose.yaml`: `KC_HOSTNAME=http://localhost:8090` fixes the issuer and every front-channel URL, and `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` lets back-channel URLs follow the address the request came in on.

| Discovery field | Fetched at `http://localhost:8090` | Fetched at `http://identity:8080` |
|---|---|---|
| `issuer` | `http://localhost:8090/realms/lab` | `http://localhost:8090/realms/lab` |
| `authorization_endpoint` | `http://localhost:8090/realms/lab/protocol/openid-connect/auth` | `http://localhost:8090/realms/lab/protocol/openid-connect/auth` |
| `token_endpoint` | `http://localhost:8090/realms/lab/protocol/openid-connect/token` | `http://identity:8080/realms/lab/protocol/openid-connect/token` |
| `jwks_uri` | `http://localhost:8090/realms/lab/protocol/openid-connect/certs` | `http://identity:8080/realms/lab/protocol/openid-connect/certs` |

## The gate

`gate.sh` checks a running service for real, from inside the stack's network, and exits 0 only if every statement below holds:

```bash
platform/identity/gate.sh <compose-project>
```

`<compose-project>` is the compose project the service runs in: `ai-on-aws` when the lab was started from the root, or the name given with `-p`. For example, a trial run on its own:

```bash
docker compose -p identity-trial -f platform/identity/compose.yaml up -d --wait
platform/identity/gate.sh identity-trial
docker compose -p identity-trial -f platform/identity/compose.yaml down -v
```

The gate runs in the pinned Node image on the project's default network (`<compose-project>_default`), with `jose` installed from the lockfile. Its image is `ai-on-aws-identity-gate:checkout-<number>` and its compose project `ai-on-aws-identity-gate-<number>`, the number derived from the checkout's path as `toolchain/check.sh` derives its own. So two checkouts never run each other's gate. `gate.sh` and `stack-gate.sh` print the image on standard error. The gate is given the `desk` client's secret, every agent's and machine's secret, and the four passwords, and reads what it expects from [`gate/gate.config.json`](gate/gate.config.json). Its statements are named G1 to G16 in [`gate/gate.ts`](gate/gate.ts), and checked in this order:

1. G14: the discovery document at `http://identity:8080` answers, names the issuer `http://localhost:8090/realms/lab`, and its key set answers with keys.
2. G1: each of the four people signs in through the Authorization Code flow with PKCE, asking for `openid` and every scope `desk` may ask for: the gate requests the authorization endpoint, posts the sign-in form with a cookie jar, reads the redirect to the callback without requesting it, and exchanges the code at the token endpoint with the client secret and the code verifier. The token is granted exactly the scopes the person's role grants.
3. G2: each access token is signed with RS256 by a published key and carries the issuer, exactly the granted scopes' audiences, `client_id` `desk`, the fixed `sub`, `preferred_username`, `name`, `roles` holding the person's one lab role and no other, no `realm_access` or `resource_access`, and `exp` − `iat` of 600. Each ID token's signature, issuer and audience are verified (statements the report names G14), and its `roles` checked the same way.
4. G3 to G5: a refresh with `scope=openid <scope>`, for each scope the person is granted, gives a token for that scope's audiences alone, and for `traces:read`, which names none, a token that names no audience (G3). The refresh token that refresh returned still obtains the whole grant, and a token for each other granted scope (G4). A refresh for a scope `desk` may ask for that the role does not grant is answered 200, without that scope or its audiences (G5).
5. G11, G12: each machine gets a token by client credentials for its scope, with the scope's audiences, its own `client_id`, its fixed `sub`, `preferred_username` `service-account-<client>`, a name, and its one role and no staff role. `evaluation` asking for `labels:search`, `agents:expert:delegated` or `traces:read`, and `knowledge-gate` asking for `agents:expert:delegated` or `traces:read`, are refused `invalid_scope`.
6. G7, G8, G11: each agent exchanges each token it is an audience of (the intake agents `dana.desk`'s `agents:intake` token; the label expert `morgan.medinfo`'s `agents:expert` token and `evaluation`'s) for its tool server's audience and scopes: the intake agents audience `case-system` with `cases:write` alone, the label expert audience `knowledge` with `labels:search`. The token issued names that audience alone, the agent as `client_id` and `azp`, the subject's `sub`, `preferred_username`, `name`, `roles` and `exp`, and every scope asked for and no other of the lab's scopes; no refresh token comes with it.
7. G15, G16: the chain through the orchestrator, for `dana.desk`'s and `morgan.medinfo`'s `agents:orchestrator` tokens. The orchestrator exchanges each for each sub-agent: audience `intake-strands` with scope `agents:intake`, and audience `expert` with scope `agents:expert:delegated`. The token issued names that audience alone, `orchestrator` as `client_id` and `azp`, the person's `sub`, `preferred_username`, `name`, `roles` and `exp`, and the scope asked for and no other of the lab's scopes; no refresh token comes with it (G15). The sub-agent then exchanges that token for its own tool server's audience and scopes, and the token issued is checked as in step 6, against the token the orchestrator got (G16).
8. G9: an agent, the orchestrator among them, exchanging a person's token it is not an audience of is refused 403 `Client is not within the token audience`.
9. G13, G14: the token endpoint refuses the password grant for `desk`, and client credentials for `desk`, `case-system` and `knowledge`; the authorization endpoint refuses a request with no `code_challenge`, one with `code_challenge_method=plain`, and one with `response_type=token`.
10. Last, G10: `desk`, `case-system`, `knowledge` and both machines cannot exchange a token. G9: an agent asking for a scope its client may not ask for is refused `invalid_scope`: an intake agent asking for the retrieval service (`labels:search`) or the label expert for the case system (`cases:write`), either asking for `agents:expert:delegated`, which only `orchestrator` may ask for; an intake agent asking for `cases:lookup`; the orchestrator asking for `labels:search` or `agents:expert`; and each of the four agents' clients asking for `traces:read`, which only `desk` may ask for (with its own tool server's audience, and the orchestrator with `intake-strands`, since the scope names none). G6: `desk` asking for `labels:search` or `agents:expert:delegated` is refused `invalid_scope`, at a refresh and at the authorization endpoint. These are checked last, so that a wrong expectation among them leaves every statement before them checked.

The gate is the browser here, but it runs inside the network, where `localhost:8090` is the gate's own container. So the front-channel URLs the provider hands out on `http://localhost:8090` (the authorization endpoint and the sign-in form's action) are sent to `http://identity:8080` with the same path and query. Back-channel URLs from discovery are used as given.

It does not fetch discovery at `http://localhost:8090`.

It prints a JSON report: the endpoints from discovery; for each person the token's header and decoded claims, the ID token's `roles` and each token got by a refresh for one scope (G3); each machine's and each exchanged token's header and claims; and the status and error code of each refusal. It prints no password, secret, code or token. On the first statement that does not hold it exits 1 and names it in `failed`; a provider that does not answer is such a statement. Exit 1 always comes with a report on standard output. Any way of ending without one (no Docker, no `platform/identity/.env`, no network for the project, Compose failing before the gate runs, a gate that writes nothing) is exit 2, with the reason on standard error.

## The stack gate

`stack-gate.sh` checks the whole running stack end to end, from inside its network: whether the realm, the agents, the tool servers and the client agree. No test runs one piece against another, so a mismatch between two of them is caught here or nowhere.

```bash
platform/identity/stack-gate.sh <compose-project>
```

It uses the same image as `gate.sh` and joins `<compose-project>_default` the same way. It is given the four people's passwords, and the secrets of `desk`, `intake-handwritten`, `expert`, `orchestrator`, `evaluation` and `knowledge-gate`. Through the client it signs each person in on Keycloak's own sign-in page; the client exchanges the code, and the gate holds only cookies. The secrets are for the tokens it gets for itself in step 7.

It changes the stack it is run against. It enters four inquiries, all from the sender `Dr Gate, gate@example.org`, and up to three cases may be opened from them, each an adverse event with the invented medicine `examplamab`: one by each intake agent from its own report, and one by the intake agent on Strands from the orchestrator's. Run it on a trial stack, or on one where those inquiries and cases are acceptable.

| Sent by | To | Message |
|---|---|---|
| `dana.desk` | `intake-handwritten` | A report of a 54-year-old man, J.K., with a rash a week after starting `examplamab` 10 mg once daily, with the reporter's contact |
| `dana.desk` | `intake-strands` | A report of a 67-year-old woman, M.R., with severe dizziness and a fall three days after starting `examplamab` 20 mg once daily, with the reporter's contact |
| `morgan.medinfo` | `expert` | What the `examplamab` label says about the usual starting dose for adults |
| `dana.desk` | `orchestrator` | A report of a 38-year-old woman, S.T., with swelling of the lips and tongue two days after starting `examplamab` 10 mg once daily, with the reporter's contact; and, separately, what the `examplamab` label says about the usual starting dose for adults |

In order, it checks:

1. With no token or session: the client's `/api/inquiries` is 401 and its `/ping` 200; each agent (`intake-handwritten`, `intake-strands`, `expert`, `orchestrator`) answers 401 `missing` with `WWW-Authenticate: Bearer error="invalid_token"` to no token, 401 `malformed` to a token that is not a JWT, 401 to no token with a body outside the contract, and 200 on `/ping`; the case system's MCP endpoint, its review server and the retrieval service's MCP endpoint each answer 401, and each `/ping` 200.
2. For each of the four people: `/auth/login` redirects to the provider with the code flow, the client, the redirect URI, `openid`, a state, a nonce and an S256 challenge, and sets the sign-in cookie with its attributes; Keycloak accepts the password and redirects to the callback; the callback creates a session, sets the session cookie with its attributes and clears the sign-in cookie; a replayed callback, and a callback without the sign-in cookie, are 400; `/api/session` names the person, says what they may do (below), says whether they may read traces (below), and carries no token; `/api/agents` lists exactly the agents `/api/session` says they may run; `/api/status` lists the identity provider as up; a POST from another origin is 403 `cross_site_request`.
3. Through the client, each person is refused what they may not do, with 403 `not_allowed`: `dana.desk` sending an inquiry to the label expert or reading the case list, `riley.reviewer` sending an inquiry to an intake agent or to the orchestrator, `avery.auditor` deciding a case, `morgan.medinfo` reading the case list. `riley.reviewer` and `avery.auditor` read the case list (200). `riley.reviewer` deciding a case that does not exist gets the case system's own 404 `case_not_found`, so the token and its scope were accepted there.
4. `dana.desk` sends an adverse event report to each intake agent and `morgan.medinfo` a question to the label expert (the messages above). Each is accepted and records who entered it; the run its person reads back holds no `steps` (when it has no response, the statement goes in `not_checked`); the gate reads the run's trace through the client as `avery.auditor`, and every statement below about a run's steps or delegations reads them from that trace, and fails, saying why, when the trace could not be read. Each run ends `completed`, recording who started it, with a stop reason that is not one of the agents' own reasons for a run that stopped at a token: "The case system refused the agent's token.", "The case system could not check the agent's token.", "The case system could not be reached.", the same three for the retrieval service, matched exactly, and any reason starting "The agent could not get a token for the case system: " or "The agent could not get a token for the retrieval service: ". Two statements depend on what the run did. When an intake run's answer reports a case it opened, `riley.reviewer` reads that case through the client and its `case_created` audit entry must name the agent as actor; when it opened none, the statement goes in `not_checked`. When the expert's run has a step that exists only after the retrieval service accepted its token and answered (a retrieval step, or a `find_labels` or `search_label` step that is not an error), the statement that the service accepted the expert's token holds; when it has none, it goes in `not_checked`. Then `dana.desk` sends the orchestrator its message, and the gate waits up to 300 s for that run, longer than the client's 295 s. The run must end inside the contract with outcome `completed` or `stopped`, record who started it, and hold a `delegation` step to `intake-strands` that has a response. That screening must not have stopped at a token: the delegated response's stop reason is none of the reasons above, and the delegation's failure does not start "The agent could not get a token for ". Three statements depend on what the run did. When the delegated intake run opened a case, `riley.reviewer` reads it through the client and its `case_created` audit entry must name `intake-strands` as actor. When the run put a label question to the expert, at least one delegation to `expert` must have a response, and none may have stopped at a token or failed its exchange. When a delegated expert response has a step the retrieval service answered, the statement that the service accepted the expert's token for the orchestrator's question holds. Each of the three goes in `not_checked` when the run did not reach what it needs.
5. Through the client, `dana.desk`, `morgan.medinfo` and `riley.reviewer` each get 403 from both trace routes: the list, and the trace of a run the gate made in step 4 (of an id no run has, when it made none). For `avery.auditor` the list is 200 and holds every run the gate made in step 4, and the trace read of the first run read back with a response holds at least one step. Each of the two goes in `not_checked` when no run was made, or none was read back with a response.
6. `morgan.medinfo` reading the inquiry `dana.desk` entered, and starting a run on it, each get the same status and body, the id aside, as for an inquiry id that does not exist. The inquiry carries its runs, so reading it covers them.
7. The gate gets tokens of its own from the provider and presents each straight to a service (below).
8. Each person signs out: the answer carries the provider's end-session address and no token, and the same cookie is then 401. After the run, on the Docker host, the script reads the client's output since the gate started and requires no revocation failure in it; only the count of such lines is passed to the report.

| Person | `may.agents` | `read_cases` | `decide_cases` | `read_traces` |
|---|---|---|---|---|
| `dana.desk` | `intake-handwritten`, `intake-strands`, `orchestrator` | false | false | false |
| `morgan.medinfo` | `intake-handwritten`, `intake-strands`, `expert`, `orchestrator` | false | false | false |
| `riley.reviewer` | none | true | true | false |
| `avery.auditor` | none | true | false | true |

| Token the gate gets | Presented to | Must be answered |
|---|---|---|
| `riley.reviewer`'s, refreshed for `cases:read` | The review server, `GET /cases` | 200 |
| The same | The case system's agents' server, `/mcp` | 401 `wrong_client` |
| `avery.auditor`'s, refreshed for `cases:read` | The review server, `POST /cases/<id>/review` | 403 `insufficient_scope`, naming `cases:review` |
| `dana.desk`'s, refreshed for `agents:intake` | The label expert, `POST /invocations` | 401 `wrong_audience` |
| The same | The case system's agents' server, `/mcp` | 401 `wrong_audience` |
| `dana.desk`'s, exchanged as `intake-handwritten` for `case-system` | The review server, `GET /cases` | 401 `wrong_client` |
| The same | The case system's agents' server, `/mcp` | Neither 401 nor 403 |
| `knowledge-gate`'s, by client credentials for `labels:search` | The retrieval service, `/mcp` | Neither 401 nor 403 |
| `evaluation`'s, by client credentials for `agents:expert` | The retrieval service, `/mcp` | 401 `wrong_audience` |
| `evaluation`'s, exchanged as `expert` for `knowledge` | The retrieval service, `/mcp` | Neither 401 nor 403 |
| `dana.desk`'s, refreshed for `agents:orchestrator` | The intake agent on Strands, `POST /invocations` | 401 `wrong_audience` |
| The same | The label expert, `POST /invocations` | 401 `wrong_audience` |
| `dana.desk`'s `agents:orchestrator` token, exchanged as `orchestrator` for `intake-strands` with `agents:intake` | The intake agent on Strands, `POST /invocations`, with a body outside the contract | 400: the token was accepted and nothing was run |
| `dana.desk`'s `agents:orchestrator` token, exchanged as `orchestrator` for `expert` with `agents:expert:delegated` | The label expert, `POST /invocations`, with a body outside the contract | 400: the token was accepted and nothing was run |
| The same | The intake agent on Strands, `POST /invocations` | 401 `wrong_audience` |
| `dana.desk`'s, refreshed for `agents:intake` | The orchestrator, `POST /invocations` | 401 `wrong_audience` |

Every statement is checked even after one fails. The JSON report has three lists: `held`, `failed` and `not_checked`. A statement goes in `not_checked`, with the reason, when the stack could not show it: that a run read back holds no steps, when it has no response; the case's audit entry when the intake run opened no case, and the retrieval statement when the expert's run has no step the retrieval service answered, as when a run ends at the model on a stack with no model server; either one also when its run was never started. The orchestrator's run has the same two, for its delegated runs, and a third: the statement on its delegations to the expert, when the run put no label question to the expert. A statement in `not_checked` is neither held nor failed, so the gate can exit 0 with it, and standard error says how many there were. When the client's output cannot be read, the revocation statement goes in `failed`, since it was not checked; `stack-gate.sh` says so on standard error. The report carries no password, code or token. Exit 1 if any statement does not hold, always with the report on standard output; exit 2, with the reason on standard error and nothing on standard output, for any way of ending without a report.

## Other programs that sign in

Three more programs sign in on the stack's network. Two do it as machines: each as its own client, by client credentials with its own secret ([`shared/machine-token.ts`](../../shared/machine-token.ts)); no person signs in, and neither is given a password. Compose gives each its own client's secret from `platform/identity/.env`, and nothing else from it. The third, the attack runner, signs each of the four people in through the client, as the stack gate does, and is given their four passwords and nothing else; it reads each run's trace as `avery.auditor`.

| Program | Client | Scope | Secret | Uses the access token to |
|---|---|---|---|---|
| `knowledge/gate.sh` | `knowledge-gate` | `labels:search` | `IDENTITY_KNOWLEDGE_GATE_CLIENT_SECRET` | Call the retrieval service's MCP endpoint |
| `evaluation/run.sh` | `evaluation` | `agents:expert` | `IDENTITY_EVALUATION_CLIENT_SECRET` | Call the label expert's `POST /invocations`, which exchanges it for its own token for the retrieval service. It gets a new token before the current one has under 200 s left |
| `evaluation/attacks.sh` | None of its own: it signs each of the four people in through the client (`desk`), as the stack gate does, with `src/desk.ts` | What each person's role grants at sign-in | `IDENTITY_DANA_PASSWORD`, `IDENTITY_MORGAN_PASSWORD`, `IDENTITY_RILEY_PASSWORD`, `IDENTITY_AVERY_PASSWORD`, and no client secret | Holds no token, only each person's client cookie: sends each case's inquiry as its person, reads each ended run's trace as `avery.auditor`, and reads cases as `riley.reviewer`. A person whose session ends signs in again once |

## Development only

| What | Here | Why it is not for production |
|---|---|---|
| Mode | `start-dev` | Keycloak's development mode: relaxed hostname checks, caches local to the process, no build optimisation |
| Database | `dev-file`, an H2 file inside the container on a tmpfs | Lost at every stop; one process only |
| Transport | HTTP, published on `127.0.0.1:8090` only | Tokens and passwords travel unencrypted. Acceptable on loopback and the lab's own network only |
| Signing keys | Made at every start | A token issued before a restart no longer verifies after it |
| Secrets | `platform/identity/.env`, read at start | A plain file on the machine |

## Hardening

The service has `cap_drop: ALL`, `no-new-privileges`, `init` and tmpfs mounts on `/tmp` and `/opt/keycloak/data`, as the lab's other services do.

It does not have a read-only root filesystem. `start-dev` rebuilds Keycloak's server into `/opt/keycloak/lib/quarkus` at every start, and that build starts from the files the image ships in the same directory:

| Setting | What happens |
|---|---|
| `read_only: true` | Start fails: `/opt/keycloak/lib/quarkus/transformed-bytecode.jar: Read-only file system` |
| `read_only: true` and a tmpfs on `/opt/keycloak/lib/quarkus` | Start fails: the tmpfs hides the image's files, and `quarkus-application.dat` is not found |
| `read_only: true` and a named volume on `/opt/keycloak/lib/quarkus` | Starts. Not used: Docker fills a named volume from the image only while the volume is empty, so after the image digest changes the volume would still hold the old image's build, and the built server would outlive `docker compose down` without `-v` |

So the container's own layer holds the rebuilt server, and is discarded with the container.

## Not present

| What | Note |
|---|---|
| Every agent in a chain named | A token names one client, the one it was issued to. An exchanged token names the agent in `client_id` and `azp`, and the person in `sub`; no claim a service reads names the client before the agent. Through the orchestrator, the case system's audit trail names the intake agent on Strands, not the orchestrator that called it |
| A token limited to one run or message | An exchanged token is limited to the agent, one audience and the scopes asked for, and lasts until the token it was exchanged for expires |
| Rules on data | No rule limits reading to a person's own cases: `cases:read` reads every case. No four-eyes rule: one person with `cases:review` decides a case alone |
| HTTPS | — |
| Refresh-token policy (rotation included), session limits, brute-force protection, password policy | Keycloak's defaults for a new realm |
| Self-registration, password reset, email | Turned off; no mail server |
| Multi-factor sign-in | — |
| Federation with another identity provider | — |
| A production database, clustering, or persistence across restarts | — |
