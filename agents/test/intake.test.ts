// The hand-written intake agent's invariants ("Always true" in docs/architecture/intake-agent-handwritten.md),
// one test each, at its handler, with every dependency a value and nothing on the network. The model and the
// case system's tools are scripted in memory; each keeps to its contract and reports a failure as a value.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { InboundMessage, InvocationResponse } from '../../shared/agent-contract.ts';
import { handleInquiry } from '../src/intake/handwritten.ts';
import { LIMITS } from '../src/intake/settings.ts';
import type { ChatMessage, ChatResult, ToolDefinition } from '../src/model/chat.ts';
import type { ToolOutcome } from '../src/tools/tool-set.ts';
import { CALLER, clock, message, prop } from './support.ts';
import type { Clock } from './support.ts';

const IDENTITY = { id: 'intake-test', implementation: 'hand-written loop' };

const DEFINITIONS: ToolDefinition[] = ['create_case', 'find_case', 'add_follow_up'].map((name) => ({
  type: 'function',
  function: { name, description: `The case system's ${name}.`, parameters: { type: 'object', properties: { case_id: { type: 'string' }, event: { type: 'string' } } } },
}));

type Script = (messages: ChatMessage[], nth: number) => ChatResult;
type Tools = (tool: string, args: Record<string, unknown>, nth: number) => ToolOutcome;

type World = {
  // What happened, in order: "model" for each request to the model, the tool's name for each call made.
  events: string[];
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  requests: Array<{ messages: ChatMessage[]; tools: ToolDefinition[] }>;
  connected: Array<{ message: InboundMessage; token: string }>;
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

// The handler with scripted dependencies. The model's script is asked per conversation (by its user turn), so two
// runs on the same dependencies each follow their own.
function rig(script: Script, tools: Tools = (tool) => (tool === 'create_case' ? created('C-1') : answered({ cases: [] })), options: { connect?: 'refused' | 'short'; clock?: Clock } = {}) {
  const time = options.clock ?? clock();
  const world: World = { events: [], calls: [], requests: [], connected: [] };
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
              definitions: structuredClone(options.connect === 'short' ? DEFINITIONS.slice(0, 2) : DEFINITIONS),
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
    { name: 'tools cannot be connected', rig: rig(turns(), undefined, { connect: 'refused' }) },
    { name: 'the case system offers fewer than three tools', rig: rig(turns(), undefined, { connect: 'short' }), failsBeforeModel: true },
    { name: 'the model fails', rig: rig(() => modelFails(false)) },
    { name: 'the model answers nonsense', rig: rig(turns(ask(['no_such_tool', {}], ['create_case', '{not json'], ['find_case', '[1, 2]']), say(''))) },
    { name: 'a tool gives no answer', rig: rig(turns(ask(['find_case', {}])), () => noAnswer) },
    { name: 'a limit is reached', rig: rig(() => ask(['find_case', {}])) },
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

test('intake 4. a run opens or finds at most one case for its message and adds no version to it', async () => {
  const rows: Array<{ name: string; script: Script }> = [
    { name: 'create twice in one turn', script: turns(ask(['create_case', { event: 'a' }], ['create_case', { event: 'b' }])) },
    { name: 'create, then follow up on that case', script: turns(ask(['create_case', { event: 'a' }]), ask(['add_follow_up', { case_id: 'C-1', event: 'b' }])) },
  ];
  for (const row of rows) {
    const { world, run } = rig(row.script);
    const response = await run();
    assert.equal(writes(world), 1, `${row.name}: more than one write reached the case system`);
    assert.equal(response.case_actions.length, 1, row.name);
  }
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
  const many = ask(['find_case', { event: 'a' }], ['no_such_tool', {}], ['find_case', { event: 'b' }], ['create_case', '{oops'], ['create_case', { event: 'c' }]);
  const { world, run } = rig(turns(many), (tool, _args, nth) => (tool === 'find_case' && nth === 1 ? noAnswer : tool === 'create_case' ? created('C-1') : answered({ cases: [] })));
  await run();
  const next = world.requests[1]?.messages ?? [];
  assert.deepEqual(toolMessages(next).map((m) => m.id), callIdsOf(many));
});

test('intake 9. every model turn, tool call, refusal and failed request to the model is a step in the response', async () => {
  const { run } = rig((_messages, nth) => [modelFails(true), ask(['find_case', {}], ['no_such_tool', {}])][nth] ?? say('Nothing to record.'));
  const response = await run();
  const count = (predicate: (step: InvocationResponse['steps'][number]) => boolean): number => response.steps.filter(predicate).length;
  assert.equal(count((s) => s.kind === 'error'), 1, 'the failed request');
  assert.equal(count((s) => s.kind === 'model'), 2, 'the two model turns');
  assert.equal(count((s) => s.kind === 'tool' && s.tool === 'find_case' && !s.is_error), 1, 'the tool call');
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
    { name: 'a model that always asks for a tool', rig: rig(() => ask(['find_case', {}])), requests: 6 },
    { name: 'a model whose every request fails', rig: rig(() => modelFails(true)), requests: 3 },
    {
      name: 'a tool call that ends after 150 s',
      rig: rig(
        () => ask(['find_case', {}]),
        () => {
          time.advance(150_000);
          return answered({ cases: [] });
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
