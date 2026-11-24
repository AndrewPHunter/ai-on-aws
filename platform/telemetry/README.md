# Trace store

The lab's own destination for execution evidence. It receives spans as OTLP/HTTP JSON and keeps them in SQLite, so a reader on this machine can follow one trace or find the traces of one run. Nothing leaves the machine. It stands in for a trace backend, such as an OpenTelemetry collector with a vendor behind it or CloudWatch Transaction Search. Pieces send plain OTLP, so pointing them at one of those is a change of their endpoint setting.

[`docs/architecture/telemetry.md`](../../docs/architecture/telemetry.md) describes the evidence and how pieces send it with [`shared/telemetry.ts`](../../shared/telemetry.ts).

**It checks no token.** It listens on the lab's internal network as `telemetry:4318` and is published on this machine only, at `127.0.0.1:4318`, like the lab explorer's routes. It holds metadata only: names, identifiers, outcomes, model names, token counts and times. **Do not publish it wider as it is.** Anyone who can reach it can read every trace and send spans.

Every command on this page is run from the root of the repository.

## Run it

```bash
docker compose -f platform/telemetry/compose.yaml up -d --build --wait
```

`docker compose up -d --build --wait` at the root starts it with the rest of the lab. Spans are kept in a SQLite file on a Docker volume, so they survive the container being removed. The volume is `ai-on-aws-telemetry_traces` when the store is started on its own, and `ai-on-aws_traces` when it is started from the root.

```bash
curl -s http://127.0.0.1:4318/status
curl -s 'http://127.0.0.1:4318/traces?run_id=<run id>'
curl -s http://127.0.0.1:4318/traces/<trace id>
```

## Routes

| Route | Answer |
|---|---|
| `POST /v1/traces` | An OTLP/HTTP trace export, `content-type: application/json`. 200 `{}` when every span is stored. 200 `{"partialSuccess":{"rejectedSpans":"<n>","errorMessage":"..."}}` when some spans were refused for a limit and the rest stored. 400 `{"code":3,"message":"..."}` for a body that is not JSON or not a trace export. 413 for a body over the limit. 415 for another content type or any content encoding |
| `GET /traces/<trace_id>` | `{"trace_id","spans":[...]}`, the trace's spans ordered by start time. 404 when it has none |
| `GET /traces?run_id=<id>` | `{"run_id","trace_ids":[...]}`, the traces whose spans carry that `lab.run.id`, the earliest-starting first. 400 without `run_id` |
| `GET /status` | `{"spans_held","retain_spans","oldest_span_start","refused":{"<reason>":<n>}}`. `oldest_span_start` is an ISO 8601 time, or null when no span is held |
| `GET /ping` | 200, for the health check |

Any other path is 404, and another method on a known path is 405.

A span is read back as `trace_id`, `span_id`, `parent_span_id` (null for the first span of a trace), `service` (the resource's `service.name`, or null), `name`, `kind` (`internal`, `server`, `client`, `producer`, `consumer` or `unspecified`), `start_time_unix_nano` and `end_time_unix_nano` (decimal strings), `status` (`unset`, `ok` or `error`), `attributes`, `resource` (both objects of names to strings, numbers and booleans) and `schema_version` (the resource's `lab.telemetry.schema_version`, or null). A span's status message, events and links are not stored.

## Limits

| Limit | Value | Over it |
|---|---|---|
| Request body | 1,000,000 bytes | 413, nothing stored |
| Attributes on a span, and on a resource | 64 | The span is refused, `too_many_attributes` |
| Length of a span name, an attribute name or a text value | 256 characters | The span is refused, `value_too_long` |
| Attribute value | A string, a whole number, a number or a boolean | The span is refused, `unsupported_value` |
| Spans held | `TELEMETRY_RETAIN_SPANS` | The oldest by arrival are deleted in the write that stores new ones |

A span over a limit is refused whole, never truncated. Its export's other spans are stored, and the refusal is counted under its reason in `GET /status`. A resource over a limit refuses all of its spans. A span already stored, with the same trace id and span id, is not stored again and is not a refusal. Ids are stored in lower case.

## Settings

Set in [`compose.yaml`](compose.yaml). Each is required. The store stops at start-up, naming any that is missing or malformed.

| Setting | Meaning |
|---|---|
| `TELEMETRY_DB_PATH` | The SQLite file |
| `TELEMETRY_RETAIN_SPANS` | How many spans are kept, a whole number of 1 or more: `100000` |

## How it fails

| Failure | Result |
|---|---|
| A setting missing or malformed | It exits with status 2, naming the setting |
| The SQLite file cannot be opened or written | It exits at start-up. A failed write answers 500, and nothing of that export is stored |
| A body that is not a trace export | 400. The OTLP exporter does not retry it |

## Always true

1. A valid export is answered 200 and each span in it is stored once, however many times it is sent. `GET /traces/<trace_id>` returns the trace's spans ordered by start, and 404 when it has none. `GET /traces?run_id=` returns the traces whose spans carry that run id.
2. A body that is not JSON or not an OTLP trace export is answered 400, one over the size limit 413, and one of another content type 415. Nothing of a refused body is stored.
3. Only the newest `TELEMETRY_RETAIN_SPANS` spans, by arrival, are held.
4. No route asks for a token. A span over a limit is refused whole and the rest of its export stored. The answer's `partialSuccess.rejectedSpans` counts it, and `GET /status` counts it under its reason, beside the spans held and the oldest span's start.

The tests in `test/` are named `telemetry` and the item's number, one for each item. They call the routes as a function given a request, with the store on an in-memory database, and open no socket.

## Known limits

- **No authentication**, as above. A hosted store needs authenticated, scoped reads and writes.
- **One SQLite file**, written by one process. It is a playground store, not a trace backend for load.
- **Retention is by count, not by age.** A quiet lab keeps old spans indefinitely.
- **SQLite support in Node 22 is marked experimental** and prints a warning at start.
- **OTLP over protobuf and gRPC are not accepted**, only JSON.
