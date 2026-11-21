# Test support

Code that tests use and nothing else runs. It stands in for a service a test cannot start, and each file says so in its first line.

| File | What it is | Used by |
|---|---|---|
| [`issuer.ts`](issuer.ts) | A stand-in OpenID Connect issuer on loopback: discovery, keys, sign-in of a scripted user, the token endpoint with the client secret and PKCE enforced, refresh, revocation and end-session, all with real RS256 signatures. A test can make one part of an answer wrong at a time, and it records every request | The client's tests; later the agents' and the case system's |

Its own test is in `test/`, picked up by the repository's test command.

Nothing under this folder is copied into a piece's image. The `run` stage of [`toolchain/Dockerfile`](../toolchain/Dockerfile) copies `shared/` and the piece's own `src/` only. The check image copies the whole repository, because it runs the tests.
