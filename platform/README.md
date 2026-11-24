# Platform

Local stand-ins for the AgentCore services that sit around the runtime. Each has its own folder here, and each is labelled as a stand-in for the managed service it imitates.

| Folder | Stands in for | What it is |
|---|---|---|
| [`identity/`](identity/README.md) | The identity provider behind AgentCore's JWT authorizer | Keycloak in development mode with one realm, `lab`: four synthetic people, and a client each for the desk, the four agents, the evaluation harness and the knowledge gate, with the case system and the retrieval service registered as audiences. The client signs people in through it and validates their ID tokens; the agents check the access token on `POST /invocations`, and the case system and the retrieval service on every request but `/ping` |
| [`telemetry/`](telemetry/README.md) | A trace backend behind AgentCore Observability, such as CloudWatch Transaction Search or an OpenTelemetry collector | A trace store: receives spans as OTLP/HTTP JSON at `POST /v1/traces`, keeps the newest in SQLite, and answers reads by trace and by run, on this machine only and with no token |

Memory and policy have no stand-in here.
