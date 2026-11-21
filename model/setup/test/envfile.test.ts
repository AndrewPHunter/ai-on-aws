import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { readEnv, renderEnv, type EnvInput } from '../lib/envfile.ts'

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef'

const INPUT: EnvInput = {
  bindAddress: '192.0.2.20',
  port: 8000,
  embedPort: 8001,
  rerankPort: 8002,
  cacheDir: '/srv/models',
  runUid: 1000,
  runGid: 1001,
  apiKey: KEY,
}

test('12. rendering model/.env gives the exact text, with exactly the variables of model/.env.example', () => {
  const result = renderEnv(INPUT)
  assert.deepEqual(result, {
    ok: true,
    text:
      '# Written by model/setup.sh. Machine-specific; never commit this file.\n' +
      'MODEL_BIND_ADDRESS=192.0.2.20\n' +
      'MODEL_PORT=8000\n' +
      'MODEL_EMBED_PORT=8001\n' +
      'MODEL_RERANK_PORT=8002\n' +
      'MODEL_CACHE_DIR=/srv/models\n' +
      'MODEL_RUN_UID=1000\n' +
      'MODEL_RUN_GID=1001\n' +
      `MODEL_API_KEY=${KEY}\n` +
      'MODEL_BASE_URL=http://192.0.2.20:8000/v1\n' +
      'MODEL_EMBED_BASE_URL=http://192.0.2.20:8001/v1\n' +
      'MODEL_RERANK_BASE_URL=http://192.0.2.20:8002/v1\n',
  })
  if (!result.ok) return
  // Read by its exact name: the live model/.env sits beside it and is never opened by a test.
  const example = readEnv(readFileSync(new URL('../../.env.example', import.meta.url), 'utf8'), [])
  const rendered = readEnv(result.text, [])
  if (!example.ok || !rendered.ok) throw new Error('could not read the env texts')
  assert.deepEqual([...rendered.values.keys()].sort(), [...example.values.keys()].sort())
})

test('13. values that would corrupt an env file are refused, naming the variable', () => {
  const unsafe = ['/srv/my models', '/srv/tab\there', "/srv/it's", '/srv/"x"', '/srv/a#b', '/srv/$HOME', '/srv/a\\b', '/srv/a\nb', '/srv/`x`', '']
  const fields: [keyof EnvInput, string][] = [
    ['cacheDir', 'MODEL_CACHE_DIR'],
    ['bindAddress', 'MODEL_BIND_ADDRESS'],
    ['apiKey', 'MODEL_API_KEY'],
  ]
  for (const [field, variable] of fields) {
    for (const value of unsafe) {
      const result = renderEnv({ ...INPUT, [field]: value })
      assert.equal(result.ok, false, `${variable}=${JSON.stringify(value)} accepted`)
      if (!result.ok) assert.ok(result.message.includes(variable), `"${result.message}" does not name ${variable}`)
    }
  }
})

test('14. reading an env file returns the exact values, skips comments and blank lines, and names a missing or empty variable', () => {
  const text = '# a comment\n\nMODEL_ID=qwen3.5-4b\n   # indented comment\nCHAT_MAX_MODEL_LEN=20480\r\nCHAT_EXTRA_ARGS=\nURL=http://h:1/v1?a=b\n'
  const result = readEnv(text, ['MODEL_ID', 'CHAT_MAX_MODEL_LEN'])
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(
      [...result.values.entries()],
      [
        ['MODEL_ID', 'qwen3.5-4b'],
        ['CHAT_MAX_MODEL_LEN', '20480'],
        ['CHAT_EXTRA_ARGS', ''],
        ['URL', 'http://h:1/v1?a=b'],
      ],
    )
  }
  const missing = readEnv(text, ['MODEL_ID', 'MODEL_API_KEY'])
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.ok(missing.message.includes('MODEL_API_KEY'), missing.message)
  const empty = readEnv(text, ['MODEL_ID', 'CHAT_EXTRA_ARGS'])
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.ok(empty.message.includes('CHAT_EXTRA_ARGS'), empty.message)
})

const NEW_NAMES = ['MODEL_EMBED_PORT', 'MODEL_RERANK_PORT', 'MODEL_EMBED_BASE_URL', 'MODEL_RERANK_BASE_URL']

function exampleNames(): string[] {
  // Read by its exact name: the live model/.env sits beside it and is never opened by a test.
  const example = readEnv(readFileSync(new URL('../../.env.example', import.meta.url), 'utf8'), [])
  if (!example.ok) throw new Error(`could not read model/.env.example: ${example.message}`)
  return [...example.values.keys()]
}

test('M4. the rendered model/.env holds the four new variables, each URL built from the bind address and its port, in the order of .env.example', () => {
  const result = renderEnv({ ...INPUT, bindAddress: '198.51.100.7', port: 9000, embedPort: 9100, rerankPort: 9200 })
  if (!result.ok) throw new Error(result.message)
  const rendered = readEnv(result.text, [])
  if (!rendered.ok) throw new Error(rendered.message)
  assert.equal(rendered.values.get('MODEL_EMBED_PORT'), '9100')
  assert.equal(rendered.values.get('MODEL_RERANK_PORT'), '9200')
  assert.equal(rendered.values.get('MODEL_BASE_URL'), 'http://198.51.100.7:9000/v1')
  assert.equal(rendered.values.get('MODEL_EMBED_BASE_URL'), 'http://198.51.100.7:9100/v1')
  assert.equal(rendered.values.get('MODEL_RERANK_BASE_URL'), 'http://198.51.100.7:9200/v1')
  assert.deepEqual([...rendered.values.keys()], exampleNames())
  for (const name of NEW_NAMES) assert.ok(exampleNames().includes(name), `.env.example does not name ${name}`)
})

test('M6. --keep-env with a model/.env that lacks one of the new variables stops and names it', () => {
  // What --keep-env does with model/.env (tool.ts, settings): read it requiring every variable of .env.example.
  const full = renderEnv(INPUT)
  if (!full.ok) throw new Error(full.message)
  assert.equal(readEnv(full.text, exampleNames()).ok, true)
  for (const name of NEW_NAMES) {
    const without = full.text
      .split('\n')
      .filter((line) => !line.startsWith(`${name}=`))
      .join('\n')
    const result = readEnv(without, exampleNames())
    assert.equal(result.ok, false, `accepted without ${name}`)
    if (!result.ok) assert.ok(result.message.includes(name), `"${result.message}" does not name ${name}`)
  }
})
