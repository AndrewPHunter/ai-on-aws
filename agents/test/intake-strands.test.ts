// The intake agent on Strands: five probes that its hooks are wired to the rules the hand-written agent's tests
// already show (docs/architecture/intake-agent-strands.md, "Where each rule is applied"). Through the real Strands
// loop and its real MCP client, at the handler, with a scripted model server and a scripted case system on
// loopback.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { z } from 'zod';

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { InvocationResponse } from '../../shared/agent-contract.ts';
import type { TokenExchange } from '../../shared/token-exchange.ts';
import { handleInquiry } from '../src/intake/strands.ts';
import { CALLER, ask, clock, message, result, say, startMcp, startModel } from './support.ts';
import type { ModelAnswer, ModelRequest, ToolAnswer } from './support.ts';

// Limits no busy machine reaches: the model's and the tools' time limits are kept in real time by their clients.
const LIMITS = { maxTurns: 6, runMs: 60_000, modelMs: 30_000, toolMs: 20_000 };
const optional = z.string().optional();
const CASE_FIELDS = { case_id: optional, patient: optional, suspect_drug: optional, event: optional };
const exchange: TokenExchange = () => Promise.resolve({ kind: 'token', token: 'token-for-the-case-system', expiresAt: new Date('2026-03-01T10:05:00.000Z'), scopes: ['cases:write'] });
const createdAs = (caseId: string): ToolAnswer => result({ outcome: 'created', case: { case_id: caseId, status: 'incomplete' } });

async function rig(t: TestContext, script: (request: ModelRequest, nth: number) => ModelAnswer, create: (nth: number) => ToolAnswer = () => createdAs('C-7')) {
  const model = await startModel(t, script);
  const cases = await startMcp(t, {
    create_case: { shape: CASE_FIELDS, answer: (_args, nth) => create(nth) },
    add_follow_up: { shape: CASE_FIELDS, answer: () => result({ outcome: 'recorded', case: { case_id: 'C-7', status: 'incomplete' } }) },
  });
  const run = async (limits: Partial<typeof LIMITS> = {}): Promise<InvocationResponse> =>
    invocationResponseSchema.parse(
      await handleInquiry(
        { identity: { id: 'intake-strands-test', implementation: 'Strands' }, model: model.settings, caseMcpUrl: cases.url, exchange, now: clock().now, limits: { ...LIMITS, ...limits } },
        message('msg-1', 'Patient JD had a rash after Examplamab.'),
        CALLER,
      ),
    );
  return { model, cases, run };
}

const creates = (calls: Array<{ tool: string }>): number => calls.filter((c) => c.tool === 'create_case').length;

test('strands 1. an inquiry through the Strands loop and its MCP client: a case action from the tool\'s answer, and its steps', async (t) => {
  const { cases, run } = await rig(t, (_request, nth) => (nth === 0 ? ask(['create_case', { event: 'rash' }]) : say('Recorded as case C-MODEL.')));
  const response = await run();
  assert.equal(response.outcome, 'completed');
  assert.deepEqual(response.case_actions, [{ kind: 'case_opened', case_id: 'C-7', status: 'incomplete' }]);
  assert.deepEqual(
    response.steps.map((s) => s.kind),
    ['model', 'tool', 'model'],
  );
  assert.deepEqual(
    [...new Set(cases.requests.map((r) => r.headers.authorization))],
    ['Bearer token-for-the-case-system'],
    'a request to the case system carried another token than the exchanged one',
  );
});

test('strands 2. a call the rules refuse does not reach the MCP server', async (t) => {
  const { model, cases, run } = await rig(t, (_request, nth) =>
    nth === 0 ? ask(['create_case', { event: 'rash' }], ['create_case', { event: 'rash again' }]) : say('Recorded.'),
  );
  await run();
  assert.equal(creates(cases.calls), 1);
  const told = model.requests[1]?.outputs ?? [];
  assert.equal(told.length, 2, 'the model was not told about both calls');
});

test('strands 3. a write with no answer is repeated once, by code, with the same content', async (t) => {
  const { model, cases, run } = await rig(
    t,
    (_request, nth) => (nth === 0 ? ask(['create_case', { event: 'rash' }]) : say('Recorded.')),
    (nth) => (nth === 0 ? 'drop' : createdAs('C-7')),
  );
  const response = await run();
  assert.equal(creates(cases.calls), 2);
  assert.deepEqual(cases.calls[0], cases.calls[1]);
  assert.equal(model.requests.length, 2, 'the model was asked between the two calls, or asked to repeat');
  assert.deepEqual(response.case_actions.map((a) => a.case_id), ['C-7']);
});

test('strands 4. the turn limit ends the run with an outcome inside the contract', async (t) => {
  const { model, run } = await rig(t, (_request, nth) => (nth < 3 ? ask(['add_follow_up', { case_id: 'C-7', event: 'rash' }]) : say('Nothing to record.')));
  const response = await run({ maxTurns: 2 });
  assert.equal(response.outcome, 'stopped');
  assert.equal(model.requests.length, 2);
});

test('strands 5. a model server that fails ends the run failed, with a step, not an exception', async (t) => {
  const { run } = await rig(t, () => ({ kind: 'status', status: 400 }));
  const response = await run();
  assert.equal(response.outcome, 'failed');
  assert.equal(response.steps.filter((s) => s.kind === 'error').length, 1);
});
