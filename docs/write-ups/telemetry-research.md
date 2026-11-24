# Telemetry research: follow the work, then compare its outcomes

Research checked 24 November 2026 against primary AWS, Honeycomb, and OpenTelemetry sources. This is architectural guidance, not a statement that the demo already implements it. Repository observations below come from the companion read-only scan of current main at `6fe1e0f`; no application code or AWS account state was changed or inspected here.

The strongest design is an independently emitted record of a business operation as it crosses processes, agents, model calls, tools, and durable services. The answer returned to a user is one result of that operation. It must not be the sole delivery mechanism for evidence about the operation.

## 1. Keep the operation identifiable across failures and restarts

Use separate identifiers for the durable business operation, the conversation, each execution attempt, and the telemetry trace/span. A retry belongs to the same business operation but gets its own attempt identity and spans. An idempotency key identifies a mutation request; it should not be overloaded as a trace ID. Carry the operation identity into durable audit records so a committed change remains discoverable when the client never receives its response.

Use parent/child spans where work is genuinely nested. Preserve context across HTTP and task boundaries. Use span links for resumed or independently scheduled work, fan-in, and other relationships that do not fit one parent. A conversation can contain multiple traces; do not keep a single span open indefinitely simply to represent an enduring case. These are application design decisions based on [OpenTelemetry's trace and link model](https://opentelemetry.io/docs/concepts/signals/traces/).

Honeycomb's [Agent Timeline](https://docs.honeycomb.io/investigate/observe/agent-timeline) already models conversations as multiple traces correlated by `gen_ai.conversation.id`. It groups GenAI spans by agent and operation, exposes related spans and links, and displays content when available. That supports a portable structural trace even when raw prompts are excluded. The application must actually emit the correlation fields and operation attributes; sending arbitrary JSON under a field called `trace` does not produce this behavior.

## 2. Record observations at the boundary where they become true

Emit spans as model, tool, retrieval, and service operations complete, independently of the final application response. For long-running work, emit bounded progress observations instead of waiting for one enormous root span to end. Record request acceptance, validation failures, cancellation, timeouts, retries, and final status outside the agent's happy path. Capture the actual service mutation result separately from a model's claim that it succeeded.

An SDK buffer is not a durable ledger. Design explicit export retries and bounded queues, monitor dropped telemetry, and test process termination. Some in-flight data can still be lost. Where a business fact must survive, persist it with the state change and correlate it with telemetry. Do not imply that OpenTelemetry itself supplies transactional audit durability.

Separate observed facts from generated explanations. Useful observations include a tool selected, its validated arguments or safe argument shape, a policy rejection, a retrieved passage shown to the model, a mutation committed, and an answer checked. A model-generated rationale is output to assess, not privileged evidence of the cause of a decision.

## 3. Make population questions possible

Place meaningful dimensions on the operation and on the spans that own them: agent/configuration version, deployment, requested and actual model, prompt-template version, retrieval strategy and corpus version, tool name, caller role, outcome, retry count, and evaluator version. Keep identity values opaque and minimize their scope. These are query dimensions, not authority to perform an action.

Start with a concrete question: why did this release produce more stopped outcomes, more repeat tool calls, or more expensive successful operations? Compare the affected population with a relevant baseline, then open representative traces. Honeycomb's [BubbleUp documentation](https://docs.honeycomb.io/investigate/analyze/identify-outliers) describes precisely this selection-versus-baseline workflow and follow-up filtering. A distinguishing attribute supplies a hypothesis. It does not establish causation: task mix, tenant mix, time window, and other changes can explain the difference.

Choose denominators explicitly. Count one record per business operation for operation success; count attempts for retry behavior; count inference spans for model usage. Counting every tool span as an operation would overrepresent complicated requests. Preserve `completed`, `stopped`, and `failed` rather than collapsing them to one error bit. A safe refusal and an infrastructure failure require different interpretation.

## 4. Use AWS observability as a concrete integration, not a promise that everything connects automatically

[AgentCore's configuration guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html) distinguishes service telemetry from application instrumentation and requires CloudWatch Transaction Search for its tracing experience. It documents ADOT-based application instrumentation, distributed context/session propagation, and custom attributes. Its current third-party section offers `DISABLE_ADOT_OBSERVABILITY=true` to remove runtime ADOT defaults, but also explicitly describes retaining ADOT while exporting to another platform. Treat these as configuration choices, not a universal requirement to disable AWS observability. The November 16, 2026 resource-attribute behavior also changes what is merged onto runtime invocation spans.

Choose and test an application-owned export route. [Honeycomb accepts OTLP](https://docs.honeycomb.io/send-data) over gRPC, HTTP/protobuf, and HTTP/JSON, so portable application spans can be sent directly or through a suitable collector. That protocol compatibility does not establish automatic CloudWatch-to-Honeycomb replication, identical enriched views, or export of every AWS service-generated span. Avoid promising those without a separately verified integration. When exporting twice, check duplicate instrumentation and duplicate accounting.

[AWS's view-data guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-view.html) identifies CloudWatch destinations and supported trace headers. Spans may be in the agent's own log group or shared `aws/spans`, depending on configuration and deployment history. Inspect the configured path rather than hardcoding one universal location. Service metrics and framework/application metrics are separate sources; enabling runtime hosting does not invent business outcomes or missing application context.

[Bedrock model invocation logging](https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html) is a different facility: disabled by default, configured for account/Region, and able to capture full request/response content and metadata into CloudWatch Logs or S3. Current coverage is for `bedrock-runtime`, not `bedrock-mantle`. It can help investigate a model call but cannot reconstruct uninstrumented orchestration or service work. Its content scope is a deliberate data-handling decision, not a substitute for distributed tracing.

## 5. Version the semantic contract and test each consumer

The old [OpenTelemetry GenAI landing page](https://opentelemetry.io/docs/specs/semconv/gen-ai/) now redirects readers to a separate repository. The current [GenAI conventions README](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/README.md) marks its status **Development**. Use that exact maturity description rather than an unqualified claim that every possible `gen_ai.*` field is stable or experimental. Pin the instrumentation and schema versions used by the application; keep vendor mappings explicit and test them on upgrades.

This is a practical compatibility issue. [Honeycomb's LLM cost documentation](https://docs.honeycomb.io/investigate/observe/llm-cost) says its enrichment reads GenAI v1.41.1 attributes with specified legacy fallbacks. Its estimates use reported tokens and a pricing catalog, not the provider invoice. It also documents a cache-accounting trap: Anthropic input counts exclude cache read/write counts, while the relevant OTel input total includes them. Incorrect Bedrock/Anthropic mappings can omit or understate costs. Only transform counts after verifying the source semantics, or caches may be counted twice.

Record unknown usage as unknown. A call that times out before usage is available is not a zero-token call. Capture every actual inference, including report checks and evaluators, and label its purpose so operational cost can be separated from evaluation cost. Store estimate provenance and coverage, and compare like-for-like populations before claiming an improvement.

## 6. Connect evaluation to execution without confusing scores with facts

The [AgentCore Evaluate API](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_Evaluate.html) accepts session spans and can target trace or span IDs. Associate scores with the operation, attempt, trace/span, evaluator identity/version, evaluation time, and dataset/reference version. A later evaluation is a new observation about an earlier execution, not a reason to overwrite the original outcome.

[AWS's generic framework support](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/supported-frameworks-generic.html) documents how span types are classified and fields extracted. Valid OTLP alone is insufficient: operation names, scope, and content shapes must match the consumer. Exercise the actual exported fixtures against the chosen evaluation integration.

[AWS's telemetry delivery guidance](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/supported-frameworks-telemetry.html) says scoring needs prompts, completions, and tool input/output content. Unified delivery retains this content on spans; split delivery moves it to event records correlated by trace and span IDs. Neither arrangement is redaction. A metadata-only operational lane can answer timing and control-flow questions, but cannot promise content-dependent quality evaluation. Use an explicitly protected evaluation/content lane where needed, and record when required content is unavailable.

## 7. Minimize content before export

Default operational telemetry to bounded, allowlisted metadata. Raw prompts, tool arguments, retrieved text, and responses should require a specific diagnostic or evaluation purpose and a controlled retention/access policy. Record safe references to protected evidence where practical. Never place credentials in tracing fields or baggage; an authenticated caller identifier and an authorization token are different things. Correlation context received over the network must not become an authorization decision.

[OpenTelemetry's sensitive-data guidance](https://opentelemetry.io/docs/security/handling-sensitive-data/) makes instrumentation authors responsible for reviewing emitted data and recommends minimization and collector filtering/redaction. Hashing a predictable identifier is not guaranteed anonymization. Apply source-side controls before data reaches exporter buffers; use collector policy as another boundary. Verify what auto-instrumentation emits rather than assuming application logging settings cover it.

An especially misleading configuration name is `AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT`: current AWS configuration documentation describes `true` as keeping content **on spans**. It does not mean opting out of content collection. Test the delivered record, not just the name of the flag.

Set retention by evidence class and destination. [Honeycomb's data-protection documentation](https://docs.honeycomb.io/security-compliance/security-data-protection) describes encryption and retention-based deletion, but a platform default is not the application's policy. Apply narrower access to content than to operational statistics. Keep telemetry retrieval scoped to the caller's permissions just as business records are.

## 8. Sample deliberately, and keep audit evidence outside the sampler

Begin with full capture for this small demo; add sampling when measured volume justifies its operational cost. [OpenTelemetry's sampling guidance](https://opentelemetry.io/docs/concepts/sampling/) explains the central tradeoff: head decisions are cheap but cannot inspect later errors, while tail decisions can consider outcomes but need state, capacity, and operational monitoring. Tail sampling cannot recover data already discarded upstream.

[Honeycomb Refinery](https://github.com/honeycombio/refinery) makes trace-level tail decisions, including policies that retain errors and sample routine traffic. Its completion windows and overload behavior matter for long agent operations. Design and test late-span handling rather than assuming a trace stays open forever. Trace retention does not automatically preserve every trace in a multi-trace conversation.

Keep a baseline sample of routine outcomes as well as unusual cases; otherwise comparisons become biased toward incidents. Preserve sampling probabilities and policy versions. [Honeycomb's sampling explanation](https://www.honeycomb.io/blog/refinery-ema-sampling) describes weighted estimates, which remain estimates rather than exact reconstruction. Do not calculate success rates naively from an error-enriched retained set. Never sample away the authoritative mutation audit merely because a trace is uninteresting.

## Proposed alignment work against the demo

The companion scan reports useful existing semantics: `requested_by` distinguishes model/agent requests; outcomes retain stopped/completed/failed; retrieval records retain shown status and strategy; citations retain source/version/date; and the service commits case mutation, idempotency evidence, and audit atomically. Preserve these as the business vocabulary of the new telemetry.

The scan also reports that current `response.steps` is assembled in memory and persisted only by the client after receiving the final response. Client run IDs are not forwarded, trace context is absent from the application transport, and the local edge does not preserve `traceparent`/`tracestate`. These are precisely the places to align with the design above, rather than weakening the architecture to fit current behavior.

1. Introduce operation, conversation, attempt, and trace/span correlation at request admission; propagate them through client, edge, orchestrator, intake/expert calls, model/tool boundaries, and the durable service.
2. Emit independent incremental observations; retain the useful step view as a diagnostic projection under the appropriate access policy. Add safe trace correlation to the existing transactional audit.
3. Preserve unknown token usage and capture omitted report-check inference usage. Validate cache semantics and count actual calls rather than summaries twice.
4. Establish versioned OTel export fixtures for local and hosted routes, including a privacy allowlist. Verify Honeycomb and AWS consumer mappings independently.
5. Prove behavior with failures: crash after service commit but before response; timeout after model completion; retry after response loss; async continuation; collector outage; late evaluation; content capture disabled. Each exercise should answer what evidence survives and where it can be found.
6. Add operation-level outcome and latency comparisons by release, retrieval strategy, and task cohort; then link evaluations to the same operations. Start without sampling and budget from observed telemetry volume.

No application changes are implied by this research. These are target architecture decisions and concrete alignment work for the next implementation pass.
