# Identity provider

The identity boundary separates who started a request from which service may act on it. Keycloak supplies the lab's OpenID Connect provider, with one realm imported from a file at every start. The local token checks use the audience, client and scope controls represented by AgentCore's JWT authorizer. Setup and commands are in [platform/identity/README.md](../../platform/identity/README.md).

The client's server signs staff in and keeps their grant and refresh token. Before calling an agent or the case system, it obtains a token for that call's scope, reusing a cached token only while enough life remains. It never forwards the access token from sign-in. The public contact form and lab explorer instead use client credentials as `contact-form` and `lab-explorer`.

Each service checks its audience, allowed clients and required scope. An agent then exchanges the accepted token, authenticating as itself, for a token addressed to its next service. Intake agents call the case system; the label expert calls retrieval; the orchestrator calls sub-agents, which exchange again for their tools. This keeps each handoff explicit while preserving the caller's identity. The case system records the agent as the actor and the person or machine account it acted for.

Three programs sign a person in without a browser: the identity gate, the stack gate and the attack runner (`evaluation/attacks.sh`). Four get a token as a machine, by client credentials: the knowledge gate, the evaluation runner, and the client's contact form and lab explorer, which call agents with nobody signed in ([Signing in without a browser](#signing-in-without-a-browser)).

## Terms

| Term | Meaning |
|---|---|
| Provider | The `identity` service: Keycloak 26.8.2, pinned by digest, started with `start-dev --import-realm` |
| Realm | `lab`, defined by `platform/identity/realm/lab-realm.json` |
| Identity secrets | Ignored `platform/identity/.env`: administrator credentials, client secrets for `desk`, four agents and four machines, and each synthetic person's password (their username) |
| Front channel | Requests a browser makes: the sign-in page and sign-out |
| Back channel | Requests a server makes: discovery, the token endpoint (code, refresh, exchange, client credentials), keys, userinfo |
| Scope | A capability, such as `cases:review`. Roles grant it, a client may ask for it, and it names the audiences a token for it carries |
| Audience | The service a token is for, in `aud`: an agent's id, `case-system` or `knowledge` |
| Token exchange | OAuth 2.0 Token Exchange (RFC 8693): an agent sends the token it was called with, as itself, and gets a token for one audience and the scopes it asks for |
| Gate | `platform/identity/gate.sh` and `platform/identity/gate/gate.ts`: the check that decides whether a running provider issues and refuses the tokens described here. Its statements are named G1 to G16 in `gate.ts` |
| Stack gate | `platform/identity/stack-gate.sh` and `platform/identity/gate/stack-gate.ts`: the check of sign-in and token use through the whole running stack |
| Client | The desk server in `client/src/`, registered as relying party `desk` and holding the `contact-form` and `lab-explorer` machine credentials. Named clients such as `expert` or `evaluation` are OAuth registrations in the realm |
| Session | The client's record of one signed-in user: who they are and their tokens, in the client's memory, found by a random identifier |

## What runs

```mermaid
flowchart LR
  env[platform/identity/.env] -- "environment at start" --> kc
  realm[realm/lab-realm.json] -- "imported at start, placeholders replaced" --> kc
  subgraph net["The lab's network"]
    kc["identity: Keycloak, port 8080"]
    client["client"]
    agents["agents"]
    servers["case system, retrieval service"]
    gates["identity gate, stack gate and attack runner (when run)"]
    machines["knowledge gate and evaluation runner (when run)"]
  end
  browser["Browser on this machine"] -- "http://localhost:8090 (published on 127.0.0.1)" --> kc
  browser -- "http://localhost:3000, session cookie" --> client
  client -- "http://identity:8080: discovery, keys, token (code, refresh, client credentials), revocation" --> kc
  agents -- "http://identity:8080: discovery, keys, token exchange" --> kc
  servers -- "http://identity:8080: discovery and keys" --> kc
  gates -- "http://identity:8080: sign-in page, form, token" --> kc
  machines -- "http://identity:8080: token (client credentials)" --> kc
```

| Property | Value |
|---|---|
| Image | `quay.io/keycloak/keycloak:26.8.2`, by the digest of its index for `linux/amd64` and `linux/arm64` |
| Mode | Development (`start-dev`) |
| Database | `dev-file` (H2) under `/opt/keycloak/data`, on a tmpfs |
| Realm file | `platform/identity/realm/` mounted read-only at `/opt/keycloak/data/import`; imported when the container starts, and at no other time |
| Published | `127.0.0.1:8090` to container port `8080`; nothing else |
| Ready | When `GET /realms/lab/.well-known/openid-configuration` answers 200 inside the container |
| State between starts | None. Each start imports the realm from the file and makes new signing keys |
| Container | `cap_drop: ALL`, `no-new-privileges`, `init`, tmpfs on `/tmp` and `/opt/keycloak/data`. Root filesystem writable: `start-dev` rebuilds the server into `/opt/keycloak/lib/quarkus` at every start |

### Changing the realm file

The realm file is startup configuration. The running provider keeps its imported realm until the container stops, when its tmpfs database is lost. A restart imports the current file and creates new signing keys.

| Operator does | Effect |
|---|---|
| Edits `realm/lab-realm.json` | Nothing, until the provider restarts. `docker compose up -d` does not restart it: the compose configuration has not changed |
| Restarts the provider: `docker compose restart identity` at the repository root, or `docker compose -f platform/identity/compose.yaml restart identity` when it was started on its own | The edited realm is imported; new signing keys |
| Existing tokens and sessions | The provider no longer publishes the old signing keys. Services using the new key set refuse old tokens as `bad_signature`; a service with cached old keys can still accept them until expiry or key replacement. The provider refuses old refresh tokens, so the client ends a session at its next refresh with 401 `not_signed_in` |

A realm file that names a variable the identity secrets lack needs more than a restart. Every compose file that passes a secret requires it (`${NAME:?run platform/identity/setup.sh}`), so `docker compose up` stops before starting anything and names it.

| Step | What it takes |
|---|---|
| New values | `platform/identity/setup.sh` fills missing variables with random values, sets each person's password to their username, and names the variables it set. It preserves other existing values, including client secrets and the administrator password |
| The stack started again | `docker compose down`, then `docker compose up -d --build --wait`, at the repository root. The provider starts with the new values and imports the realm file; `down` without `-v` keeps the volumes, the cases among them |
| Every image built again | `--build` builds the agents, the case system, the client and the retrieval service from the checkout, so each runs the code that matches the realm, with the values its compose file passes |
| Everyone signs in again | Old refresh tokens no longer work. Access-token checks depend on the service's cached keys, as above. People's passwords are their usernames |

## The realm

Every account has a lab role and `default-roles-lab`, which includes `offline_access` and `uma_authorization`. The default role keeps each account's `roles` claim nonempty; Keycloak omits empty role claims.

| Role | For | Held by |
|---|---|---|
| `desk` | People: enters inquiries and runs the intake agents and the orchestrator | `dana.desk` |
| `medical-information` | People: does what the desk does, and runs the label expert | `morgan.medinfo` |
| `safety-reviewer` | People: reads adverse event cases and decides them | `riley.reviewer` |
| `auditor` | People: reads every case and its audit trail, and every run's trace in the client; changes nothing | `avery.auditor` |
| `evaluation` | A machine: the evaluation harness's service account | `service-account-evaluation` |
| `knowledge-gate` | A machine: the knowledge gate's service account | `service-account-knowledge-gate` |
| `contact-form` | A machine: the client's contact form's service account | `service-account-contact-form` |
| `lab-explorer` | A machine: the client's lab explorer's service account | `service-account-lab-explorer` |

A role grants capabilities through scope mappings. Each scope's audience mappers put the corresponding services in the access token.

| Scope | Granted by | Audiences it names | Reaches |
|---|---|---|---|
| `agents:intake` | `desk`, `medical-information`, `contact-form`, `lab-explorer` | `intake-handwritten`, `intake-strands` | `POST /invocations` on both intake agents |
| `agents:expert` | `medical-information`, `evaluation`, `lab-explorer` | `expert` | `POST /invocations` on the label expert |
| `agents:expert:delegated` | `desk`, `medical-information`, `contact-form`, `lab-explorer` | `expert` | `POST /invocations` on the label expert, with a token the orchestrator got by exchange. Only the `orchestrator` client may ask for it |
| `agents:orchestrator` | `desk`, `medical-information`, `contact-form`, `lab-explorer` | `orchestrator` | `POST /invocations` on the orchestrator |
| `cases:write` | `desk`, `medical-information`, `contact-form`, `lab-explorer` | `case-system` | `create_case`, `add_follow_up` |
| `cases:lookup` | No role is mapped to it | `case-system` | `find_case`. No client may ask for it, so no token carries it and an intake agent is offered no lookup |
| `cases:read` | `safety-reviewer`, `auditor` | `case-system` | `GET /cases`, `GET /cases/<id>` |
| `cases:review` | `safety-reviewer` | `case-system` | `POST /cases/<id>/review` |
| `labels:search` | `desk`, `medical-information`, `evaluation`, `knowledge-gate`, `contact-form`, `lab-explorer` | `knowledge` | `find_labels`, `search_label` |
| `traces:read` | `auditor` | None | `GET /api/traces`, `GET /api/traces/<run_id>` on the client. Only the `desk` client may ask for it. The client checks the session's grant; no service receives a token carrying it |

Every client is confidential, with no password grant, implicit flow, device grant or CIBA, and default scopes `basic`, `profile`, `email`. Token-issuing clients map their own id to the access token's `client_id` and realm roles to a top-level `roles` claim in access and ID tokens.

| Client | What it is | How it gets a token | May ask for | May exchange | Secret |
|---|---|---|---|---|---|
| `desk` | The client's server | Authorization Code with PKCE, and refresh | `agents:intake`, `agents:expert`, `agents:orchestrator`, `cases:read`, `cases:review`, `traces:read` | No | `IDENTITY_DESK_CLIENT_SECRET` |
| `intake-handwritten` | The hand-written intake agent | Token exchange only | `cases:write` | Yes | `IDENTITY_INTAKE_HANDWRITTEN_CLIENT_SECRET` |
| `intake-strands` | The intake agent on Strands | Token exchange only | `cases:write` | Yes | `IDENTITY_INTAKE_STRANDS_CLIENT_SECRET` |
| `expert` | The label expert | Token exchange only | `labels:search` | Yes | `IDENTITY_EXPERT_CLIENT_SECRET` |
| `orchestrator` | The orchestrator | Token exchange only | `agents:intake`, `agents:expert:delegated` | Yes | `IDENTITY_ORCHESTRATOR_CLIENT_SECRET` |
| `evaluation` | The evaluation runner | Client credentials, as its service account | `agents:expert` | No | `IDENTITY_EVALUATION_CLIENT_SECRET` |
| `knowledge-gate` | The knowledge gate | Client credentials, as its service account | `labels:search` | No | `IDENTITY_KNOWLEDGE_GATE_CLIENT_SECRET` |
| `contact-form` | The client's contact form | Client credentials, as its service account | `agents:orchestrator` | No | `IDENTITY_CONTACT_FORM_CLIENT_SECRET` |
| `lab-explorer` | The client's lab explorer | Client credentials, as its service account | `agents:intake`, `agents:expert`, `agents:orchestrator` | No | `IDENTITY_LAB_EXPLORER_CLIENT_SECRET` |
| `case-system` | The case system, named as an audience only | None | Nothing | No | None |
| `knowledge` | The retrieval service, named as an audience only | None | Nothing | No | None |

| Client `desk` | Value |
|---|---|
| Type | Confidential, client secret from the identity secrets |
| Grants | Authorization Code only. No password grant, implicit flow, service account, device grant, CIBA or token exchange |
| PKCE | Required, `S256` |
| Redirect URI | `http://localhost:3000/auth/callback` |
| Post-logout redirect URI | `http://localhost:3000/` |
| Default scopes | `basic`, `profile`, `email` |
| Optional scopes | `agents:intake`, `agents:expert`, `agents:orchestrator`, `cases:read`, `cases:review`, `traces:read` |
| Mappers | Hard-coded claim `client_id` = `desk` (access token); realm roles as top-level `roles` (access token and ID token) |

| Account | Name | Email | Realm roles | Password |
|---|---|---|---|---|
| `riley.reviewer` | Riley Reviewer | `riley.reviewer@example.org` | `safety-reviewer`, `default-roles-lab` | Their username, permanent |
| `dana.desk` | Dana Desk | `dana.desk@example.org` | `desk`, `default-roles-lab` | Their username, permanent |
| `morgan.medinfo` | Morgan Medinfo | `morgan.medinfo@example.org` | `medical-information`, `default-roles-lab` | Their username, permanent |
| `avery.auditor` | Avery Auditor | `avery.auditor@example.org` | `auditor`, `default-roles-lab` | Their username, permanent |
| `service-account-evaluation` | Evaluation Harness | — | `evaluation`, `default-roles-lab` | None: the `evaluation` client's secret |
| `service-account-knowledge-gate` | Knowledge Gate | — | `knowledge-gate`, `default-roles-lab` | None: the `knowledge-gate` client's secret |
| `service-account-contact-form` | Contact Form | — | `contact-form`, `default-roles-lab` | None: the `contact-form` client's secret |
| `service-account-lab-explorer` | Lab Explorer | — | `lab-explorer`, `default-roles-lab` | None: the `lab-explorer` client's secret |

Every account has a fixed id in the realm file, so its `sub` is the same after every start.

Access tokens live 600 seconds.

## The access token

A JWT signed with RS256 by a key at the realm's `jwks_uri`.

| Claim | Value | Read by AgentCore's JWT authorizer as |
|---|---|---|
| `iss` | `http://localhost:8090/realms/lab` | The issuer of the discovery URL |
| `aud` | Granted scopes' audiences only: both intake agents for `agents:intake`, `case-system` for case scopes, none for `traces:read`. Exchange selects one requested audience | Allowed audiences |
| `client_id` | Issued-to client: `desk` for staff, the exchanging agent, or the machine's own id (`evaluation`, `knowledge-gate`, `contact-form`, `lab-explorer`) | Allowed client IDs |
| `scope` | The scopes granted, separated by spaces. Keycloak adds others, such as `profile` and `email`, which no service reads | Allowed scopes (the token must hold at least one) |
| `roles` | Array of the account's realm role names, composites expanded: its one lab role, `default-roles-lab` and what that includes | A custom-claim rule (a string array contains a value) |
| `sub`, `preferred_username`, `name` | The account's id (fixed in the realm file), username and full name. A machine's username is `service-account-<client>` | — |
| `exp` − `iat` | 600. An exchanged token keeps the `exp` of the token it was exchanged for | — |

A person's token from sign-in carries no `realm_access` or `resource_access` claim (G2).

The grant type determines the token's contents. The gate associates each rule with a named statement:

| Request | Scopes granted | Audiences | Gate |
|---|---|---|---|
| Sign-in through `desk`, asking for `openid` and every scope `desk` may ask for | Exactly those the person's role grants | Those scopes' audiences | G1, G2 |
| Refresh with `scope=openid <one granted scope>` | That scope alone of the lab's scopes | That scope's audiences alone; none for `traces:read` | G3 |
| The same, with the refresh token that refresh returned | The whole grant again, or any other granted scope | As asked | G4 |
| Refresh for a scope `desk` may ask for that the role does not grant | Not that scope; answered 200 | None of that scope's | G5 |
| `desk` asking for a scope it may not ask for (`labels:search`, `agents:expert:delegated`) | Refused `invalid_scope`: 400 at a refresh; at the authorization endpoint, a redirect back that carries the error | — | G6 |
| An agent's exchange | Every scope asked for, and no other of the lab's scopes | The one audience asked for | G7, G8 |
| An agent's exchange asking for a scope its client may not ask for (`traces:read` among them, for all four agents' clients) | Refused 400 `invalid_scope` | — | G9 |
| The orchestrator's exchange of a caller's token for it (a person's, or the `contact-form` machine's), for a sub-agent | The sub-agent's scope alone of the lab's scopes | That sub-agent alone | G15 |
| A sub-agent's exchange of the token the orchestrator got for it | Every scope asked for, and no other of the lab's scopes | Its tool server alone | G16 |
| A machine's client credentials | The scope asked for; a scope its client may not ask for (`traces:read` among them) is refused 400 `invalid_scope` | That scope's audiences | G11, G12 |

Keycloak can answer 200 while omitting a scope the person's role does not grant (G5). Services therefore authorize the token's actual claims. A missing audience produces 401 `wrong_audience`; an accepted audience without a required scope produces 403 `insufficient_scope`. Asking for a scope unavailable to the OAuth client fails at the provider with `invalid_scope`.

## The ID token

The ID token uses the same signing method, issuer `http://localhost:8090/realms/lab`, audience `desk`, and top-level `roles`. It supplies the client's user identity through `sub`, `name`, `preferred_username` and `roles`. Permissions come separately from the scopes granted in the token response.

## Two addresses

The issuer stays fixed even though browsers and containers reach Keycloak through different addresses. Front-channel URLs must work in the browser; back-channel URLs must work on the container network.

```mermaid
sequenceDiagram
  participant B as Browser (this machine)
  participant K as identity
  participant S as Container on the lab's network
  S->>K: GET http://identity:8080/realms/lab/.well-known/openid-configuration
  K-->>S: issuer localhost:8090, token_endpoint and jwks_uri on identity:8080, authorization_endpoint on localhost:8090
  B->>K: GET http://localhost:8090/realms/lab/protocol/openid-connect/auth
  K-->>B: sign-in page, form posts to localhost:8090
  B->>K: POST sign-in form
  K-->>B: 302 to http://localhost:3000/auth/callback?code=...
  S->>K: POST http://identity:8080/.../token (code, verifier, client secret)
  K-->>S: access token, iss http://localhost:8090/realms/lab
```

| Party | Address | Uses |
|---|---|---|
| Browser | `http://localhost:8090` | Authorization endpoint, sign-in form, sign-out |
| Container on the lab's network: the client, the agents, the case system, the retrieval service, the knowledge gate, the evaluation runner | `http://identity:8080` | Discovery, token endpoint, `jwks_uri`, revocation (the client) |
| Container on the lab's network standing in for a browser: the gate, the stack gate and the attack runner | `http://identity:8080` | As above, and the sign-in page and form: each sends a URL it is given on `http://localhost:8090` to `http://identity:8080` with the same path and query |

| Discovery field, fetched at `http://identity:8080` | Address given |
|---|---|
| `issuer`, `authorization_endpoint`, `end_session_endpoint` | `http://localhost:8090`, the browser's |
| `token_endpoint`, `jwks_uri`, `userinfo_endpoint`, `introspection_endpoint` | `http://identity:8080` |
| `revocation_endpoint` | `http://localhost:8090`, the browser's, which a container cannot reach. The client does not read it: it is configured with `OIDC_REVOCATION_ENDPOINT` = `http://identity:8080/realms/lab/protocol/openid-connect/revoke` |

| Setting | Effect |
|---|---|
| `KC_HOSTNAME=http://localhost:8090` | Issuer and every front-channel URL, whatever address the request came in on |
| `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` | Back-channel URLs use the address the request came in on |

## Signing in through the client

```mermaid
sequenceDiagram
  participant B as Browser
  participant C as client (localhost:3000)
  participant K as identity
  B->>C: GET /auth/login
  C->>K: GET http://identity:8080/.../.well-known/openid-configuration (first need only#59; issuer must equal OIDC_ISSUER)
  C->>C: pending sign-in: state, nonce, PKCE verifier, browser binding (256 bits each)
  C-->>B: 302 to authorization_endpoint (localhost:8090) with scope openid, the agents' scopes, cases:read, cases:review and traces:read, state, nonce, S256 challenge#59; Set-Cookie desk_signin (binding, Path=/auth, 10 minutes)
  B->>K: sign in
  K-->>B: 302 to http://localhost:3000/auth/callback?code, state, iss
  B->>C: GET /auth/callback, with desk_signin
  C->>C: take the pending sign-in for state (unused, under 10 minutes, binding equals the cookie)#59; clear desk_signin
  C->>K: POST token_endpoint (code, verifier, client secret)
  K-->>C: access, refresh and ID tokens#59; scope: what the person's role grants
  C->>K: GET jwks_uri
  C->>C: ID token: signature, issuer, audience desk, nonce, expiry#59; session created, with the scopes granted
  C-->>B: 302 to /, Set-Cookie desk_session (HttpOnly, SameSite=Lax, Path=/)
```

The client asks for `openid`, the scope of each agent it is configured with, `cases:read`, `cases:review` and `traces:read`. It keeps the scopes the token response grants on the session. A scope left out because the person's role does not grant it is normal, not a failure.

| Step | Refused when | Answer |
|---|---|---|
| Callback | State unknown, used, or 10 minutes old; no `desk_signin` cookie, or another sign-in's; the provider sent `error` | 400 page, no session; the pending sign-in is used up |
| Code exchange, ID token | Code refused; invalid signature, issuer, audience or nonce; invalid `exp`, `iat` or `nbf` with 30 s leeway; missing `sub`, `name` or `preferred_username`; `roles` not a list of names | 502 page, no session |
| Code exchange | The provider cannot be reached | 502 page `identity_unreachable`, no session |
| Discovery | Unreachable within 10 s; not JSON; `issuer` is not `OIDC_ISSUER`; no `authorization_endpoint`, `token_endpoint` or `jwks_uri` | 502 page `identity_unreachable`; no sign-in is left pending |

Each request the client makes to the provider waits at most 10 s. The discovery document is kept for the life of the process once fetched.

### Sessions and where tokens live

| Held | Where | For how long |
|---|---|---|
| Latest refresh token, access tokens cached by target scope, sign-in grant, user subject, name, username and roles. Sign-in access and ID tokens are discarded | Client session memory | Until sign-out, a failed refresh, or client shutdown |
| Pending sign-ins (state, nonce, verifier, binding) | The client's memory | Until their callback, 10 minutes, or 1000 newer ones |
| A pending sign-in's binding | The browser that started it, in the `desk_signin` cookie | Until the callback clears it, or 10 minutes |
| Session identifier | The browser, in the `desk_session` cookie | Until sign-out clears it |
| Who entered an inquiry and started a run: subject and name | The client's SQLite file | With the inquiry |

No token is written to disk or to the store, and no response carries a token, in its body or in any header.

### Signing out

| Step | What happens |
|---|---|
| `POST /auth/logout` | With no session, 401 `not_signed_in`. Otherwise the session is removed and `desk_session` cleared |
| Revocation | The refresh token is revoked (RFC 7009) at the configured `OIDC_REVOCATION_ENDPOINT`, authenticating as `desk`; with `none`, no call. A refusal or no answer is logged (`revoking the refresh token at the identity provider failed`); sign-out goes on |
| Answer | 200 with `sign_out_url`: the provider's `end_session_endpoint` with `client_id` and `post_logout_redirect_uri`, and no token. 502 `identity_unreachable` if the discovery document cannot be had |

### What a session may do

| Granted scope | The session may |
|---|---|
| An agent's scope (`agents:intake`, `agents:expert`, `agents:orchestrator`) | Run that agent: enter an inquiry for it, or start a run of one |
| `cases:read` | Read cases |
| `cases:review` | Decide a case |
| `traces:read` | Read every person's runs with their steps, on the trace routes. The client checks this grant itself: the scope names no audience, and no token carrying it is sent anywhere |

What may be done is read from the scopes granted at sign-in, which the client keeps on the session. A token response without `scope` is taken as granting nothing.

| Route | Answers |
|---|---|
| `GET /api/session` | `{ user: { name, username, roles }, may: { agents, read_cases, decide_cases, read_traces } }`: the ids of the agents whose scope was granted, and whether `cases:read`, `cases:review` and `traces:read` were. No token |
| `GET /api/agents` | `{ agents: [{ id, name, description }] }`, only the agents whose scope was granted |
| A call for anything the session may not do | 403 `not_allowed`, before the provider or the target is asked. An agent id that is not configured is 400 `unknown_agent` |
| `GET /api/inquiries` | Every inquiry of the desk, to a session that may run an agent; what the lab explorer entered is left out |
| Reading an inquiry and its runs | Any session allowed to run an agent or read cases. An inquiry the lab explorer entered is answered as an unknown one, and the runs the lab explorer started are left out. Other sessions receive 404 `inquiry_not_found`, indistinguishable from an absent inquiry |
| Starting a run on an inquiry | Requires that agent's scope, whichever person or the contact form entered the inquiry. Read access without run permission returns 403 `not_allowed`; no read access returns 404 `inquiry_not_found`, and so does an inquiry the lab explorer entered |
| `GET /api/traces`, `GET /api/traces/<run_id>` | Every person's runs, with their steps, to a session granted `traces:read`; 403 `not_allowed` to any other, before the store is read. Other desk `/api` routes omit steps |

The local lab explorer is a separate diagnostic surface. Its `/lab/api` routes read no session cookie: they expose every stored run and its steps, read inquiries, and invoke any agent as `lab-explorer`. The desk's `traces:read` restriction therefore protects the desk routes, not all access to stored traces. Downstream agents still require the explorer's machine token.

### What the client sends downstream

The client caches access tokens by scope. Before each call it checks the remaining lifetime against the target's wait limit; if necessary, it refreshes with `scope=openid <that scope>` and replaces that scope's cached token. The sign-in access token is never forwarded.

| Call | `Authorization` | Token must have left |
|---|---|---|
| Agent `POST /invocations` (a new inquiry, or a new run of one) | `Bearer <token for that agent's scope>`: `agents:intake` for an intake agent, `agents:expert` for the label expert, `agents:orchestrator` for the orchestrator | The time the client waits for that agent (its `wait_seconds` in `client/compose.yaml`): 180 s, and 295 s for the orchestrator |
| Case system: list, get | `Bearer <token for cases:read>` | 30 s |
| Case system: review | `Bearer <token for cases:review>` | 30 s |
| Health checks (`/ping`; the search engine's `/_cluster/health`; the model servers' `/health`) | None | — |

| Refresh | What happens |
|---|---|
| Order | Refreshes of one session run one at a time, in the order asked. Each uses the newest refresh token the provider has returned, which replaces the session's |
| Two calls for the same scope at once | Share one refresh |
| Calls for different scopes | Each gets its own token, never another scope's |
| The provider refuses, or cannot be reached; the session has no refresh token; or the new token lives less than the call needs | The session is removed, the request answers 401 `not_signed_in`, and nothing is sent |
| The provider answers without the scope asked for, or with no `scope` at all | 403 `not_allowed`; the session stays, and keeps the refresh token that answer returned |

A review is forwarded as `{ decision, note? }`, with no reviewer field; the case system takes the reviewer from the token.

## The agents

Every agent checks the token it is called with using `shared/access-token.ts`, then exchanges it for a token for what it calls: its tool server, or, for the orchestrator, each sub-agent. Where the check is made ([agent-runtime.md](agent-runtime.md)):

| Agent | Checked by | Before the body is read | A refusal |
|---|---|---|---|
| Intake agent, hand-written | `agents/src/contract/server.ts` | Yes | 401, 403 or 503, below |
| Intake agent on Strands, label expert, orchestrator | The local edge, `agents/src/contract/edge.ts` | Yes | 401, 403 or 503, below |
| The same three, again, for the caller | `agents/src/contract/sdk-app.ts`, after AWS's SDK has read the body | No | 200 with `outcome: failed` and a reason saying the token was not valid or could not be checked. Reached only with the edge off |

| Agent | `AUTH_ALLOWED_AUDIENCE` | `AUTH_ALLOWED_CLIENTS` | `AUTH_REQUIRED_SCOPES` |
|---|---|---|---|
| Intake agent, hand-written | `intake-handwritten` | `desk`, `lab-explorer` | `agents:intake` |
| Intake agent on Strands | `intake-strands` | `desk`, `orchestrator`, `lab-explorer` | `agents:intake` |
| Label expert | `expert` | `desk`, `evaluation`, `orchestrator`, `lab-explorer` | `agents:expert`, `agents:expert:delegated` |
| Orchestrator | `orchestrator` | `desk`, `contact-form`, `lab-explorer` | `agents:orchestrator` |

A token needs an allowed client and at least one accepted scope. The realm controls which combinations can be issued: only `orchestrator` may request `agents:expert:delegated` (G6 for `desk`, G9 for other agents), while `agents:expert` is absent from the orchestrator's optional scopes. The `desk` client cannot request delegated access and the `desk` role lacks direct expert access. Desk staff therefore reach the expert through the orchestrator.

| Order | Check | Refused as |
|---|---|---|
| 1 | `Authorization: Bearer` present | `missing` |
| 2 | A JWT, header algorithm RS256 | `malformed`; any other algorithm, `none` included, `bad_signature` |
| 3 | Signature against the keys at `jwks_uri` | `bad_signature` |
| 4 | Not past `exp`, on the agent's clock, no tolerance | `expired` |
| 5 | `iss` = `http://localhost:8090/realms/lab` | `wrong_issuer` |
| 6 | `aud` contains the agent's own id | `wrong_audience` |
| 7 | `client_id` in the agent's allowed clients | `wrong_client` |
| 8 | `scope` holds one of the agent's scopes | `insufficient_scope` |
| 9 | At least the run's time limit before `exp`: 150 s, and 280 s for the orchestrator | `expires_too_soon` |
| 10 | `sub`, `preferred_username`, `name` present; `roles` a list if present | `malformed` |

| Answer | When |
|---|---|
| 401, `WWW-Authenticate: Bearer error="invalid_token"`, `{"error":"unauthorized","reason","detail"}` | A refusal above other than `insufficient_scope`. The handler is not called |
| 403, `WWW-Authenticate: Bearer error="insufficient_scope", scope="<the agent's scopes, separated by spaces>"`, `{"error":"forbidden","reason":"insufficient_scope","detail"}` | A token with none of the agent's scopes. The handler is not called |
| 503 `identity_unavailable` | Discovery or keys cannot be fetched, discovery names another issuer, or the key set holds an RSA key that is not a valid RS256 public key. The handler is not called |
| The handler runs, given the caller | An accepted token |

The agent caches discovery and keys after successful fetches; failed fetches are not cached. Provider requests have a 5 s limit. An unknown signing key triggers a key refresh once at least 30 s has elapsed since the previous fetch. This allows new provider keys to be accepted without restarting the agent, but a provider restart does not immediately invalidate cached old keys. `GET /ping` needs no token.

### The exchange

Before connecting to its tool server, an agent exchanges the caller's token through `agents/src/tools/tool-token.ts` and `shared/token-exchange.ts`. It authenticates with `AGENT_ID` and `EXCHANGE_CLIENT_SECRET` at `EXCHANGE_TOKEN_ENDPOINT`, once per run, within the 10 s tool limit or the remaining run time. The caller's token goes only to the token endpoint. The tool server receives only the exchanged token.

The orchestrator uses the same exchange code once per sub-agent call, authenticating as `orchestrator`. Exchange and invocation share a 155 s limit, capped by the remaining run time. The sub-agent checks the exchanged token and exchanges it again for its own tool server ([orchestrator.md](orchestrator.md)).

| Agent | Asks for | Sends the exchanged token to | How |
|---|---|---|---|
| Both intake agents | Audience `case-system`, scope `cases:write` alone | The case system's MCP endpoint | `Authorization: Bearer` on every request (connect, tool list, every tool call), beside the three context headers |
| The label expert | Audience `knowledge`, scope `labels:search` | The retrieval service's MCP endpoint | `Authorization: Bearer` on every request (connect, tool list, every tool call), and no other header of the caller's |
| The orchestrator | Audience `intake-strands`, scope `agents:intake`, to screen the message; audience `expert`, scope `agents:expert:delegated`, for each label question | The intake agent on Strands, or the label expert: `POST /invocations` | `Authorization: Bearer`, with the agent contract's request |

The exchanged token preserves the caller while naming the agent that now acts for it. These claims are covered by G7 and G8, G15 for the orchestrator, and G16 for its sub-agents:

| Claim | Exchange result |
|---|---|
| `aud` | The one audience requested |
| `client_id`, `azp` | The exchanging agent |
| `sub`, `preferred_username`, `name`, `roles` | Unchanged from the caller's token |
| `scope` | Every requested scope, and no other lab scope |
| `exp` | Unchanged from the caller's token; no refresh token is returned |

Only the four agents can exchange. The provider refuses a token that does not name the exchanging agent in its audience with 403 `Client is not within the token audience` (G9). A scope unavailable to that agent's client produces 400 `invalid_scope` (G9). This prevents intake agents from requesting `labels:search`, `agents:expert:delegated` or `cases:lookup`; the expert from requesting `cases:write` or `agents:expert:delegated`; the orchestrator from requesting `labels:search` or `agents:expert`; and every agent from requesting `traces:read`. The `desk`, audience-only and four machine clients cannot exchange (G10).

| Result | The run | Reason given |
|---|---|---|
| The exchange is refused: a 4xx from the provider, a scope asked for left out, or an answer that is not a bearer token | Ends `failed`; nothing is connected | "The agent could not get a token for the case system: " (or "for the retrieval service: ") and the exchange's detail, which holds no token or secret |
| The exchange cannot be made: no answer in time, the provider not reached, a 5xx, a body that is not JSON | Ends `failed`; nothing is connected | "The agent could not get a token for the case system: the identity provider could not be reached or did not answer in time." (or the retrieval service) |
| The tool server refuses the exchanged token at connection (401, or 403 for a missing scope) | Ends `failed` | "The case system refused the agent's token." or "The retrieval service refused the agent's token." |
| The tool server cannot check it (503) | Ends `failed` | "The case system could not check the agent's token." or "The retrieval service could not check the agent's token." |
| The tool server answers anything else, or not at all | Ends `failed` | "The case system could not be reached." or "The retrieval service could not be reached." |

An exchange is not retried.

For the orchestrator, an exchange that is refused or cannot be made is the failure of that one call, not of the run: the call's `delegation` step holds the reason, "The agent could not get a token for the intake agent: " (or "for the label expert: ") and the exchange's detail, or the same fixed sentence when the provider could not be reached. How the run then ends is in [orchestrator.md](orchestrator.md), "How it ends".

| AgentCore Runtime JWT authorizer setting | The agent's setting | Value in the lab |
|---|---|---|
| Discovery URL (ends `/.well-known/openid-configuration`) | `AUTH_DISCOVERY_URL` | `http://identity:8080/realms/lab/.well-known/openid-configuration` |
| Issuer (from the discovery document) | `AUTH_ISSUER`, compared exactly | `http://localhost:8090/realms/lab` |
| Allowed audiences | `AUTH_ALLOWED_AUDIENCE` | The agent's own id: `intake-handwritten`, `intake-strands`, `expert`, `orchestrator` |
| Allowed clients (the `client_id` claim) | `AUTH_ALLOWED_CLIENTS`, separated by commas | `desk,lab-explorer` for the hand-written intake agent; `desk,orchestrator,lab-explorer` for the intake agent on Strands; `desk,evaluation,orchestrator,lab-explorer` for the label expert; `desk,contact-form,lab-explorer` for the orchestrator |
| Allowed scopes | `AUTH_REQUIRED_SCOPES`, separated by commas | `agents:intake`; for the label expert, `agents:expert,agents:expert:delegated`; for the orchestrator, `agents:orchestrator` |
| Custom-claim rule (optional) | `AUTH_ROLES_CLAIM` names the claim; no rule is applied | `roles` |
| — | Minimum remaining life | 150 s; 280 s for the orchestrator |

## The case system

The case system separates agent writes from staff review with two servers. Both use `shared/access-token.ts` in the agents' check order, with audience `case-system`, no minimum remaining lifetime, the same provider timeout and key-refresh interval, and their own allowed clients and scopes. All routes except `GET /ping`, including unknown routes, require authentication before reaching MCP or the store.

Invalid tokens return 401 with `WWW-Authenticate: Bearer error="invalid_token"`. Missing scopes return 403 `insufficient_scope` naming the scopes; unavailable identity checks return 503 `identity_unavailable`.

| Server | Allowed clients | The token must hold one of | Then |
|---|---|---|---|
| Agents' server, port 8000, `POST /mcp` | `intake-handwritten`, `intake-strands` | `cases:write`, `cases:lookup` | `create_case` and `add_follow_up` require `cases:write`; `find_case` requires `cases:lookup`. No role or client can obtain lookup scope, so that tool is never offered. Calls to unoffered tools receive MCP's unknown-tool error and change nothing |
| Review server, port 8001 | `desk` | `cases:read`, `cases:review` | `GET /cases` and `GET /cases/<id>` need `cases:read`; `POST /cases/<id>/review` needs `cases:review`, checked before the case is looked up or the body read (403 `insufficient_scope` naming it) |

| Server | Route | Takes from the token |
|---|---|---|
| Agents' server | `POST /mcp` | The agent: the token's `client_id`, recorded as the actor of every audit entry of its change. The user it acted for: `name` and `sub`, recorded beside it as `acting_for` |
| Review server | `GET /cases`, `GET /cases/<id>` | — |
| Review server | `POST /cases/<id>/review` | The reviewer: `name` as the audit actor, `sub` as `actor_subject`. A body naming a `reviewer` is 400 |
| Both | `GET /ping` | Nothing |

See [tools/case-system/README.md](../../tools/case-system/README.md).

## The retrieval service

The retrieval service (`knowledge/src/search/`) uses `shared/access-token.ts` before reading the request target or body. It requires audience `knowledge`, client `expert` or `knowledge-gate`, and scope `labels:search`, which covers both `find_labels` and `search_label`. Check order, provider timeout and key refresh match the case system; no minimum lifetime is required beyond an unexpired token.

Every route except `GET /ping`, including unknown routes, requires the token. Refusals return 401 or 403; unavailable identity checks return 503 `identity_unavailable`. The bearer token stops here. Embedding and reranking use the model server's key instead. See [knowledge.md](knowledge.md).

| Route | Needs | Takes from the token |
|---|---|---|
| `POST /mcp` | A valid token | Nothing: the tools search a public corpus and record nothing about the caller |
| `GET /ping` | Nothing | — |

## Signing in without a browser

These callers run on the stack's default network (`<compose-project>_default`) and reach Keycloak at `http://identity:8080`. Compose supplies only their named credentials. None prints passwords, secrets, codes or tokens. Person-level credentials belong only to the identity gate, stack gate and attack runner. The knowledge gate and evaluation runner each hold one machine secret; the client holds `desk`, `contact-form` and `lab-explorer` secrets.

| Party | Started by | As | How | Secrets given | What it does with it |
|---|---|---|---|---|---|
| Gate | `platform/identity/gate.sh` | Four people, four agents, four machines | PKCE through `desk`, completing the form and exchanging the redirect's code itself; refresh, direct and chained exchanges, client credentials | Every client secret and four passwords | Checks token signatures and claims, including required refusals |
| Stack gate | `platform/identity/stack-gate.sh` | Four people; own tokens as `intake-handwritten`, `expert`, `orchestrator`, `evaluation`, `knowledge-gate` | Client login and callback with cookies; direct `desk` login for its own tokens; four exchanges (one intake, one expert, two orchestrator); client credentials | Four passwords; secrets for `desk` and those five clients | Exercises the desk, reads runs as their person and traces as `avery.auditor`, and presents missing and issued tokens to agents and tool servers |
| Knowledge gate | `knowledge/gate.sh` | Client `knowledge-gate` | Client credentials with its own secret, scope `labels:search` (`shared/machine-token.ts`) | `IDENTITY_KNOWLEDGE_GATE_CLIENT_SECRET` | Calls the retrieval service's MCP endpoint with the token. A token that cannot be got is exit 2 |
| Evaluation runner | `evaluation/run.sh` | Client `evaluation` | Client credentials with its own secret, scope `agents:expert` (`shared/machine-token.ts`). Gets a new token before the current one has under 200 s left | `IDENTITY_EVALUATION_CLIENT_SECRET` | Sends it to the label expert on `POST /invocations`; the expert exchanges it for its own token for the retrieval service. A question for which no token could be got is recorded with the reason `no access token could be got` |
| Contact form | The client's server (`client/`) | Client `contact-form` | Client credentials with its own secret, scope `agents:orchestrator` (`shared/machine-token.ts`) | `IDENTITY_CONTACT_FORM_CLIENT_SECRET`, as `CONTACT_FORM_CLIENT_SECRET` | Sends a message a clinician wrote on the public contact page to the orchestrator on `POST /invocations`; the orchestrator exchanges it for each sub-agent, with the contact form's service account as the subject |
| Lab explorer | The client's server (`client/`) | Client `lab-explorer` | Client credentials with its own secret, scope `agents:intake`, `agents:expert` or `agents:orchestrator`, the scope of the agent it calls (`shared/machine-token.ts`) | `IDENTITY_LAB_EXPLORER_CLIENT_SECRET`, as `LAB_EXPLORER_CLIENT_SECRET` | Sends a prepared, newly entered or stored message to any of the four agents on `POST /invocations` |
| Attack runner | `evaluation/attacks.sh` | The four people | Through the client, as the stack gate does (`platform/identity/src/desk.ts`): `/auth/login`, Keycloak's form, the client's callback; the client exchanges the code and the runner holds only cookies. A person whose session ends (401) signs in again once | The four passwords, and no client secret | Sends each attack, control and fault case's inquiry as its person, reads each ended run's trace as `avery.auditor`, and reads cases as `riley.reviewer` |

## From sign-in to an audit entry

The two paths below differ in delegation depth. Direct agent calls need one exchange; orchestrated calls need an exchange at each agent boundary. The contact form follows the orchestrator path and the lab explorer can follow either. For those machine callers, client credentials replace sign-in and refresh, and every exchange preserves the machine service account as the subject.

### Client to agent to tool server

```mermaid
sequenceDiagram
  participant B as Browser
  participant C as client
  participant K as identity
  participant A as Agent
  participant S as Case system
  participant R as Retrieval service
  B->>C: sign in (Authorization Code with PKCE, see above)
  C->>K: code, verifier, client secret
  K-->>C: access, refresh and ID tokens#59; scope: what the role grants
  C-->>B: session cookie
  B->>C: POST /api/inquiries (cookie)
  C->>C: session#59; the agent's scope granted, or 403#59; record who entered it
  C->>K: refresh, scope=openid and the agent's scope (unless a token for it has 180 s left, the wait for that agent)
  K-->>C: token: aud the agents of that scope#59; client_id desk
  C->>A: POST /invocations, Bearer that token
  A->>K: discovery and keys (first need only)
  A->>A: check token: RS256 signature, iss, aud its own id, client_id, its scope, 150 s left
  A->>K: token exchange, as the agent with its own secret
  K-->>A: token: aud case-system or knowledge alone#59; client_id and azp the agent#59; the person's sub and name
  alt an intake agent
    A->>S: MCP initialize, tools/list, tools/call, Bearer exchanged token and the three context headers
    S->>S: check token: RS256 signature, iss, aud case-system, client_id an intake agent, cases:write or cases:lookup#59; tools by scope
    S->>S: write the case#59; audit entry: actor = token's client_id, acting_for = token's name and sub
    S-->>A: result
  else the label expert
    A->>R: MCP initialize, tools/list, tools/call, Bearer exchanged token
    R->>R: check token: RS256 signature, iss, aud knowledge, client_id, labels:search
    R-->>A: passages#59; nothing recorded about the caller
  end
  A-->>C: response inside the agent contract
  B->>C: POST /api/cases/<id>/review (cookie)
  C->>C: cases:review granted, or 403 not_allowed
  C->>K: refresh, scope=openid cases:review (unless a token for it has 30 s left)
  K-->>C: token: aud case-system#59; client_id desk
  C->>S: POST /cases/<id>/review { decision, note? }, Bearer that token
  S->>S: check token#59; cases:review, or 403#59; audit entry: actor = token's name, actor_subject = sub
```

| Step | Who | What it holds or checks |
|---|---|---|
| 1. Sign-in | The client, with the provider | Access, refresh and ID tokens; the scopes the person's role grants. The ID token is checked; the client keeps the refresh token and the scopes, and neither keeps nor sends the access token |
| 2. Refresh for a target | The client, with the provider | Only for a scope granted at sign-in; any other call is 403 `not_allowed` before the provider is asked. A token for one scope: that scope's audiences, `client_id` `desk`. A response without that scope is 403 `not_allowed` too |
| 3. The agent's check | The agent | Its own id in `aud`, an allowed client, its scope, 150 s left |
| 4. The exchange | The agent, with the provider | As the agent: a token for the tool server's audience alone, the agent as `client_id`, the person's identity |
| 5. The tool server's check | The case system or the retrieval service | Its audience, one of its own callers as `client_id`, one of its scopes; then the tool's or route's own scope |
| 6. The audit entry | The case system | The agent from the token's `client_id`; the person from its `name` and `sub`. A reviewer's decision: the reviewer from a token the client got for `cases:review` |

### Client to orchestrator to sub-agent to tool server

Screening by the intake agent on Strands and the label questions put to the label expert run at the same time ([orchestrator.md](orchestrator.md)). Each call to a sub-agent is recorded in the orchestrator's response as a `delegation` step, a step kind of `shared/agent-contract.ts`, with the sub-agent's whole response or the reason there is none.

```mermaid
sequenceDiagram
  participant B as Browser
  participant C as client
  participant K as identity
  participant O as Orchestrator
  participant I as Intake agent on Strands
  participant E as Label expert
  participant S as Case system
  participant R as Retrieval service
  B->>C: POST /api/inquiries for the orchestrator (cookie)
  C->>C: session#59; agents:orchestrator granted, or 403#59; record who entered it
  C->>K: refresh, scope=openid agents:orchestrator (unless a token for it has 295 s left)
  K-->>C: token: aud orchestrator#59; client_id desk
  C->>O: POST /invocations, Bearer that token
  O->>O: check token: RS256 signature, iss, aud orchestrator, client_id desk, agents:orchestrator, 280 s left
  par screening, every message
    O->>K: token exchange, as orchestrator: audience intake-strands, scope agents:intake
    K-->>O: token: aud intake-strands alone#59; client_id and azp orchestrator#59; the person's sub and name
    O->>I: POST /invocations, the message, Bearer that token
    I->>I: check token: aud intake-strands, client_id orchestrator, agents:intake, 150 s left
    I->>K: token exchange, as intake-strands: audience case-system
    K-->>I: token: aud case-system alone#59; client_id and azp intake-strands#59; the person's sub and name
    I->>S: MCP initialize, tools/list, tools/call, Bearer that token and the three context headers
    S->>S: write the case#59; audit entry: actor = intake-strands, acting_for = the person's name and sub
    I-->>O: response inside the agent contract
  and each label question put
    O->>K: token exchange, as orchestrator: audience expert, scope agents:expert:delegated
    K-->>O: token: aud expert alone#59; client_id and azp orchestrator#59; the person's sub and name
    O->>E: POST /invocations, one question, Bearer that token
    E->>E: check token: aud expert, client_id orchestrator, agents:expert:delegated, 150 s left
    E->>K: token exchange, as expert: audience knowledge, scope labels:search
    K-->>E: token: aud knowledge alone#59; client_id and azp expert#59; the person's sub and name
    E->>R: MCP initialize, tools/list, tools/call, Bearer that token
    R-->>E: passages#59; nothing recorded about the caller
    E-->>O: response inside the agent contract
  end
  O-->>C: response, with a delegation step for each call to a sub-agent
```

| Step | Who | What it holds or checks |
|---|---|---|
| 1. Sign-in | The client, with the provider | As on the first path |
| 2. Refresh for the orchestrator | The client, with the provider | Only if `agents:orchestrator` was granted at sign-in. A token for that scope: audience `orchestrator`, `client_id` `desk`, with 295 s left, the time the client waits for the orchestrator |
| 3. The orchestrator's check | The orchestrator | Its own id in `aud`, an allowed client (`desk`, `contact-form` or `lab-explorer`), `agents:orchestrator`, 280 s left |
| 4. The first exchange | The orchestrator, with the provider, once for each call to a sub-agent | As `orchestrator`: a token for the sub-agent's audience alone with the sub-agent's scope, `orchestrator` as `client_id` and `azp`, the caller's identity, the caller's `exp` (G15) |
| 5. The sub-agent's check | The intake agent on Strands, or the label expert | Its own id in `aud`, client `orchestrator` among its allowed clients, `agents:intake` or `agents:expert:delegated`, 150 s left |
| 6. The second exchange | The sub-agent, with the provider | As on the first path: a token for its tool server's audience alone, the sub-agent as `client_id`, the caller's identity (G16) |
| 7. The tool server's check and the audit entry | The case system or the retrieval service | As on the first path. The case system records `intake-strands` as the actor and the caller as `acting_for`: the person, or the machine's service account. The orchestrator is in no claim the case system reads, and in no audit entry |

### Who checks what

| Checker | What it receives | Audience required | Allowed clients | Scope required | Other checks | What it takes from the token |
|---|---|---|---|---|---|---|
| Client | The ID token, from the token endpoint at sign-in | `desk` (the ID token's `aud`) | — | — | Signature, issuer, nonce, expiry (30 s leeway); the browser that started the sign-in | Who the user is. What they may do comes from the scopes in the token response |
| Intake agent or label expert | A token for its scope: from the client, a person's or the lab explorer's own; for the label expert, also from the evaluation runner (`evaluation`'s own); for the intake agent on Strands and the label expert, also from the orchestrator, which got it by exchange | Its own id | `desk`, `lab-explorer`; for the intake agent on Strands, also `orchestrator`; for the label expert, also `evaluation` and `orchestrator` | `agents:intake`; for the label expert, `agents:expert` or `agents:expert:delegated` | Signature (RS256), issuer, 150 s left | The caller, given to the handler; the token itself, exchanged |
| Orchestrator | A token for `agents:orchestrator`, from the client: a person's, or the contact form's or lab explorer's own | `orchestrator` | `desk`, `contact-form`, `lab-explorer` | `agents:orchestrator` | Signature (RS256), issuer, 280 s left | The caller, given to the handler; the token itself, exchanged once for each call to a sub-agent |
| Case system, agents' server | The token an intake agent got by exchange | `case-system` | `intake-handwritten`, `intake-strands` | `cases:write` or `cases:lookup`; then each tool's own | Signature (RS256), issuer, not expired | The agent and the user it acted for |
| Case system, review server | A person's token, from the client | `case-system` | `desk` | `cases:read` or `cases:review`; then each route's own | Signature (RS256), issuer, not expired | The reviewer |
| Retrieval service | The label expert's exchanged token; the knowledge gate's own | `knowledge` | `expert`, `knowledge-gate` | `labels:search` | Signature (RS256), issuer, not expired | Nothing |

## Where secrets live

| Secret | Written by | Held in | Read by |
|---|---|---|---|
| Administrator username and password | `setup.sh`, random | Identity secrets | The provider, at start |
| `desk` client secret | `setup.sh`, random | Identity secrets | The provider, through the realm import; the gate; the stack gate; the client, as `OIDC_CLIENT_SECRET` |
| The four agents' client secrets | `setup.sh`, random | Identity secrets | The provider, through the realm import; each agent its own, as `EXCHANGE_CLIENT_SECRET`; the gate (all four); the stack gate (`intake-handwritten`'s, `expert`'s and `orchestrator`'s) |
| The four machines' client secrets | `setup.sh`, random | Identity secrets | The provider, through the realm import; the evaluation runner (`evaluation`'s only), the knowledge gate (`knowledge-gate`'s only), and the client (`contact-form`'s as `CONTACT_FORM_CLIENT_SECRET` and `lab-explorer`'s as `LAB_EXPLORER_CLIENT_SECRET`, with `desk`'s, and no other value from the identity secrets); the gate (all four); the stack gate (`evaluation`'s and `knowledge-gate`'s) |
| The four people's passwords | `setup.sh`, each the person's username: the people are synthetic, the lab is local, and the passwords are typed by hand | Identity secrets | The provider, through the realm import; the gate, the stack gate and the attack runner (all four). No other program |
| Token signing keys | The provider, at start | The provider's database, on a tmpfs | Nobody outside; the public keys are at `jwks_uri` |

The realm file holds a `${NAME}` placeholder where each secret and password goes, and no secret.

## How it fails

| Failure | Result |
|---|---|
| `platform/identity/.env` missing | `docker compose up` stops before starting anything and names the missing variable |
| `setup.sh` without Docker | Exits 2 and says so |
| `platform/identity/.env` lacks a variable `setup.sh` knows | `setup.sh` adds it with a new value (a person's password: their username) and keeps every other value |
| `platform/identity/.env` holds a person's password other than their username | `setup.sh` sets that line to the username, in place |
| `.env.example` names a variable `setup.sh` cannot make a value for | `setup.sh` exits 1, names it, and changes nothing |
| The realm does not import | The service never becomes healthy; `docker compose up --wait` fails |
| The realm file was edited and the provider not restarted | The provider keeps serving the realm it imported at start |
| The provider restarted | New signing keys replace the published set. Old tokens fail with `bad_signature` once a service uses that set; cached old keys can still verify them until expiry or key replacement. Client sessions end at their next refresh |
| A token without the service's audience, or from a client the service does not accept | 401 `wrong_audience` or `wrong_client` |
| A token with the service's audience but none of its scopes, or without a route's own scope | 403 `insufficient_scope`, naming the scopes |
| A person asks the client for something their role does not grant | 403 `not_allowed`, before the provider is asked. A refresh answered without the scope asked for is also 403 `not_allowed`; the session stays |
| The client's refresh refused, the provider not reached, or a new token too short for the call | The session ends; 401 `not_signed_in` |
| An agent's exchange refused, or the provider not reached | The run ends `failed` with the reason; nothing is connected; not retried. For the orchestrator, that one call fails, with the reason in its `delegation` step; not retried |
| A machine cannot get a token | The knowledge gate exits 2; the evaluation runner records the question with the reason `no access token could be got` |
| The provider does not answer on a running project's network, or a statement on this page about its realm or tokens does not hold | The gate exits 1 and names the first statement that does not hold |
| The gate cannot run: no `platform/identity/.env`, no network for the project, or no report | The gate exits 2 and says why on standard error |

## Not present

| What | Note |
|---|---|
| Authentication on the lab explorer | `/lab/api` exposes stored runs, steps and inquiries without sign-in, and invokes agents as `lab-explorer`. This local diagnostic surface is outside the desk's session permissions |
| Proof of who sent a message | The sender is text that the signed-in user vouches for. Lookups and follow-ups are limited by that text |
| Full delegation chain in tokens | `client_id` and `azp` identify only the exchanging agent. The case system receives `intake-strands` through the orchestrator and records that intake agent as actor; no claim it reads identifies the orchestrator |
| A token limited to one run or message | Exchange restricts client, audience and scopes, but preserves expiry. Until then, the token can serve any run by that agent for that subject |
| Special handling of a token refused mid-run | A tool call the case system refuses after it accepted the connection falls under the agents' rules for a call that got no answer |
| Use of the caller's roles by the agents | The roles are read and given to the handler; nothing is decided on them |
| Rules on data | No rule limits reading to a person's own cases: a token with `cases:read` lists and reads every case on the review server. No four-eyes rule: one person with `cases:review` decides a case alone |
| Refresh-token rotation | The realm file sets none; Keycloak's defaults for a new realm apply |
| Session expiry of the client's own | A session ends only at sign-out, at a restart, or when a call cannot get its token: a failed refresh, no refresh token, or a refreshed token with less life than the call needs |
| `Secure` on the session cookie | The client is served over HTTP on this machine |
| HTTPS | HTTP on loopback and the lab's network only |
| Provider persistence | The imported realm state and signing keys are lost at restart. Old refresh tokens fail; access tokens remain subject to each service's cached keys and expiry |
| Production database or clustering | — |
| Password policy, brute-force protection, multi-factor sign-in | — |
| Self-registration, password reset, email | — |
| Federation with another identity provider | — |
