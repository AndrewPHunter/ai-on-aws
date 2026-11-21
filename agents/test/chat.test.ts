// Drives the real chat client against the scripted model (helpers.ts) and an unreachable address.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createChatModel, servedModelId } from '../src/model/chat.ts';
import { SCRIPTED_MODEL_ID, call, deadUrl, prop, startScriptedModel, text, toolCalls } from './helpers.ts';

test('the served model id is read from the model list', async (t) => {
  const model = await startScriptedModel(t, []);
  assert.deepEqual(await servedModelId(model.baseUrl, 'test-key', 500), { ok: true, id: SCRIPTED_MODEL_ID });
});

test('a text answer and a tool-call answer are read into a completion', async (t) => {
  const model = await startScriptedModel(t, [text('Hello.'), toolCalls({ ...call('find_case', { case_id: 'AE-000001' }), id: 'c1' })]);

  const first = await model.model.complete([{ role: 'user', content: 'hi' }], [], { timeoutMs: 500, thinking: true });
  assert.deepEqual(first, {
    ok: true,
    completion: { content: 'Hello.', toolCalls: [], finishReason: 'stop', inputTokens: 10, outputTokens: 5 },
  });

  const second = await model.model.complete([{ role: 'user', content: 'hi' }], [], { timeoutMs: 500, thinking: true });
  assert.equal(second.ok, true);
  assert.deepEqual(second.ok ? second.completion.toolCalls : undefined, [
    { id: 'c1', type: 'function', function: { name: 'find_case', arguments: '{"case_id":"AE-000001"}' } },
  ]);
});

test('the request carries the model, messages and tools', async (t) => {
  const model = await startScriptedModel(t, [text('ok')]);
  const tools = [{ type: 'function' as const, function: { name: 'find_case', description: 'Find.', parameters: {} } }];
  await model.model.complete([{ role: 'user', content: 'hi' }], tools, { timeoutMs: 500, thinking: true });
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
  await model.model.complete([{ role: 'user', content: 'hi' }], [], { timeoutMs: 500, thinking: false });
  const [body] = model.requests;
  assert.deepEqual(prop(body, 'chat_template_kwargs'), { enable_thinking: false });
});

test('an unreachable model gives a reason without its address', async (t) => {
  const url = await deadUrl(t);
  const model = createChatModel({ baseUrl: `${url}/v1`, apiKey: 'test-key', modelId: 'm', temperature: 0, maxTokens: 1, seed: 1 });
  const result = await model.complete([{ role: 'user', content: 'hi' }], [], { timeoutMs: 500, thinking: true });
  assert.deepEqual(result, { ok: false, reason: 'The model could not be reached.' });
});
