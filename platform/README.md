# Platform

Local stand-ins for the AgentCore services that sit around the runtime: memory, identity, policy and tracing. Each has its own folder here, and each is labelled as a stand-in for the managed service it imitates.

| Folder | Stands in for | What it is |
|---|---|---|
| [`identity/`](identity/README.md) | The identity provider behind AgentCore's JWT authorizer | Keycloak in development mode with one realm, `lab`: one client for the desk and two synthetic users. It issues tokens; nothing in the lab checks them yet |

Memory, policy and tracing have no stand-in yet.
