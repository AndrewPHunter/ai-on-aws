// The attributes a span of execution evidence may carry: their names, value types and the closed lists of values,
// and the evidence schema version. Metadata only: no name here is for message text, a tool's arguments or result, a
// retrieved passage, a token, a secret, a key or a network address. telemetry.ts refuses anything not declared here;
// the trace store reads the run id's name from here.

// Changes when the meaning of a declared attribute changes. On every span's resource, beside the service's name.
export const TELEMETRY_SCHEMA_VERSION = '1';

export const RESOURCE_ATTRIBUTES = {
  service: 'service.name',
  schemaVersion: 'lab.telemetry.schema_version',
} as const;

export const RUN_ID_ATTRIBUTE = 'lab.run.id';

// Refused, executed and response lost tell a caller's view of a call; completed and stopped end a run; created,
// replayed and conflict are a service's view of a write. Failed is any of them going wrong.
export const OUTCOMES = ['refused', 'executed', 'response_lost', 'failed', 'completed', 'stopped', 'created', 'replayed', 'conflict'] as const;
export type Outcome = (typeof OUTCOMES)[number];

// Who started a call: the model, by asking for it, or the agent's code, on its own. The words of requested_by in
// the agent contract.
export const REQUESTERS = ['model', 'agent'] as const;
export type Requester = (typeof REQUESTERS)[number];

export const MAX_ATTRIBUTE_TEXT = 256;

type Rule =
  | { kind: 'text' }
  | { kind: 'one_of'; values: readonly string[] }
  // A whole number of at least min. Unknown (null) is allowed only where it says so, and is left out.
  | { kind: 'whole'; min: number; unknownAllowed: boolean };

const TEXT: Rule = { kind: 'text' };
const TOKENS: Rule = { kind: 'whole', min: 0, unknownAllowed: true };

export const ATTRIBUTE_RULES: Readonly<Record<string, Rule>> = {
  // The inquiry a run serves; the execution; the business operation, the same across repeats; the delivery attempt.
  'lab.inquiry.id': TEXT,
  [RUN_ID_ATTRIBUTE]: TEXT,
  'lab.operation.id': TEXT,
  'lab.attempt': { kind: 'whole', min: 1, unknownAllowed: false },
  'gen_ai.agent.id': TEXT,
  'gen_ai.tool.name': TEXT,
  'lab.requested_by': { kind: 'one_of', values: REQUESTERS },
  'lab.outcome': { kind: 'one_of', values: OUTCOMES },
  'gen_ai.request.model': TEXT,
  'lab.finish_reason': TEXT,
  'gen_ai.usage.input_tokens': TOKENS,
  'gen_ai.usage.output_tokens': TOKENS,
};

export type SpanAttributes = {
  'lab.inquiry.id'?: string;
  'lab.run.id'?: string;
  'lab.operation.id'?: string;
  'lab.attempt'?: number;
  'gen_ai.agent.id'?: string;
  'gen_ai.tool.name'?: string;
  'lab.requested_by'?: Requester;
  'lab.outcome'?: Outcome;
  'gen_ai.request.model'?: string;
  'lab.finish_reason'?: string;
  // null when the count is not known: the attribute is then left out.
  'gen_ai.usage.input_tokens'?: number | null;
  'gen_ai.usage.output_tokens'?: number | null;
};

// Names the attribute and what is wrong with it; never repeats the value.
export class AttributeRefused extends Error {}

function refuse(name: string, why: string): never {
  throw new AttributeRefused(`Span attribute ${JSON.stringify(name.slice(0, MAX_ATTRIBUTE_TEXT))} refused: ${why}`);
}

function checked(name: string, rule: Rule, value: unknown): string | number | undefined {
  switch (rule.kind) {
    case 'text':
      if (typeof value !== 'string') refuse(name, 'it must be text');
      if (value.length === 0 || value.length > MAX_ATTRIBUTE_TEXT) refuse(name, `it must be 1 to ${MAX_ATTRIBUTE_TEXT} characters`);
      return value;
    case 'one_of':
      if (typeof value !== 'string' || !rule.values.includes(value)) refuse(name, `it must be one of ${rule.values.join(', ')}`);
      return value;
    case 'whole':
      if (value === null && rule.unknownAllowed) return undefined;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < rule.min) refuse(name, `it must be a whole number of at least ${rule.min}`);
      return value;
  }
}

// The attributes to record: only declared names, each checked against its rule. A name given as undefined, and an
// unknown token count, are left out. Throws AttributeRefused for anything else, before anything is recorded.
export function checkedAttributes(attributes: unknown): Record<string, string | number> {
  if (attributes === undefined) return {};
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) refuse('(attributes)', 'they must be an object');
  const result: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(attributes)) {
    const rule = Object.hasOwn(ATTRIBUTE_RULES, name) ? ATTRIBUTE_RULES[name] : undefined;
    if (rule === undefined) refuse(name, 'it is not a declared name');
    if (value === undefined) continue;
    const kept = checked(name, rule, value);
    if (kept !== undefined) result[name] = kept;
  }
  return result;
}
