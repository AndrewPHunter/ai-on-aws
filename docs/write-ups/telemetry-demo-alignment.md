# Aligning the playground with the telemetry design

This compares the telemetry design in [Following the Work](following-the-work.md) with the current main branch. It is an implementation brief for discussion, based on reading the source. It does not report a deployment or a measured failure experiment. The [research notes](telemetry-research.md) hold the AWS, Honeycomb, and OpenTelemetry guidance behind the design.

## Preserve the useful evidence

The existing step contract already distinguishes model calls, tool calls, retrieval, report checks, errors, and delegation. It records whether a tool was requested by inference or by code, whether retrieved passages were shown to the model, and how the run ended. Citations retain label and passage provenance. These semantics should survive a change in storage or exporter.

The case service's committed record is independent of the agent's response. Case creation and follow-up write the case/version, idempotency record, and audit entry in a transaction. The audit derives actor and acting-for identity from the verified caller. Keep this as authoritative business evidence, with correlation to diagnostic telemetry. Do not replace it with an exporter or sample it with traces.

Relevant sources: `shared/agent-contract.ts`, `agents/src/run/steps.ts`, `agents/src/expert/strands.ts`, `tools/case-system/src/store.ts`, and `tools/case-system/src/http.ts`.

## The central gap

The current “trace” is the response's `steps` array. Steps live in agent memory and reach the client at the end of the invocation. The client stores the response as JSON. This is useful for inspecting completed calls, but the evidence depends on successful delivery and acceptance of that final response.

- `agents/src/run/state.ts` owns the in-memory steps; `agents/src/run/endings.ts` returns them.
- `agents/src/contract/sdk-app.ts` returns an empty-step failure on an unexpected throw or an invalid response. The handwritten server also loses the accumulated steps on its exception path.
- `client/src/agents.ts` rejects timeouts and invalid responses without retaining the agent's steps; `client/src/store.ts` stores no response for those failures.
- Client startup marks interrupted runs failed. The background invocation is in-process work, not a durable queue.

The target is independently exported, correlated execution evidence. Completed spans should be available without waiting for the whole agent response. A long-running operation also needs an explicit lifecycle observation or durable work state if we need to recognize an unfinished attempt. This improves failure visibility; it does not promise that an abruptly killed process exports every last observation.

## Proposed changes

| Priority | What should change | What the source shows today | Intended result |
|---|---|---|---|
| First | Establish application-owned trace context across service boundaries | The client creates a run ID but sends only the message to the agent. HTTP calls carry authentication without trace context; the local runtime edge does not preserve ordinary W3C trace headers | An inquiry/run can be followed through the client, runtime adapter, agent delegation, model calls, tools, retrieval, and case service |
| First | Emit execution evidence independently of the final response | `steps` is accumulated in memory and persisted with the final answer | Completed work remains inspectable when a later call or the final response fails |
| First | Separate business operation, execution, and attempt identifiers | Message identity supports case idempotency, but no explicit per-step/attempt/span identity joins the execution | Retries remain the same business operation while appearing as distinct delivery attempts; a new run does not appear to be a duplicate span |
| First | Preserve the meaning of outcomes | Completed/stopped/failed and model-versus-agent initiation are useful; refusals and transport failures are still often folded into a generic tool error flag | Record whether a proposal was refused, a call executed, a response was lost, or a service committed a change; retain service and caller perspectives |
| Next | Version the execution evidence and configuration metadata | Steps lack a schema version, prompt/tool configuration version, deployment identity, and complete retrieval/index configuration identity | Compare behavior across changes and interpret historical records without parsing all of them as today's response schema |
| Next | Account for every model call and retain unknown usage | Separate report-check inference drops usage; evaluation adds nullable usage as zero. SDK-internal retries may not appear in the existing Strands hooks | Usage coverage is explicit; checking calls and actual retry attempts are visible. Unknown token usage does not become zero cost |
| Next | Define metadata and content capture separately | Rich steps include text, arguments, results, and retrieved excerpts. Some logging paths are sanitized, but there is no common end-to-end content policy | Safe operational metadata by default; controlled content capture for approved diagnostic and evaluation needs; consistent redaction before export |
| Next | Add a bounded export pipeline and an explicit retention policy | No application OTel exporter, telemetry sampler, or retention/deletion mechanism appears in the examined paths | Export failures and drops are observable; buffers are bounded; evidence lifetime matches its intended use |
| Next | Connect evaluation to versioned evidence | Evaluation reads final response steps for retrieval, corrections, and usage; attack checks already distinguish caller-visible output from diagnostic evidence | Evaluations can refer to run/span/artifact identities and report incomplete evidence rather than inventing a passing result |

For instrumentation, start with shared runtime and transport boundaries, then add the agent-specific operations. A framework hook, an HTTP auto-instrumentor, and a manual wrapper can all observe the same model call. Choose who owns the logical inference span and who owns physical attempts so one request is not counted several times. Inspect the actual TypeScript SDK capabilities rather than assuming a Python Strands setup applies unchanged.

The independent telemetry representation can supply the local explorer and preserve the useful existing views. The final response does not need to become the transport for all diagnostic evidence. Preserve the existing agent contract until its consumers have an explicit migration path.

## Local diagnostics and hosted access are different surfaces

The desk API requires `traces:read` for full traces and strips steps from ordinary responses. Current main also has a deliberately unauthenticated, read-only `/lab/api` explorer, exposed through the loopback-bound client. It is a local diagnostic interface, not evidence that hosted trace access has been secured.

Keep that exception explicit. A hosted deployment needs authenticated diagnostic access, scoped content permissions, and a retention policy. Changing the network binding of the local explorer must not accidentally publish all inquiries and traces. The existing safe SDK logging should remain, while generic error paths and exported attributes need the same content review.

## Export choices

For the local playground, a standard OpenTelemetry SDK and a separately configured collector or exporter provide a practical place to exercise correlation, filtering, and backpressure. Honeycomb supports OTLP ingestion. Application semantics should be independent of that destination, with an explicit mapping to the fields its agent views consume.

For AgentCore's AWS-native observability experience, follow the documented ADOT SDK and CloudWatch setup, including Transaction Search and permissions. Do not assume a generic local collector is interchangeable with the documented AgentCore integration. AgentCore platform observations and application instrumentation are complementary. Selecting Honeycomb requires an intentional exporter configuration; it is not an automatic forward of every CloudWatch or AgentCore service record.

Choose and test one route first. If we later need both destinations, define which observations each receives, verify trace continuity, schema mappings and privacy settings at each, and check for duplicate instrumentation. Avoid building an unneeded dual-export system merely because both products are discussed in the essay.

## First implementation slice

Prove one complete path: a client run invokes intake, intake performs a model call and a case write, and the case service commits its record. Carry execution context across every boundary and export each completed operation independently. Keep the existing case idempotency and audit behavior intact.

The first review should be able to establish:

- A normal run joins client, agent, model, tool, and service observations without relying on the final response's steps.
- A lost write response shows a committed service operation and a failed caller attempt; the repeat uses the same operation identity and creates no second case.
- An interrupted run leaves already exported observations available, with incomplete work identifiable and no fabricated successful ending.
- A refusal is distinguishable from an executed call, and traces contain no credentials or unauthorized content.
- An unavailable exporter has bounded effects and visible loss/backpressure rather than silently consuming unlimited resources.

Extend that path to the orchestrator and expert next. Preserve parallel parent-child relationships, carry the inquiry/conversation identity into delegated work, and record retrieval selection separately from context inclusion. Add linked traces when introducing a real durable handoff; the current in-process background invocation is not a durable queue.

Begin with all traces retained at playground volume, under the chosen content policy. Sampling is a later operating decision with its own baseline and accounting requirements. Keep the business audit independent throughout.
