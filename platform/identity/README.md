# Identity provider

An OpenID Connect provider for the lab: Keycloak 26.8.2 in development mode, with one realm, `lab`, imported from [`realm/lab-realm.json`](realm/lab-realm.json) every time it starts.

It is a local stand-in for the identity provider that AgentCore's JWT authorizer trusts. On AWS that authorizer is configured with a discovery URL, the allowed audiences (`aud`), the allowed client IDs (read from a claim named `client_id`), and optional rules on custom claims. The tokens issued here carry those claims in that shape, so the code that will check them does not depend on anything particular to Keycloak.

Nothing in the lab checks these tokens yet. The provider runs with the rest of the lab and issues tokens; the client, the agents and the case system do not ask for them.

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
| `aud` | `lab-agents` and `lab-case-system` |
| `client_id` | `desk` |
| `roles` | A top-level array of the user's realm role names. Holds `reviewer` for `riley.reviewer` and not for `dana.desk`. Both users also hold Keycloak's default role, `default-roles-lab`, so `roles` also holds it and the roles it includes (`offline_access`, `uma_authorization`), and is never empty |
| `sub`, `preferred_username`, `name` | The user's id, username and full name. The id is fixed in the realm file, so `sub` is the same after every start |
| `exp` − `iat` | 600 seconds |

`aud`, `client_id` and `roles` are added by mappers on the `desk` client, in the realm file; Keycloak puts none of them in a user's token by default (its own token names the client in `azp` and the roles under `realm_access`). The token carries no `realm_access` or `resource_access` claim. Other claims Keycloak adds (`azp`, `sid`, `scope`, `email` and so on) are present and are not part of this contract.

A user who holds no realm role at all would get no `roles` claim: Keycloak leaves an empty list out. That is why both users hold the default role.

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

`gate.sh` checks a running service for real and exits 0 only if every statement in "Access token claims" and "Two addresses" holds:

```bash
platform/identity/gate.sh <compose-project>
```

`<compose-project>` is the compose project the service runs in: `ai-on-aws` when the lab was started from the root, or the name given with `-p`. For example, a trial run on its own:

```bash
docker compose -p identity-trial -f platform/identity/compose.yaml up -d --wait
platform/identity/gate.sh identity-trial
docker compose -p identity-trial -f platform/identity/compose.yaml down -v
```

The gate runs in the pinned Node image on the project's default network (`<compose-project>_default`), with `jose` installed from the lockfile. It:

1. fetches the discovery document at `http://identity:8080` and checks its issuer, and that its key set answers;
2. signs each user in through the Authorization Code flow with PKCE: it requests the authorization endpoint, posts the sign-in form with a cookie jar, reads the redirect to the callback without requesting it, and exchanges the code at the token endpoint with the client secret and the code verifier;
3. verifies each access token's signature against the published keys and checks every claim in the table above;
4. checks that the token endpoint refuses the password grant.

The gate is the browser here, but it runs inside the network, where `localhost:8090` is the gate's own container. So the front-channel URLs the provider hands out on `http://localhost:8090` (the authorization endpoint and the sign-in form's action) are sent to `http://identity:8080` with the same path and query. Back-channel URLs from discovery are used as given.

It prints a JSON report: the endpoints from discovery, and for each user the token's header and decoded claims. It prints no password, secret, code or token. On the first statement that does not hold it exits 1 and names it in `failed`; if it cannot run, it exits 2.

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
| Anything that checks the tokens | The client, the agents and the case system do not ask for a token |
| HTTPS | — |
| Refresh-token policy, session limits, brute-force protection, password policy | Keycloak's defaults for a new realm |
| Self-registration, password reset, email | Turned off; no mail server |
| Multi-factor sign-in | — |
| Federation with another identity provider | — |
| A production database, clustering, or persistence across restarts | — |
