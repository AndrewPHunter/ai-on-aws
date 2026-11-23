// The hand-written intake agent's invariants ("Always true" in docs/architecture/intake-agent-handwritten.md),
// one test each, at its handler, with every dependency a value and nothing on the network. The model and the
// case system's tools are scripted in memory; each keeps to its contract and reports a failure as a value.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { InboundMessage, InvocationResponse } from '../../shared/agent-contract.ts';
import { handleInquiry } from '../src/intake/handwritten.ts';
import { createReportCheck } from '../src/intake/report-check.ts';
import type { Finding } from '../src/intake/report-check.ts';
import { STOPPED_CHECK_NOT_MADE, STOPPED_FOUND_NOT_RECORDED, TOLD_ONCE } from '../src/intake/run.ts';
import { LIMITS } from '../src/intake/settings.ts';
import type { ChatMessage, ChatResult, ToolDefinition } from '../src/model/chat.ts';
import type { ToolOutcome } from '../src/tools/tool-set.ts';
import { CALLER, clock, message, prop } from './support.ts';
import type { Clock } from './support.ts';

const IDENTITY = { id: 'intake-test', implementation: 'hand-written loop' };

const definition = (name: string): ToolDefinition => ({
  type: 'function',
  function: { name, description: `The case system's ${name}.`, parameters: { type: 'object', properties: { case_id: { type: 'string' }, event: { type: 'string' } } } },
});
const DEFINITIONS: ToolDefinition[] = ['create_case', 'add_follow_up'].map(definition);
// A case system configured to offer a lookup as well.
const WITH_LOOKUP: ToolDefinition[] = ['create_case', 'find_case', 'add_follow_up'].map(definition);

type Script = (messages: ChatMessage[], nth: number) => ChatResult;
type Tools = (tool: string, args: Record<string, unknown>, nth: number) => ToolOutcome;

type World = {
  // What happened, in order: "model" for each request to the model, the tool's name for each call made.
  events: string[];
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  requests: Array<{ messages: ChatMessage[]; tools: ToolDefinition[] }>;
  connected: Array<{ message: InboundMessage; token: string }>;
  checks: number;
};

let callIds = 0;

const say = (content: string): ChatResult => ({
  ok: true,
  completion: { content, toolCalls: [], finishReason: 'stop', inputTokens: 1, outputTokens: 1 },
});
const ask = (...calls: Array<[name: string, args: unknown]>): ChatResult => ({
  ok: true,
  completion: {
    content: null,
    toolCalls: calls.map(([name, args]) => ({
      id: `call-${++callIds}`,
      type: 'function',
      function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
    })),
    finishReason: 'tool_calls',
    inputTokens: 1,
    outputTokens: 1,
  },
});
const modelFails = (retryable: boolean): ChatResult => ({ ok: false, reason: 'The model could not be asked.', retryable });
const answered = (payload: unknown): ToolOutcome => ({ kind: 'answered', isError: false, payload });
const noAnswer: ToolOutcome = { kind: 'no_answer', reason: 'Nothing came back.' };
const created = (caseId: string): ToolOutcome => answered({ outcome: 'created', case: { case_id: caseId, status: 'incomplete' } });
const followedUp = (caseId: string): ToolOutcome => answered({ outcome: 'recorded', case: { case_id: caseId, status: 'incomplete' } });
// A follow-up to a case an earlier message opened, named by its id.
const followUp = (event: string): [string, unknown] => ['add_follow_up', { case_id: 'C-9', event }];

// The handler with scripted dependencies. The model's script is asked per conversation (by its user turn), so two
// runs on the same dependencies each follow their own.
function rig(script: Script, tools: Tools = (tool) => (tool === 'create_case' ? created('C-1') : followedUp('C-9')), options: { connect?: 'refused' | 'short' | 'lookup'; clock?: Clock; check?: Finding; failure?: string } = {}) {
  const time = options.clock ?? clock();
  const world: World = { events: [], calls: [], requests: [], connected: [], checks: 0 };
  const seen = new Map<string, number>();
  const counts = new Map<string, number>();
  const run = (inbound: InboundMessage = message('msg-1', 'Patient JD had a rash after Examplamab.')): Promise<InvocationResponse> =>
    handleInquiry(
      {
        identity: IDENTITY,
        model: {
          id: 'scripted',
          complete(messages, offered) {
            world.events.push('model');
            world.requests.push({ messages: structuredClone(messages), tools: structuredClone(offered) });
            const key = messages.find((m) => m.role === 'user')?.content ?? '';
            const nth = seen.get(key) ?? 0;
            seen.set(key, nth + 1);
            return Promise.resolve(script(messages, nth));
          },
        },
        connectTools(connectedMessage, token) {
          world.connected.push({ message: connectedMessage, token });
          if (options.connect === 'refused') return Promise.resolve({ ok: false, reason: 'The case system refused the caller.' });
          return Promise.resolve({
            ok: true,
            tools: {
              definitions: structuredClone(options.connect === 'short' ? DEFINITIONS.slice(0, 1) : options.connect === 'lookup' ? WITH_LOOKUP : DEFINITIONS),
              call(tool, args) {
                world.events.push(tool);
                world.calls.push({ tool, args });
                const nth = counts.get(tool) ?? 0;
                counts.set(tool, nth + 1);
                return Promise.resolve(tools(tool, args, nth));
              },
              close: () => Promise.resolve(),
            },
          });
        },
        now: time.now,
        sleep: (ms) => {
          time.advance(ms);
          return Promise.resolve();
        },
        random: () => 0.5,
        reportCheck: () => Promise.resolve((world.checks++, { finding: options.check ?? 'none', failure: options.failure })),
        limits: LIMITS,
      },
      inbound,
      CALLER,
    );
  return { world, run };
}

// The script as a list of answers, one per turn.
const turns =
  (...answers: ChatResult[]): Script =>
  (_messages, nth) =>
    answers[nth] ?? say('Done.');

const toolMessages = (messages: ChatMessage[]): Array<{ id: string; content: string }> =>
  messages.flatMap((m) => (m.role === 'tool' ? [{ id: m.tool_call_id, content: m.content }] : []));

const callIdsOf = (result: ChatResult): string[] => (result.ok ? result.completion.toolCalls.map((c) => c.id) : []);

const writes = (world: World): number => world.calls.filter((c) => c.tool === 'create_case' || c.tool === 'add_follow_up').length;

test('intake 1. once a message is accepted, whatever goes wrong, the handler returns a response inside the contract with an outcome and its steps', async () => {
  const rows: Array<{ name: string; rig: ReturnType<typeof rig>; failsBeforeModel?: true }> = [
    { name: 'tools cannot be connected', rig: rig(turns(), undefined, { connect: 'refused' }), failsBeforeModel: true },
    { name: 'the case system offers one of the two tools', rig: rig(turns(), undefined, { connect: 'short' }), failsBeforeModel: true },
    { name: 'the model fails', rig: rig(() => modelFails(false)) },
    { name: 'the model answers nonsense', rig: rig(turns(ask(['no_such_tool', {}], ['create_case', '{not json'], ['add_follow_up', '[1, 2]']), say(''))) },
    { name: 'a tool gives no answer', rig: rig(turns(ask(followUp('a'))), () => noAnswer) },
    { name: 'a limit is reached', rig: rig(() => ask(followUp('a'))) },
  ];
  for (const row of rows) {
    const response = await row.rig.run();
    const parsed = invocationResponseSchema.safeParse(response);
    assert.ok(parsed.success, `${row.name}: the response is outside the contract`);
    assert.ok(response.steps.length > 0, `${row.name}: no steps`);
    if (row.failsBeforeModel) assert.deepEqual([response.outcome, row.rig.world.events.includes('model')], ['failed', false], `${row.name}: the model was asked`);
  }
});

test('intake 2. a call the agent refuses never reaches the case system, and the model is told it was refused', async () => {
  const rows: Array<{ name: string; refused: ChatResult; before?: ChatResult }> = [
    { name: 'a tool that does not exist', refused: ask(['delete_case', { case_id: 'C-1' }]) },
    { name: 'arguments that are not JSON', refused: ask(['create_case', '{"event": ']) },
    { name: 'a second create_case', before: ask(['create_case', { event: 'rash' }]), refused: ask(['create_case', { event: 'rash again' }]) },
  ];
  for (const row of rows) {
    const { world, run } = rig(turns(...(row.before ? [row.before] : []), row.refused));
    await run();
    const tools = row.before ? 1 : 0;
    assert.equal(world.calls.length, tools, `${row.name}: the refused call reached the case system`);
    const [refusedId] = callIdsOf(row.refused);
    const told = toolMessages(world.requests[tools + 1]?.messages ?? []).find((m) => m.id === refusedId);
    assert.ok(told, `${row.name}: the model was not told`);
    assert.equal(typeof prop(JSON.parse(told.content), 'error'), 'string', `${row.name}: what the model was told is not a refusal`);
  }
});

test('intake 3. the message and the caller\'s token reach the tool connection from code, and nothing shown to the model can supply them', async () => {
  const inbound = message('msg-identifier-set-by-the-front-door', 'Patient JD had a rash after Examplamab.');
  const { world, run } = rig(turns(ask(['create_case', { event: 'rash' }])));
  await run(inbound);
  assert.deepEqual(world.connected, [{ message: inbound, token: CALLER.token }]);
  for (const request of world.requests) {
    assert.deepEqual(request.tools, DEFINITIONS, 'the model was offered tools other than the case system\'s own');
    const sent = JSON.stringify(request.messages);
    assert.equal(sent.includes(inbound.id), false, 'the message identifier was shown to the model');
    assert.equal(sent.includes(CALLER.token), false, 'the token was shown to the model');
  }
});

test('intake 4. a run opens at most one case for its message and adds no version to that case', async () => {
  const rows: Array<{ name: string; script: Script }> = [
    { name: 'create twice in one turn', script: turns(ask(['create_case', { event: 'a' }], ['create_case', { event: 'b' }])) },
    { name: 'create, then follow up on that case', script: turns(ask(['create_case', { event: 'a' }]), ask(['add_follow_up', { case_id: 'C-1', event: 'b' }])) },
    { name: 'follow up on the case the message names', script: turns(ask(followUp('b'))) },
  ];
  for (const row of rows) {
    const { world, run } = rig(row.script);
    const response = await run();
    assert.equal(writes(world), 1, `${row.name}: more than one write reached the case system`);
    assert.equal(response.case_actions.length, 1, row.name);
  }
});

test('intake 5. the agent has no lookup: a lookup the case system offers is not shown to the model, and a call to it is refused and never reaches the case system', async () => {
  const lookup = ask(['find_case', { patient: 'JD' }]);
  const { world, run } = rig(turns(lookup), undefined, { connect: 'lookup' });
  await run();
  assert.ok(world.requests.length > 1, 'the model was not asked again after the lookup');
  for (const request of world.requests) assert.deepEqual(request.tools, DEFINITIONS, 'the model was shown a tool other than the two');
  assert.deepEqual(world.calls, [], 'the lookup reached the case system');
  const [lookupId] = callIdsOf(lookup);
  const told = toolMessages(world.requests[1]?.messages ?? []).find((m) => m.id === lookupId);
  assert.ok(told, 'the model was not told');
  assert.equal(typeof prop(JSON.parse(told.content), 'error'), 'string', 'what the model was told is not a refusal');
});

test('intake 6. a write that got no answer is repeated once, by code, with identical content, and the model is not asked to repeat it', async () => {
  const { world, run } = rig(turns(ask(['create_case', { event: 'rash' }])), (tool, _args, nth) => (nth === 0 ? noAnswer : created('C-1')));
  await run();
  assert.deepEqual(world.events, ['model', 'create_case', 'create_case', 'model']);
  assert.deepEqual(world.calls[0], world.calls[1]);
});

test('intake 7. if it is not known whether a write happened, the run fails and carries no reply', async () => {
  const { world, run } = rig(turns(ask(['create_case', { event: 'rash' }]), say('Recorded as case C-1.')), () => noAnswer);
  const response = await run();
  assert.equal(response.outcome, 'failed');
  assert.equal(response.reply, '');
  assert.equal(world.calls.length, 2);
});

test('intake 8. every tool the model asks for gets exactly one tool message back, in the order asked', async () => {
  const many = ask(followUp('a'), ['no_such_tool', {}], followUp('b'), ['create_case', '{oops'], ['create_case', { event: 'c' }]);
  const { world, run } = rig(turns(many), (tool, _args, nth) => (tool === 'add_follow_up' && nth === 1 ? noAnswer : tool === 'create_case' ? created('C-1') : followedUp('C-9')));
  await run();
  const next = world.requests[1]?.messages ?? [];
  assert.deepEqual(toolMessages(next).map((m) => m.id), callIdsOf(many));
});

test('intake 9. every model turn, tool call, refusal and failed request to the model is a step in the response', async () => {
  const { run } = rig((_messages, nth) => [modelFails(true), ask(followUp('a'), ['no_such_tool', {}])][nth] ?? say('Nothing to record.'));
  const response = await run();
  const count = (predicate: (step: InvocationResponse['steps'][number]) => boolean): number => response.steps.filter(predicate).length;
  assert.equal(count((s) => s.kind === 'error'), 1, 'the failed request');
  assert.equal(count((s) => s.kind === 'model'), 2, 'the two model turns');
  assert.equal(count((s) => s.kind === 'tool' && s.tool === 'add_follow_up' && !s.is_error), 1, 'the tool call');
  assert.equal(count((s) => s.kind === 'tool' && s.tool === 'no_such_tool' && s.is_error), 1, 'the refusal');
});

test('intake 10. case actions are built from the case system\'s answers, never from what the model wrote', async () => {
  const { run } = rig(turns(ask(['create_case', { event: 'rash', case_id: 'C-MODEL' }]), say('Recorded as case C-MODEL.')), () => created('C-SYSTEM'));
  const response = await run();
  assert.deepEqual(response.case_actions.map((a) => a.case_id), ['C-SYSTEM']);
});

test('intake 11. at most 6 turns with the model, at most 3 requests for each, and no turn started after 150 seconds', async () => {
  assert.deepEqual([LIMITS.maxTurns, LIMITS.runMs], [6, 150_000]);
  const time = clock();
  const rows: Array<{ name: string; rig: ReturnType<typeof rig>; requests: number }> = [
    { name: 'a model that always asks for a tool', rig: rig(() => ask(followUp('a'))), requests: 6 },
    { name: 'a model whose every request fails', rig: rig(() => modelFails(true)), requests: 3 },
    {
      name: 'a tool call that ends after 150 s',
      rig: rig(
        () => ask(followUp('a')),
        () => {
          time.advance(150_000);
          return followedUp('C-9');
        },
        { clock: time },
      ),
      requests: 1,
    },
  ];
  for (const row of rows) {
    const response = await row.rig.run();
    assert.equal(row.rig.world.events.filter((e) => e === 'model').length, row.requests, row.name);
    assert.notEqual(response.outcome, 'completed', row.name);
  }
});

test('intake 12. the response contains no token given to the dependencies, whatever fails', async () => {
  const rows = [
    rig(turns(), undefined, { connect: 'refused' }),
    rig(() => modelFails(true)),
    rig(turns(ask(['create_case', { event: 'rash' }])), () => noAnswer),
  ];
  for (const row of rows) {
    const response = await row.run();
    assert.equal(JSON.stringify(response).includes(CALLER.token), false);
  }
});

test('intake 13. runs share no state', async () => {
  const one = message('msg-one', 'First message: Patient AB had a headache after Examplamab.');
  const two = message('msg-two', 'Second message: Patient CD had a fever after Inventorin.');
  const { run } = rig(
    (messages, nth) => {
      const first = (messages.find((m) => m.role === 'user')?.content ?? '').includes('First');
      return nth === 0 ? ask(['create_case', { event: first ? 'headache' : 'fever' }]) : say('Recorded.');
    },
    (_tool, args) => created(args.event === 'headache' ? 'C-ONE' : 'C-TWO'),
  );
  const [first, second] = await Promise.all([run(one), run(two)]);
  const a = JSON.stringify(first);
  const b = JSON.stringify(second);
  assert.deepEqual([a.includes('C-ONE'), a.includes('C-TWO'), a.includes(two.text)], [true, false, false]);
  assert.deepEqual([b.includes('C-TWO'), b.includes('C-ONE'), b.includes(one.text)], [true, false, false]);
});

test('intake 14. a run that recorded no case ends completed only when the report check found no adverse event', async () => {
  const create = ask(['create_case', { event: 'rash' }]);
  const declined = say('Not a report, as the sender asks.');
  const rows: Array<{ name: string; script: Script; check: Finding; failure?: string; outcome: string; reason: string | null; checks: number; cases: number; told: boolean }> = [
    { name: 'found nothing', script: turns(declined), check: 'none', outcome: 'completed', reason: null, checks: 1, cases: 0, told: false },
    { name: 'found one, then recorded', script: turns(declined, create), check: 'adverse_event', outcome: 'completed', reason: null, checks: 1, cases: 1, told: true },
    { name: 'found one, recorded nothing again', script: () => declined, check: 'adverse_event', outcome: 'stopped', reason: STOPPED_FOUND_NOT_RECORDED, checks: 1, cases: 0, told: true },
    { name: 'could not be made', script: turns(declined), check: 'unknown', outcome: 'stopped', reason: STOPPED_CHECK_NOT_MADE, checks: 1, cases: 0, told: false },
    { name: 'its request failed', script: turns(declined), check: 'unknown', failure: 'The model could not be reached.', outcome: 'stopped', reason: STOPPED_CHECK_NOT_MADE, checks: 1, cases: 0, told: false },
    { name: 'found one on the last turn', script: (_m, nth) => (nth < 5 ? ask(['no_such_tool', {}]) : declined), check: 'adverse_event', outcome: 'stopped', reason: STOPPED_FOUND_NOT_RECORDED, checks: 1, cases: 0, told: false },
    { name: 'a case recorded', script: turns(create), check: 'adverse_event', outcome: 'completed', reason: null, checks: 0, cases: 1, told: false },
  ];
  for (const row of rows) {
    const { world, run } = rig(row.script, undefined, { check: row.check, failure: row.failure });
    const response = await run();
    const told = world.requests.some((r) => r.messages.some((m) => m.role === 'user' && m.content === TOLD_ONCE));
    const steps = response.steps.filter((s) => s.kind === 'report_check').length;
    const errors = response.steps.filter((s) => s.kind === 'error' && s.message === row.failure).length;
    assert.deepEqual([response.outcome, response.stop_reason, world.checks, steps, response.case_actions.length, told, errors], [row.outcome, row.reason, row.checks, row.checks, row.cases, row.told, row.failure ? 1 : 0], row.name);
  }
  // The check itself: two messages, the message's text alone in its tags, no tools; yes, no, anything else; a failure.
  const sent: Array<{ messages: ChatMessage[]; tools: ToolDefinition[] }> = [];
  const answers = ['Yes.', ' no ', 'Maybe so.'];
  const check = createReportCheck({ id: 'scripted', complete: (messages, tools) => (sent.push({ messages, tools }), Promise.resolve(say(answers[sent.length - 1] ?? ''))) });
  const asked = message('msg-1', 'Patient JD had a rash.');
  const findings = [await check(asked, 1_000), await check(asked, 1_000), await check(asked, 1_000)].map((made) => made.finding);
  assert.deepEqual([findings, sent[0]?.messages.length, sent[0]?.messages[1]?.content, sent[0]?.tools], [['adverse_event', 'none', 'unknown'], 2, `<message>\n${asked.text}\n</message>`, []]);
  const failing = createReportCheck({ id: 'scripted', complete: () => Promise.resolve(modelFails(true)) });
  assert.deepEqual(await failing(asked, 1_000), { finding: 'unknown', failure: 'The model could not be asked.' });
});
