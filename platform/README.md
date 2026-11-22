# Platform

Local stand-ins for the AgentCore services that sit around the runtime. Each has its own folder here, and each is labelled as a stand-in for the managed service it imitates.

| Folder | Stands in for | What it is |
|---|---|---|
| [`identity/`](identity/README.md) | The identity provider behind AgentCore's JWT authorizer | Keycloak in development mode with one realm, `lab`: one client for the desk and two synthetic users. The client signs desk staff in through it and validates their ID tokens; the agents check the access token on `POST /invocations`, and the case system and the retrieval service on every request but `/ping` |

Memory, policy and tracing have no stand-in here.
