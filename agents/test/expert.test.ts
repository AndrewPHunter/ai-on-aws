// The label expert's invariants ("Always true" in docs/architecture/expert-agent.md), one test each, at its handler,
// through the real Strands loop and its real MCP client, with a scripted model server and a scripted retrieval
// service on loopback. Every label name and passage here is invented.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { z } from 'zod';

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { InboundMessage, InvocationResponse } from '../../shared/agent-contract.ts';
import type { TokenExchange } from '../../shared/token-exchange.ts';
import { EXPERT_SETTINGS } from '../src/expert/settings.ts';
import { handleQuestion } from '../src/expert/strands.ts';
import { CALLER, ask, clock, message, result, say, startMcp, startModel } from './support.ts';
import type { ModelAnswer, ModelRequest, ToolAnswer } from './support.ts';

const LIMITS = { maxTurns: 8, runMs: 60_000, modelMs: 30_000, toolMs: 20_000 };

type Label = { set_id: string; version: number; effective_date: string; source: string; names: string[] };

const label = (name: string, setId: string): Label => ({
  set_id: setId,
  version: 3,
  effective_date: '20240102',
  source: `https://labels.example/${setId}?version=3`,
  names: [name],
});
const EXAMPLAMAB = label('Examplamab', 'set-examplamab');
const INVENTORIN = label('Inventorin', 'set-inventorin');

const passage = (of: Label, n: number, text: string): Record<string, unknown> => ({
  chunk_id: `${of.set_id}/chunk-${n}`,
  text,
  score: 1 / n,
  part: 'body',
  type: 'text',
  section: { number: `2.${n}`, title: `Section ${n}`, path: ['2 DOSAGE', `2.${n} Section ${n}`] },
  label: { set_id: of.set_id, version: of.version, effective_date: of.effective_date, source: of.source },
});

const DOSE = 'The usual adult dose is 20 mg once daily with food. Do not take more than 40 mg in one day.';
const STORAGE = 'Store the vials between 2 and 8 degrees in their carton, away from light.';

// The token the scripted exchange gives for the retrieval service, unless a test scripts another answer.
const EXCHANGED = 'token-for-the-retrieval-service';
const granted: TokenExchange = () => Promise.resolve({ kind: 'token', token: EXCHANGED, expiresAt: new Date('2026-03-01T10:05:00.000Z'), scopes: ['labels:search'] });

type Retrieval = { find?: (drug: string) => ToolAnswer; search?: (setId: string, nth: number) => ToolAnswer; extra?: string; exchange?: TokenExchange };

async function rig(t: TestContext, script: (request: ModelRequest, nth: number) => ModelAnswer, retrieval: Retrieval = {}) {
  const model = await startModel(t, script);
  const labels = [EXAMPLAMAB, INVENTORIN];
  const find = retrieval.find ?? ((drug) => result({ labels: labels.filter((l) => l.names.includes(drug)).map((l) => ({ ...l, kind: 'prescription' })), more_matched: false }));
  const search =
    retrieval.search ??
    ((setId) => result({ set_id: setId, strategy: 'keyword', passages: setId === EXAMPLAMAB.set_id ? [passage(EXAMPLAMAB, 1, DOSE), passage(EXAMPLAMAB, 2, STORAGE)] : [passage(INVENTORIN, 1, STORAGE)] }));
  const service = await startMcp(t, {
    find_labels: { shape: { drug: z.string() }, answer: (args) => find(String(args.drug)) },
    search_label: { shape: { set_id: z.string(), query: z.string(), max_results: z.number().optional() }, answer: (args, nth) => search(String(args.set_id), nth) },
    ...(retrieval.extra ? { [retrieval.extra]: { shape: { set_id: z.string().optional() }, answer: () => result({ deleted: true }) } } : {}),
  });
  const run = async (inbound: InboundMessage = message('msg-1', 'What is the usual adult dose of Examplamab?'), readingAllowance = EXPERT_SETTINGS.search.readingAllowance) =>
    invocationResponseSchema.parse(
      await handleQuestion(
        {
          identity: { id: 'expert-test', implementation: 'Strands' },
          model: model.settings,
          knowledgeMcpUrl: service.url,
          exchange: retrieval.exchange ?? granted,
          now: clock().now,
          limits: LIMITS,
          settings: { ...EXPERT_SETTINGS, search: { ...EXPERT_SETTINGS.search, readingAllowance } },
        },
        inbound,
        CALLER,
      ),
    );
  return { model, service, run };
}

type Statement = { text: string; passages: string[]; quote: string };
const GOOD: Statement = { text: 'The usual adult dose is 20 mg once daily.', passages: ['P1'], quote: 'usual adult dose is 20 mg once daily' };

// Find the label, search it, then each answer in turn.
const findSearchThen =
  (...finals: ModelAnswer[]) =>
  (_request: ModelRequest, nth: number): ModelAnswer =>
    [ask(['find_labels', { drug: 'Examplamab' }]), ask(['search_label', { set_id: EXAMPLAMAB.set_id, query: 'adult dose' }]), ...finals][nth] ?? say('No more.');
const answer = (...statements: Statement[]): ModelAnswer => ask(['answer', { statements }]);

const searches = (calls: Array<{ tool: string }>): number => calls.filter((c) => c.tool === 'search_label').length;

test('expert 1. the agent calls the model, find_labels and search_label, and nothing else', async (t) => {
  const script = (_request: ModelRequest, nth: number): ModelAnswer =>
    [ask(['find_labels', { drug: 'Examplamab' }], ['delete_label', { set_id: EXAMPLAMAB.set_id }]), ask(['search_label', { set_id: EXAMPLAMAB.set_id, query: 'dose' }]), answer(GOOD)][nth] ??
    say('No more.');
  const { service, run } = await rig(t, script, { extra: 'delete_label' });
  const response = await run();
  assert.equal(response.outcome, 'completed');
  assert.deepEqual([...new Set(service.calls.map((c) => c.tool))].sort(), ['find_labels', 'search_label']);
});

test('expert 2. text the model writes reaches the reply only as statements that passed every check', async (t) => {
  const rows: Array<{ name: string; bad: Statement }> = [
    { name: 'a quote not in the passage', bad: { text: 'Zebra: take it with water.', passages: ['P1'], quote: 'take it with a full glass of water' } },
    { name: 'a number not in the passage', bad: { text: 'Zebra: up to 60 mg a day.', passages: ['P1'], quote: 'Do not take more than 40 mg in one day' } },
    { name: 'a statement citing nothing', bad: { text: 'Zebra: no more than 40 mg in one day.', passages: [], quote: 'Do not take more than 40 mg in one day' } },
  ];
  for (const row of rows) {
    const { run } = await rig(t, findSearchThen(answer(GOOD, row.bad), answer(GOOD)));
    const response = await run();
    assert.equal(response.outcome, 'completed', row.name);
    assert.ok(response.reply.includes(GOOD.text), `${row.name}: the passing statement is not in the reply`);
    assert.equal(response.reply.includes('Zebra'), false, `${row.name}: a statement that failed a check reached the reply`);
  }
});

test('expert 3. every citation names the passage the quote was found in, with its label, version, date and page as the service returned them', async (t) => {
  const { run } = await rig(t, findSearchThen(answer({ text: 'Store the vials cold.', passages: ['P1', 'P2'], quote: 'between 2 and 8 degrees in their carton' })));
  const response = await run();
  const found = passage(EXAMPLAMAB, 2, STORAGE);
  assert.deepEqual(
    response.citations.map(({ passage: id, set_id, version, effective_date, source, drug }) => ({ id, set_id, version, effective_date, source, drug })),
    [{ id: found.chunk_id, set_id: EXAMPLAMAB.set_id, version: 3, effective_date: '20240102', source: EXAMPLAMAB.source, drug: 'Examplamab' }],
  );
});

test('expert 4. a search that could not be made is never told to the model and never repeated, an unknown error code included', async (t) => {
  for (const code of ['search_unreachable', 'a_code_no_list_names']) {
    const { model, service, run } = await rig(t, findSearchThen(ask(['search_label', { set_id: EXAMPLAMAB.set_id, query: 'dose again' }])), {
      search: () => result({ error: code, detail: 'The search could not be made.' }, true),
    });
    const response = await run();
    assert.equal(response.outcome, 'failed', code);
    assert.equal(model.requests.length, 2, `${code}: the model was given another turn`);
    assert.equal(searches(service.calls), 1, `${code}: the search was repeated`);
  }
});

test('expert 5. the token the agent got for the retrieval service goes to it on every request, and neither the caller\'s token nor anything else of the message; the model gets the text only', async (t) => {
  const inbound = { id: 'msg-identifier-of-expert-5', received_at: '2026-02-27T07:41:00.000Z', sender: 'sender.of.expert5@clinic.example', text: 'What is the usual adult dose of Examplamab?' };
  const { model, service, run } = await rig(t, findSearchThen(answer(GOOD)));
  await run(inbound);
  assert.ok(service.requests.length > 0);
  const hidden = [inbound.id, inbound.received_at, inbound.sender];
  for (const request of service.requests) {
    assert.equal(request.headers.authorization, `Bearer ${EXCHANGED}`);
    const sent = JSON.stringify(request);
    assert.deepEqual([...hidden, CALLER.token].filter((value) => sent.includes(value)), [], 'the caller\'s token or part of the message went to the retrieval service');
  }
  for (const request of model.requests) {
    assert.ok(request.user.includes(inbound.text));
    assert.deepEqual([...hidden, CALLER.token].filter((value) => request.body.includes(value)), [], 'the model was given more than the text');
  }
});

test('expert 6. no passage is cut: it is shown whole or named as not shown', async (t) => {
  const { model, run } = await rig(t, findSearchThen(answer(GOOD)));
  await run(undefined, DOSE.length + 40);
  const shown = model.requests[2]?.outputs.at(-1)?.output ?? '';
  for (const text of [DOSE, STORAGE]) {
    const whole = shown.includes(text);
    const anyPart = [text.slice(0, 20), text.slice(30, 50), text.slice(-20)].some((part) => shown.includes(part));
    assert.equal(anyPart, whole, `part of a passage was shown: ${text.slice(0, 20)}`);
  }
  assert.deepEqual([shown.includes(DOSE), shown.includes(STORAGE)], [true, false], 'the allowance was not what this test needs');
});

test('expert 7. runs share no state', async (t) => {
  const script = (request: ModelRequest, nth: number): ModelAnswer => {
    const [drug, statement]: [Label, Statement] = request.user.includes('Inventorin')
      ? [INVENTORIN, { text: 'Inventorin is stored cold.', passages: ['P1'], quote: 'between 2 and 8 degrees' }]
      : [EXAMPLAMAB, GOOD];
    const steps = [ask(['find_labels', { drug: drug.names[0] }]), ask(['search_label', { set_id: drug.set_id, query: 'question' }]), answer(statement)];
    return steps[nth] ?? say('No more.');
  };
  const { run } = await rig(t, script);
  const [one, two] = await Promise.all([run(message('msg-1', 'What is the usual adult dose of Examplamab?')), run(message('msg-2', 'How is Inventorin stored?'))]);
  const holds = (response: InvocationResponse, of: Label): boolean => JSON.stringify(response).includes(of.set_id);
  assert.deepEqual([holds(one, EXAMPLAMAB), holds(one, INVENTORIN), holds(two, INVENTORIN), holds(two, EXAMPLAMAB)], [true, false, true, false]);
  assert.deepEqual([one.citations.length, two.citations.length], [1, 1]);
});

test('expert 8. whatever goes wrong, the run ends inside the contract, and nothing the model wrote that did not pass the checks is in the reply', async (t) => {
  const unchecked = 'Zebra: take as much as you like.';
  const bad: Statement = { text: unchecked, passages: ['P1'], quote: 'take as much as you like' };
  const refused: TokenExchange = () => Promise.resolve({ kind: 'refused', reason: 'provider_refused', detail: 'The identity provider refused the token exchange.' });
  const rows: Array<{ name: string; script: (request: ModelRequest, nth: number) => ModelAnswer; exchange?: TokenExchange }> = [
    { name: 'the exchange is refused', script: findSearchThen(answer(GOOD)), exchange: refused },
    { name: 'the model never calls a final tool', script: findSearchThen(say(unchecked)) },
    { name: 'the model server fails', script: (request, nth) => (nth < 2 ? findSearchThen()(request, nth) : { kind: 'status', status: 400 }) },
    { name: 'the answer never passes', script: findSearchThen(answer(bad), answer(bad), answer(bad)) },
  ];
  for (const row of rows) {
    const { model, run } = await rig(t, row.script, { exchange: row.exchange });
    const response = await run();
    assert.notEqual(response.outcome, 'completed', row.name);
    if (row.exchange) assert.deepEqual([response.outcome, model.requests.length], ['failed', 0], `${row.name}: the run did not fail before the model was asked`);
    assert.equal(JSON.stringify({ reply: response.reply, stop: response.stop_reason, citations: response.citations }).includes('Zebra'), false, row.name);
  }
});
