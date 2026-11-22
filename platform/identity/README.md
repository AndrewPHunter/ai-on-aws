# Identity provider

An OpenID Connect provider for the lab: Keycloak 26.8.2 in development mode, with one realm, `lab`, imported from [`realm/lab-realm.json`](realm/lab-realm.json) every time it starts.

It is a local stand-in for the identity provider that AgentCore's JWT authorizer trusts. On AWS that authorizer is configured with a discovery URL, the allowed audiences (`aud`), the allowed client IDs (read from a claim named `client_id`), and optional rules on custom claims. The tokens issued here carry those claims in that shape, so the code that will check them does not depend on anything particular to Keycloak.

Four pieces use its tokens. The client's server signs desk staff in here, validates their ID tokens, and sends their access tokens to the agents and the case system. The agents require a valid access token and pass it on: the intake agents to the case system, the label expert to the retrieval service. The case system requires one on every request but `/ping`, records whom an agent acted for, and takes the reviewer and the reviewer role from it. The retrieval service (`knowledge/`) requires one on every request but `/ping`, with audience `lab-knowledge`, and takes nothing else from it.

How it is put together: [docs/architecture/identity.md](../../docs/architecture/identity.md).

## Set up and start

On the machine you work on, from the repository root:

```bash
platform/identity/setup.sh
docker compose -f platform/identity/compose.yaml up -d --wait
```

`setup.sh` writes `platform/identity/.env` with a random value for every variable in [`.env.example`](.env.example): the Keycloak administrator's username and password, the `desk` client's secret, and each user's password. It needs only a shell and Docker; the values are made in the pinned Node image, with no network. If the file already holds every variable it changes nothing; if it exists but lacks one, it stops and names it. It never prints a value.

`docker compose up --wait` returns once the realm's discovery document answers 200. The lab's root `compose.yaml` includes this service, so `docker compose up` at the root starts it with everything else, and also needs `platform/identity/.env`: without it nothing starts.

The realm is imported from the file at every start, and the provider keeps nothing between starts (see "Development only"). Stopping and starting it, or removing it with its volumes, gives the same realm with the same users (and user ids), passwords and client secret, and new signing keys.

### After changing the realm file

The file is read only when the container starts, so an edit to [`realm/lab-realm.json`](realm/lab-realm.json) changes nothing while the provider runs, and `docker compose up -d` does not restart it (its configuration has not changed). Restart it:

```bash
docker compose restart identity                                    # the whole lab, from the repository root
docker compose -f platform/identity/compose.yaml restart identity  # the provider started on its own
```

Stopping the container empties the tmpfs that holds its database, so the start imports the file as it now is, with new signing keys. Every token issued before the restart is then refused, and everyone signed in to the desk signs in again. Run the gate afterwards to check the realm still issues the tokens described here. A realm that does not import never becomes healthy.

## Users

Synthetic users, both with permanent passwords.

| Username | Name | Email | Realm roles | Password |
|---|---|---|---|---|
| `riley.reviewer` | Riley Reviewer | `riley.reviewer@example.org` | `reviewer`, `default-roles-lab` | `IDENTITY_RILEY_PASSWORD` in `platform/identity/.env` |
| `dana.desk` | Dana Desk | `dana.desk@example.org` | `default-roles-lab` | `IDENTITY_DANA_PASSWORD` in `platform/identity/.env` |

The administrator for the admin console at <http://localhost:8090/admin/> is `IDENTITY_ADMIN_USERNAME` with `IDENTITY_ADMIN_PASSWORD`, in the same file. Changes made in the console are lost at the next start.

## The client

One client, `desk`, for the desk's server.

| Setting | Value |
|---|---|
| Type | Confidential: it has a secret, `IDENTITY_DESK_CLIENT_SECRET` in `platform/identity/.env` |
| Flow | Authorization Code only. No password grant, no implicit flow, no service account, no device grant |
| PKCE | Required, method `S256` |
| Redirect URI | `http://localhost:3000/auth/callback`, exactly |
| Post-logout redirect URI | `http://localhost:3000/` |

## Access token claims

An access token issued to either user through `desk` is a JWT signed with RS256 by a key published at the realm's `jwks_uri`, and carries:

| Claim | Value |
|---|---|
| `iss` | `http://localhost:8090/realms/lab`, whichever address was used to reach the provider |
| `aud` | `lab-agents`, `lab-case-system` and `lab-knowledge` |
| `client_id` | `desk` |
| `roles` | A top-level array of the user's realm role names. Holds `reviewer` for `riley.reviewer` and not for `dana.desk`. Both users also hold Keycloak's default role, `default-roles-lab`, so `roles` also holds it and the roles it includes (`offline_access`, `uma_authorization`), and is never empty |
| `sub`, `preferred_username`, `name` | The user's id, username and full name. The id is fixed in the realm file, so `sub` is the same after every start |
| `exp` − `iat` | 600 seconds |

`aud`, `client_id` and `roles` are added by mappers on the `desk` client, in the realm file; Keycloak puts none of them in a user's token by default (its own token names the client in `azp` and the roles under `realm_access`). The token carries no `realm_access` or `resource_access` claim. Other claims Keycloak adds (`azp`, `sid`, `scope`, `email` and so on) are present and are not part of this contract.

A user who holds no realm role at all would get no `roles` claim: Keycloak leaves an empty list out. That is why both users hold the default role.

## ID token

The ID token issued with it, also signed with RS256 by a key at `jwks_uri`, names the same issuer, has `desk` as its audience, and carries the same top-level `roles` array: `reviewer` is in it for `riley.reviewer` and not for `dana.desk`. The same `roles` mapper on the `desk` client puts it in both tokens. The ID token is what tells the desk's server who signed in and whether they are a reviewer.

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

`gate.sh` checks a running service for real, from inside the stack's network, and exits 0 only if each of the four steps below holds:

```bash
platform/identity/gate.sh <compose-project>
```

`<compose-project>` is the compose project the service runs in: `ai-on-aws` when the lab was started from the root, or the name given with `-p`. For example, a trial run on its own:

```bash
docker compose -p identity-trial -f platform/identity/compose.yaml up -d --wait
platform/identity/gate.sh identity-trial
docker compose -p identity-trial -f platform/identity/compose.yaml down -v
```

The gate runs in the pinned Node image on the project's default network (`<compose-project>_default`), with `jose` installed from the lockfile. Its image is `ai-on-aws-identity-gate:checkout-<number>` and its compose project `ai-on-aws-identity-gate-<number>`, the number derived from the checkout's path as `toolchain/check.sh` derives its own. So two checkouts never run each other's gate. `gate.sh` and `stack-gate.sh` print the image on standard error. It:

1. fetches the discovery document at `http://identity:8080`, checks that its issuer is `http://localhost:8090/realms/lab`, and that its key set answers with keys;
2. signs each user in through the Authorization Code flow with PKCE: it requests the authorization endpoint, posts the sign-in form with a cookie jar, reads the redirect to the callback without requesting it, and exchanges the code at the token endpoint with the client secret and the code verifier;
3. verifies each access token's RS256 signature against the published keys and checks `iss`, `aud`, `client_id`, `roles` (with `reviewer` present or absent), `sub`, `preferred_username`, `name` and `exp` − `iat`, then verifies each ID token (signature, issuer, audience) and checks its `roles`;
4. checks that the token endpoint refuses the password grant and the client-credentials grant, and that the authorization endpoint refuses a request with no `code_challenge`, one with `code_challenge_method=plain`, and one with `response_type=token`.

The gate is the browser here, but it runs inside the network, where `localhost:8090` is the gate's own container. So the front-channel URLs the provider hands out on `http://localhost:8090` (the authorization endpoint and the sign-in form's action) are sent to `http://identity:8080` with the same path and query. Back-channel URLs from discovery are used as given.

It does not fetch discovery at `http://localhost:8090`, and does not check that a token lacks `realm_access` or `resource_access`.

It prints a JSON report: the endpoints from discovery, and for each user the token's header and decoded claims. It prints no password, secret, code or token. On the first statement that does not hold it exits 1 and names it in `failed`; a provider that does not answer is such a statement. Exit 1 always comes with a report on standard output. Any way of ending without one (no Docker, no `platform/identity/.env`, no network for the project, Compose failing before the gate runs, a gate that writes nothing) is exit 2, with the reason on standard error.

## The stack gate

`stack-gate.sh` checks the whole running stack end to end, from inside its network, and exits 0 only if every statement holds:

```bash
platform/identity/stack-gate.sh <compose-project>
```

It uses the same image as `gate.sh` and joins `<compose-project>_default` the same way. It is given the two users' passwords and not the client secret: it signs each user in through the client and Keycloak's own sign-in page, the client exchanges the code, and the gate holds only cookies. It checks:

1. without a session, `/api/inquiries` is 401 and `/ping` is 200;
2. `/auth/login` redirects to the provider with the code flow, the client, the redirect URI, `openid`, a state, a nonce and an S256 challenge, and sets the sign-in cookie with its attributes;
3. Keycloak accepts the password and redirects to the callback; the callback creates a session, sets the session cookie with its attributes and clears the sign-in cookie;
4. `/api/session` names the user, with `is_reviewer` true for `riley.reviewer` and false for `dana.desk`, and carries no token; `/api/status` lists the identity provider as up;
5. a replayed callback, and a callback without the sign-in cookie, are 400;
6. a POST from another origin is 403;
7. each intake agent (`intake-handwritten`, `intake-strands`) answers 401 `missing` to no token, 401 `malformed` to a token that is not a JWT, 401 to no token with a body outside the contract, and 200 on `/ping`;
8. the case system's MCP endpoint and review server each answer 401 to no token and 200 on `/ping`;
9. an inquiry to each intake agent is accepted and records who entered it, and its run ends with the agent's answer inside the contract, past the case system, recording who started it. It does not need a model server: a run may end at the model;
10. a review by `dana.desk` of a case that does not exist is 403 `not_a_reviewer`, and by `riley.reviewer` 404 `case_not_found`;
11. sign-out answers with the provider's end-session address carrying no token, and the same cookie is then 401. After the run, on the Docker host, the script reads the client's output since the gate started and requires no revocation failure in it; only the count of such lines is passed to the report.

The label expert and the retrieval service are not in the stack gate; `knowledge/gate.sh` checks the retrieval service's token check (see [knowledge/README.md](../../knowledge/README.md)).

Every statement is checked even after one fails. The JSON report lists `held` and `failed`; it carries no password, code or token. Exit 1 if any statement does not hold, always with the report on standard output; exit 2, with the reason on standard error and nothing on standard output, for any way of ending without a report.

## Other programs that sign in

Two more programs sign in as the gate does, through `desk` with the Authorization Code flow and PKCE, on the stack's network, as `dana.desk`. Compose gives each `IDENTITY_DESK_CLIENT_SECRET` and `IDENTITY_DANA_PASSWORD` from `platform/identity/.env`, and nothing else from it.

| Program | Uses the access token to |
|---|---|
| `knowledge/gate.sh` | Call the retrieval service's MCP endpoint |
| `evaluation/run.sh` | Call the label expert's `POST /invocations`. It signs in again when the token has under 200 s left |

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

It does not have a read-only root filesystem. `start-dev` rebuilds Keycloak's server into `/opt/keycloak/lib/quarkus` at every start, and that build starts from the files the image ships in the same directory. Measured with this image:

| Setting tried | Result |
|---|---|
| `read_only: true` | Start fails: `/opt/keycloak/lib/quarkus/transformed-bytecode.jar: Read-only file system` |
| `read_only: true` and a tmpfs on `/opt/keycloak/lib/quarkus` | Start fails: the tmpfs hides the image's files, and `quarkus-application.dat` is not found |
| `read_only: true` and a named volume on `/opt/keycloak/lib/quarkus` | Starts. Not used: Docker fills a named volume from the image only while the volume is empty, so after the image digest changes the volume would still hold the old image's build, and the built server would outlive `docker compose down` without `-v` |

So the container's own layer holds the rebuilt server, and is discarded with the container.

## Not present

| What | Note |
|---|---|
| A token exchanged for a narrower one | The agents pass the user's access token on unchanged: the intake agents to the case system, the label expert to the retrieval service |
| Proof of which agent is calling | An agent's name is a header it claims; the case system checks the user's token, not the agent |
| HTTPS | — |
| Refresh-token policy, session limits, brute-force protection, password policy | Keycloak's defaults for a new realm |
| Self-registration, password reset, email | Turned off; no mail server |
| Multi-factor sign-in | — |
| Federation with another identity provider | — |
| A production database, clustering, or persistence across restarts | — |
