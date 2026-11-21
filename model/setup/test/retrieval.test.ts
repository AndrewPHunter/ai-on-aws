import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { readEnv } from '../lib/envfile.ts'
import { readRetrieval } from '../lib/retrieval.ts'

const read = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

test('M3. every EMBED_ or RERANK_ variable compose.yaml uses is set in retrieval.env; every MODEL_ variable it uses is in .env.example', () => {
  const compose = read('compose.yaml')
  const retrievalUses = [...new Set([...compose.matchAll(/\$\{((?:EMBED|RERANK)_[A-Z0-9_]+)/g)].map((match) => match[1] ?? ''))]
  assert.ok(retrievalUses.includes('EMBED_MODEL_REPO') && retrievalUses.includes('RERANK_MODEL_REPO'), retrievalUses.join(','))
  const retrieval = readEnv(read('retrieval.env'), retrievalUses)
  assert.ok(retrieval.ok, retrieval.ok ? '' : retrieval.message)

  // MODEL_ID is the chat model's name and comes from the profile (test 11); every other MODEL_ variable is a
  // machine setting, written to model/.env from the names of .env.example.
  const machineUses = [...new Set([...compose.matchAll(/\$\{(MODEL_[A-Z0-9_]+)/g)].map((match) => match[1] ?? ''))].filter(
    (name) => name !== 'MODEL_ID',
  )
  assert.ok(machineUses.includes('MODEL_EMBED_PORT') && machineUses.includes('MODEL_RERANK_PORT'), machineUses.join(','))
  const example = readEnv(read('.env.example'), [])
  if (!example.ok) throw new Error(example.message)
  for (const name of machineUses) assert.ok(example.values.has(name), `.env.example does not name ${name}`)
})

const GOOD = read('retrieval.env')

test('M11. retrieval.env is read like a profile: a repo that is not <org>/<name> or a revision that is not 40 hex digits is refused', () => {
  const shipped = readRetrieval(GOOD)
  if (!shipped.ok) throw new Error(shipped.message)
  assert.deepEqual(shipped.retrieval, {
    embed: {
      modelId: 'qwen3-embedding-0.6b',
      modelRepo: 'Qwen/Qwen3-Embedding-0.6B',
      modelRevision: '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3',
      maxModelLen: 8192,
      kvCacheBytes: 1073741824,
      gpuMemoryUtilization: 0.05,
      dimensions: 1024,
    },
    rerank: {
      modelId: 'bge-reranker-v2-m3',
      modelRepo: 'BAAI/bge-reranker-v2-m3',
      modelRevision: '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e',
      maxModelLen: 8192,
      kvCacheBytes: 268435456,
      gpuMemoryUtilization: 0.05,
    },
  })

  const replace = (name: string, value: string): string => {
    const pattern = new RegExp(`^${name}=.*$`, 'm')
    assert.ok(pattern.test(GOOD), `retrieval.env has no ${name}`)
    return GOOD.replace(pattern, `${name}=${value}`)
  }
  const cases: [string, string, string][] = [
    ['EMBED_MODEL_REPO', 'Qwen3-Embedding-0.6B', 'EMBED_MODEL_REPO'],
    ['RERANK_MODEL_REPO', 'BAAI/bge/reranker', 'RERANK_MODEL_REPO'],
    ['EMBED_MODEL_REVISION', 'main', 'EMBED_MODEL_REVISION'],
    ['RERANK_MODEL_REVISION', '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41', 'RERANK_MODEL_REVISION'],
    ['RERANK_MODEL_REVISION', '953DC6F6F85A1B2DBFCA4C34A2796E7DDE08D41E', 'RERANK_MODEL_REVISION'],
    ['EMBED_MODEL_ID', '', 'EMBED_MODEL_ID'],
  ]
  for (const [name, value, named] of cases) {
    const result = readRetrieval(replace(name, value))
    assert.equal(result.ok, false, `accepted ${name}=${value}`)
    if (!result.ok) assert.ok(result.message.includes(named), `"${result.message}" does not name ${named}`)
  }
})
