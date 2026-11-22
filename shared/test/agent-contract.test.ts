// C1 to C3: what the agent contract accepts and refuses, now that it carries citation sources, label_answer and
// retrieval hits; and that a response stored before those existed still parses.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { invocationResponseSchema, stepSchema } from '../agent-contract.ts';

// A response exactly as an intake agent returned it, and the client stored it, at 2433db2: no label_answer,
// no citations, and steps of kinds model, tool and error. Literal JSON, so a change to the schema cannot change it.
const STORED_AT_2433DB2 = `{
  "agent": { "id": "intake-handwritten", "implementation": "hand-written loop" },
  "outcome": "completed",
  "stop_reason": null,
  "reply": "Thank you. We have opened case AE-000001 and a pharmacist will contact you.",
  "citations": [],
  "case_actions": [{ "kind": "case_opened", "case_id": "AE-000001", "status": "awaiting_review" }],
  "steps": [
    {
      "kind": "model",
      "started_at": "2026-03-01T09:00:00.100Z",
      "duration_ms": 812,
      "model": "qwen3.5-9b",
      "finish_reason": "tool_calls",
      "text": null,
      "tool_calls": [{ "name": "create_case", "arguments": { "suspect_drug": "examplamab", "event": "rash" } }],
      "input_tokens": 1180,
      "output_tokens": 64
    },
    {
      "kind": "tool",
      "started_at": "2026-03-01T09:00:00.920Z",
      "duration_ms": 41,
      "tool": "create_case",
      "requested_by": "model",
      "arguments": { "suspect_drug": "examplamab", "event": "rash" },
      "result": { "case_id": "AE-000001", "status": "awaiting_review" },
      "is_error": false
    },
    {
      "kind": "error",
      "started_at": "2026-03-01T09:00:00.970Z",
      "duration_ms": 0,
      "message": "The model server answered with status 503."
    }
  ]
}`;

const CITATION = {
  drug: 'Examplamab, examplamab sodium',
  section: '2.1 Invented dosing',
  quote: 'Invented quoted passage.',
  set_id: '00000000-0000-4000-8000-0000000000a1',
  version: 3,
  effective_date: '20260130',
  source: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00000000-0000-4000-8000-0000000000a1&version=3',
  passage: '00000000-0000-4000-8000-0000000000a1/3/sec-1/body/1',
};

const answering = (overrides: Record<string, unknown> = {}, citation: Record<string, unknown> = CITATION): unknown => ({
  ...(JSON.parse(STORED_AT_2433DB2) as Record<string, unknown>),
  case_actions: [],
  label_answer: 'answered',
  citations: [citation],
  ...overrides,
});

test('C1. a response exactly as stored at 2433db2 parses', () => {
  const parsed = invocationResponseSchema.safeParse(JSON.parse(STORED_AT_2433DB2));
  assert.ok(parsed.success, parsed.success ? '' : parsed.error.message);
  assert.equal(parsed.data.label_answer, undefined);
});

test('C2. a response with label_answer and a full citation parses', () => {
  const parsed = invocationResponseSchema.safeParse(answering());
  assert.ok(parsed.success, parsed.success ? '' : parsed.error.message);
  assert.equal(parsed.data.label_answer, 'answered');
  assert.deepEqual(parsed.data.citations, [CITATION]);
});

const { source: _source, ...withoutSource } = CITATION;
const refused: { name: string; response: unknown }[] = [
  { name: 'a citation with no source', response: answering({}, withoutSource) },
  { name: 'a source not starting https://', response: answering({}, { ...CITATION, source: 'http://dailymed.nlm.nih.gov/x' }) },
  { name: 'version 0', response: answering({}, { ...CITATION, version: 0 }) },
  { name: 'an effective date of 7 digits', response: answering({}, { ...CITATION, effective_date: '2026013' }) },
  { name: 'an unknown label_answer value', response: answering({ label_answer: 'maybe' }) },
];

for (const row of refused) {
  test(`C2. refused: ${row.name}`, () => {
    assert.equal(invocationResponseSchema.safeParse(row.response).success, false);
  });
}

const HIT = {
  drug: 'Examplamab',
  section: '2.1 Invented dosing',
  score: 7.25,
  excerpt: 'Invented excerpt.',
  passage: '00000000-0000-4000-8000-0000000000a1/3/sec-1/body/1',
  handle: 'P1',
  shown: true,
};

const retrieval = (hit: Record<string, unknown>): unknown => ({
  kind: 'retrieval',
  started_at: '2026-03-01T09:00:00.100Z',
  duration_ms: 12,
  query: 'invented dosing',
  strategy: 'bm25',
  hits: [hit],
});

test('C3. a retrieval hit with passage, handle and shown parses', () => {
  assert.ok(stepSchema.safeParse(retrieval(HIT)).success);
  assert.ok(stepSchema.safeParse(retrieval({ ...HIT, shown: false })).success);
});

for (const field of ['shown', 'handle', 'passage'] as const) {
  test(`C3. a retrieval hit without ${field} is refused`, () => {
    const hit: Record<string, unknown> = { ...HIT };
    delete hit[field];
    assert.equal(stepSchema.safeParse(retrieval(hit)).success, false);
  });
}
