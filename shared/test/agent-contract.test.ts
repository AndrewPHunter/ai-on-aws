// The agent contract's invariant 5 ("Always true" in shared/README.md). Every value here is invented.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { invocationRequestSchema, invocationResponseSchema } from '../agent-contract.ts';

const AT = { started_at: '2026-03-01T09:00:00.100Z', duration_ms: 12 };
const REQUEST = { message: { id: 'msg-1', received_at: '2026-03-01T09:00:00.000Z', sender: 'Dr A. Rivera', text: 'Invented question.' } };
const CITATION = { drug: 'Examplamab', section: '2.1 Invented', quote: 'Invented quote.', set_id: 'set-1', version: 3, effective_date: '20260130', source: 'https://labels.example/set-1', passage: 'set-1/3/1' };
const HIT = { drug: 'Examplamab', section: '2.1 Invented', score: 7.25, excerpt: 'Invented excerpt.', passage: 'set-1/3/1', handle: 'P1', shown: true };
const RESPONSE = {
  agent: { id: 'expert', implementation: 'Strands' },
  outcome: 'completed',
  stop_reason: null,
  reply: 'Invented reply.',
  citations: [CITATION],
  label_answer: 'answered',
  case_actions: [{ kind: 'case_opened', case_id: 'AE-000001', status: 'awaiting_review' }],
  steps: [
    { kind: 'model', ...AT, model: 'm', finish_reason: 'stop', text: null, tool_calls: [], input_tokens: 1, output_tokens: null },
    { kind: 'tool', ...AT, tool: 'create_case', requested_by: 'model', arguments: {}, result: {}, is_error: false },
    { kind: 'retrieval', ...AT, query: 'invented', strategy: 'keyword', hits: [HIT] },
    { kind: 'error', ...AT, message: 'Invented failure.' },
  ],
};
const { label_answer: _answer, ...BEFORE_LABEL_ANSWER } = RESPONSE;
const { sender: _sender, ...withoutSender } = REQUEST.message;
const { source: _source, ...withoutSource } = CITATION;
const { handle: _handle, ...withoutHandle } = HIT;
const citing = (citation: object): object => ({ ...RESPONSE, citations: [citation] });

const ROWS: { name: string; schema: typeof invocationRequestSchema | typeof invocationResponseSchema; value: object; inside: boolean }[] = [
  { name: 'a request', schema: invocationRequestSchema, value: REQUEST, inside: true },
  { name: 'a request with no sender', schema: invocationRequestSchema, value: { message: withoutSender }, inside: false },
  { name: 'a response', schema: invocationResponseSchema, value: RESPONSE, inside: true },
  { name: 'a response with no label_answer', schema: invocationResponseSchema, value: BEFORE_LABEL_ANSWER, inside: true },
  { name: 'a citation with no source', schema: invocationResponseSchema, value: citing(withoutSource), inside: false },
  { name: 'a source not starting https://', schema: invocationResponseSchema, value: citing({ ...CITATION, source: 'http://labels.example/set-1' }), inside: false },
  { name: 'version 0', schema: invocationResponseSchema, value: citing({ ...CITATION, version: 0 }), inside: false },
  { name: 'an effective date of 7 digits', schema: invocationResponseSchema, value: citing({ ...CITATION, effective_date: '2026013' }), inside: false },
  { name: 'an unknown label_answer', schema: invocationResponseSchema, value: { ...RESPONSE, label_answer: 'maybe' }, inside: false },
  { name: 'a retrieval hit with no handle', schema: invocationResponseSchema, value: { ...RESPONSE, steps: [{ ...RESPONSE.steps[2], hits: [withoutHandle] }] }, inside: false },
];

test('shared 5. a request or response outside the schema is refused, and one inside it is returned unchanged', () => {
  for (const row of ROWS) {
    const parsed = row.schema.safeParse(row.value);
    assert.equal(parsed.success, row.inside, row.name);
    if (parsed.success) assert.deepEqual(parsed.data, row.value, row.name);
  }
});
