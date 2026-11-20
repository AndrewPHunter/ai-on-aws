import assert from 'node:assert/strict'
import { test } from 'node:test'

import { snapshotPath, type Profile } from '../lib/profile.ts'

test("21. the cache path of a profile's pinned revision follows the downloader's layout", () => {
  const profile: Profile = {
    modelId: 'qwen3.5-4b',
    modelRepo: 'RedHatAI/Qwen3.5-4B-quantized.w4a16',
    modelRevision: '7a613872f394578b0b52b683ff4ac47516b4bcaf',
    maxModelLen: 20480,
    maxNumSeqs: 4,
  }
  assert.equal(
    snapshotPath(profile),
    'hf/hub/models--RedHatAI--Qwen3.5-4B-quantized.w4a16/snapshots/7a613872f394578b0b52b683ff4ac47516b4bcaf',
  )
})
