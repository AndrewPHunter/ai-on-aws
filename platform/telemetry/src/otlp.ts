// Reads an OTLP/HTTP trace export in JSON (ExportTraceServiceRequest) into the spans to store and the spans refused
// for a limit. A body whose shape is not a trace export is invalid as a whole. Field names are lowerCamelCase, ids
// hex (either case), enums integers and 64-bit numbers decimal strings or numbers, as the OTLP specification sets
// for JSON; unknown fields are ignored. Events, links and a status message are not read.

import { RESOURCE_ATTRIBUTES, RUN_ID_ATTRIBUTE } from '../../../shared/telemetry-attributes.ts';

export const MAX_ATTRIBUTES = 64;
export const MAX_TEXT = 256;

export type Scalar = string | number | boolean;
export type RefusalReason = 'too_many_attributes' | 'value_too_long' | 'unsupported_value';

export type StoredSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  service: string | null;
  name: string;
  kind: string;
  // Nanoseconds since the epoch, as decimal text.
  start: string;
  end: string;
  status: 'unset' | 'ok' | 'error';
  attributes: Record<string, Scalar>;
  resource: Record<string, Scalar>;
  schemaVersion: string | null;
  runId: string | null;
};

export type ReadExport = { spans: StoredSpan[]; refused: RefusalReason[] };

export class InvalidExport extends Error {}

const KINDS = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'] as const;
const STATUSES = ['unset', 'ok', 'error'] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown, where: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InvalidExport(`${where} is not a list`);
  return value;
}

function object(value: unknown, where: string): Json {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new InvalidExport(`${where} is not an object`);
  return value;
}

function id(value: unknown, length: number, where: string): string {
  if (typeof value !== 'string' || value.length !== length || !/^[0-9a-fA-F]+$/.test(value) || /^0+$/.test(value)) {
    throw new InvalidExport(`${where} is not a ${length}-digit hex id`);
  }
  return value.toLowerCase();
}

function nanos(value: unknown, where: string): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof text !== 'string' || !/^[0-9]{1,20}$/.test(text)) throw new InvalidExport(`${where} is not a time in nanoseconds`);
  return BigInt(text).toString();
}

function enumIndex(value: unknown, size: number, where: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= size) throw new InvalidExport(`${where} is not a known value`);
  return value;
}

class Refused extends Error {
  readonly reason: RefusalReason;
  constructor(reason: RefusalReason) {
    super(reason);
    this.reason = reason;
  }
}

function text(value: string): string {
  if (value.length > MAX_TEXT) throw new Refused('value_too_long');
  return value;
}

// An AnyValue holding a string, a whole number, a number or a boolean. Anything else refuses the span.
function scalar(value: Json): Scalar {
  if (typeof value.stringValue === 'string') return text(value.stringValue);
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  if (typeof value.doubleValue === 'number') return value.doubleValue;
  if (typeof value.intValue === 'number' && Number.isSafeInteger(value.intValue)) return value.intValue;
  if (typeof value.intValue === 'string' && /^-?[0-9]{1,19}$/.test(value.intValue)) {
    const whole = Number(value.intValue);
    if (Number.isSafeInteger(whole)) return whole;
  }
  throw new Refused('unsupported_value');
}

// A list of KeyValue. Its shape is checked first (a wrong shape is an invalid export); then its limits (a refusal).
function attributes(value: unknown, where: string): () => Record<string, Scalar> {
  const pairs = list(value, where).map((pair, index) => {
    if (!isObject(pair) || typeof pair.key !== 'string') throw new InvalidExport(`${where}[${index}] is not a key and value`);
    return { key: pair.key, value: object(pair.value, `${where}[${index}].value`) };
  });
  return () => {
    if (pairs.length > MAX_ATTRIBUTES) throw new Refused('too_many_attributes');
    const result: Record<string, Scalar> = {};
    for (const pair of pairs) result[text(pair.key)] = scalar(pair.value);
    return result;
  };
}

function textOrNull(value: Scalar | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

export function readExport(body: unknown): ReadExport {
  if (!isObject(body)) throw new InvalidExport('the body is not an object');
  // Every span's shape is checked before anything is decided, so an invalid export refuses or stores nothing.
  const pending: { resource: () => Record<string, Scalar>; span: Omit<StoredSpan, 'attributes' | 'resource' | 'service' | 'schemaVersion' | 'runId'>; attributes: () => Record<string, Scalar> }[] = [];
  list(body.resourceSpans, 'resourceSpans').forEach((resourceSpans, r) => {
    const where = `resourceSpans[${r}]`;
    const entry = object(resourceSpans, where);
    const resource = attributes(object(entry.resource, `${where}.resource`).attributes, `${where}.resource.attributes`);
    list(entry.scopeSpans, `${where}.scopeSpans`).forEach((scopeSpans, s) => {
      list(object(scopeSpans, `${where}.scopeSpans[${s}]`).spans, `${where}.scopeSpans[${s}].spans`).forEach((value, n) => {
        const at = `${where}.scopeSpans[${s}].spans[${n}]`;
        const span = object(value, at);
        if (typeof span.name !== 'string' || span.name === '') throw new InvalidExport(`${at}.name is not a name`);
        const parent = span.parentSpanId === undefined || span.parentSpanId === null || span.parentSpanId === '' ? null : id(span.parentSpanId, 16, `${at}.parentSpanId`);
        pending.push({
          resource,
          attributes: attributes(span.attributes, `${at}.attributes`),
          span: {
            traceId: id(span.traceId, 32, `${at}.traceId`),
            spanId: id(span.spanId, 16, `${at}.spanId`),
            parentSpanId: parent,
            name: span.name,
            kind: KINDS[enumIndex(span.kind, KINDS.length, `${at}.kind`)] ?? 'unspecified',
            start: nanos(span.startTimeUnixNano, `${at}.startTimeUnixNano`),
            end: nanos(span.endTimeUnixNano, `${at}.endTimeUnixNano`),
            status: STATUSES[enumIndex(object(span.status, `${at}.status`).code, STATUSES.length, `${at}.status.code`)] ?? 'unset',
          },
        });
      });
    });
  });

  const result: ReadExport = { spans: [], refused: [] };
  for (const item of pending) {
    try {
      text(item.span.name);
      const resource = item.resource();
      const spanAttributes = item.attributes();
      result.spans.push({
        ...item.span,
        attributes: spanAttributes,
        resource,
        service: textOrNull(resource[RESOURCE_ATTRIBUTES.service]),
        schemaVersion: textOrNull(resource[RESOURCE_ATTRIBUTES.schemaVersion]),
        runId: textOrNull(spanAttributes[RUN_ID_ATTRIBUTE]),
      });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      result.refused.push(error.reason);
    }
  }
  return result;
}
