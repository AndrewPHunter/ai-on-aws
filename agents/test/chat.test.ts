// Drives the real chat client against the scripted model (helpers.ts) and an unreachable address.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createChatModel } from '../src/model/chat.ts';
import { servedModelId } from '../src/model/served.ts';
import { SCRIPTED_MODEL_ID, call, deadUrl, prop, startScriptedModel, text, toolCalls } from './helpers.ts';

test('the served model id is read from the model list', async (t) => {
  const model = await startScriptedModel(t, []);
  assert.deepEqual(await servedModelId(model.baseUrl, 'test-key', 500), { ok: true, id: SCRIPTED_MODEL_ID });
});

test('a text answer and a tool-call answer are read into a completion', async (t) => {
  const model = await startScriptedModel(t, [text('Hello.'), toolCalls({ ...call('find_case', { case_id: 'AE-000001' }), id: 'c1' })]);

  const first = await createChatModel(model.settings).complete([{ role: 'user', content: 'hi' }], [], { timeoutMs: 500, thinking: true });
  assert.deepEqual(first, {
    ok: true,
    completion: { content: 'Hello.', toolCalls: [], finishReason: 'stop', inputTokens: 10, outputTokens: 5 },
  });

  const second = await createChatModel(model.settings).complete([{ role: 'user', content: 'hi' }], [], { timeoutMs: 500, thinking: true });
  assert.equal(second.ok, true);
  assert.deepEqual(second.ok ? second.completion.toolCalls : undefined, [
    { id: 'c1', type: 'function', function: { name: 'find_case', arguments: '{"case_id":"AE-000001"}' } },
  ]);
});

test('the request carries the model, messages and tools', async (t) => {
  const model = await startScriptedModel(t, [text('ok')]);
  const tools = [{ type: 'function' as const, function: { name: 'find_case', description: 'Find.', parameters: {} } }];
  await createChatModel(model.settings).complete([{ role: 'user', content: 'hi' }], tools, { timeoutMs: 500, thinking: true });
  const [body] = model.requests;
  assert.deepEqual(body, {
    model: SCRIPTED_MODEL_ID,
    messages: [{ role: 'user', content: 'hi' }],
    tools,
    temperature: 0,
    max_tokens: 256,
    seed: 1,
  });
});

test('a request with thinking off asks the chat template to turn it off', async (t) => {
  const model = await startScriptedModel(t, [text('ok')]);
  await createChatModel(model.settings).complete([{ role: 'user', content: 'hi' }], [], { timeoutMs: 500, thinking: false });
  const [body] = model.requests;
  assert.deepEqual(prop(body, 'chat_template_kwargs'), { enable_thinking: false });
});

test('an unreachable model gives a reason without its address', async (t) => {
  const url = await deadUrl(t);
  const model = createChatModel({ baseUrl: `${url}/v1`, apiKey: 'test-key', modelId: 'm', temperature: 0, maxTokens: 1, seed: 1 });
  const result = await model.complete([{ role: 'user', content: 'hi' }], [], { timeoutMs: 500, thinking: true });
  assert.deepEqual(result, { ok: false, reason: 'The model could not be reached.', retryable: true });
});

test('a model that does not answer in time gives a failure that is not worth sending again', async (t) => {
  const model = await startScriptedModel(t, [{ kind: 'never' }]);
  const result = await createChatModel(model.settings).complete([{ role: 'user', content: 'hi' }], [], { timeoutMs: 600, thinking: true });
  assert.deepEqual(result, { ok: false, reason: 'The model did not answer within 1 s.', retryable: false });
});

test('a failure says whether the same request could go differently if sent again', async (t) => {
  // 200 here is a 200 whose body is not a completion.
  const statuses = [408, 429, 500, 503, 400, 401, 404, 200];
  const model = await startScriptedModel(
    t,
    statuses.map((status) => ({ kind: 'status' as const, status })),
  );
  const chat = createChatModel(model.settings);

  const seen: Array<[number, boolean | undefined]> = [];
  for (const status of statuses) {
    const result = await chat.complete([{ role: 'user', content: 'hi' }], [], { timeoutMs: 500, thinking: true });
    seen.push([status, result.ok ? undefined : result.retryable]);
  }

  assert.deepEqual(seen, [
    [408, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [404, false],
    [200, false],
  ]);
  assert.equal(model.unexpectedRequests(), 0);
});
