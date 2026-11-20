import assert from 'node:assert/strict'
import { test } from 'node:test'

import { capacityVerdict, parseCapacity } from '../lib/capacity.ts'

const LINE_A =
  '(EngineCore pid=205) INFO 11-19 23:45:00 [kv_cache_utils.py:1168] GPU KV cache size: 82,895 tokens, Maximum concurrency for 20,480 tokens per request: 4.05x'
const LINE_B =
  '(EngineCore pid=311) INFO 11-19 22:10:04 [kv_cache_utils.py:1168] GPU KV cache size: 78,019 tokens, Maximum concurrency for 20,480 tokens per request: 3.81x'

test("15. vLLM's capacity line parses to tokens, context and concurrency; absent is an error; the last line wins", () => {
  assert.deepEqual(parseCapacity(`starting\n${LINE_A}\nready\n`), {
    ok: true,
    capacity: { tokens: 82895, context: 20480, concurrency: 4.05 },
  })
  assert.deepEqual(
    parseCapacity('INFO GPU KV cache size: 1,133,152 tokens, Maximum concurrency for 32,768 tokens per request: 34.58x'),
    { ok: true, capacity: { tokens: 1133152, context: 32768, concurrency: 34.58 } },
  )
  assert.equal(parseCapacity('INFO starting\nINFO Application startup complete.\n').ok, false)
  assert.equal(parseCapacity('').ok, false)
  assert.deepEqual(parseCapacity(`${LINE_A}\nrestarting\n${LINE_B}\n`), {
    ok: true,
    capacity: { tokens: 78019, context: 20480, concurrency: 3.81 },
  })
})

test('16. capacity verdict: below the profile concurrency fails, at or above passes, another context fails', () => {
  assert.equal(capacityVerdict({ tokens: 78019, context: 20480, concurrency: 3.81 }, 20480, 4).ok, false)
  assert.equal(capacityVerdict({ tokens: 82895, context: 20480, concurrency: 4.05 }, 20480, 4).ok, true)
  assert.equal(capacityVerdict({ tokens: 81920, context: 20480, concurrency: 4 }, 20480, 4).ok, true)
  assert.equal(capacityVerdict({ tokens: 133152, context: 32768, concurrency: 4.06 }, 20480, 4).ok, false)
})
