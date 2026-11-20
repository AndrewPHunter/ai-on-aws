import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { readEnv, renderEnv, type EnvInput } from '../lib/envfile.ts'

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef'

const INPUT: EnvInput = {
  bindAddress: '192.0.2.20',
  port: 8000,
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
      'MODEL_CACHE_DIR=/srv/models\n' +
      'MODEL_RUN_UID=1000\n' +
      'MODEL_RUN_GID=1001\n' +
      `MODEL_API_KEY=${KEY}\n` +
      'MODEL_BASE_URL=http://192.0.2.20:8000/v1\n',
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
