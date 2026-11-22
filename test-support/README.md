# Test support

Code that tests use and nothing else runs. It stands in for a service a test cannot start, and each file says so in its first line.

| File | What it is | Used by |
|---|---|---|
| [`issuer.ts`](issuer.ts) | A stand-in OpenID Connect issuer on loopback: discovery, keys, sign-in of a scripted user, the token endpoint with the client secret and PKCE enforced, refresh, revocation and end-session, all with real RS256 signatures. A test can make one part of an answer wrong at a time, and it records every request. It also mints access tokens with chosen claims and lifetime, signed with its key, another key, HS256 or nothing, and can replace its key | The tests of the client and `shared/access-token.ts` |

Its own test is in `test/`, picked up by the repository's test command.

Its signing keys, codes and refresh tokens are random values made when it needs them, not passed in, unlike the clocks and randomness the code under test is given. Node cannot generate an RSA key from a seed, and no test asserts on any of these values: a test compares what the code under test did with the values the stand-in reports it handed out.

Nothing under this folder is copied into a piece's image. The `run` stage of [`toolchain/Dockerfile`](../toolchain/Dockerfile) copies the source files at the top of `shared/` (`shared/*.ts`) and the piece's own `src/` only. The check image copies the whole repository, because it runs the tests.
