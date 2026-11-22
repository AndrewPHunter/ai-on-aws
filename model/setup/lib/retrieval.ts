// What setup needs from model/retrieval.env: the embedding model and the reranker that run beside every tier.
// Read like a profile: each model at a pinned revision, with its name, input limit and memory settings.

import { readEnv } from './envfile.ts'

export type PoolingModel = {
  modelId: string
  modelRepo: string
  modelRevision: string
  maxModelLen: number
  kvCacheBytes: number
  gpuMemoryUtilization: number
}

export type Retrieval = {
  embed: PoolingModel & { dimensions: number }
  rerank: PoolingModel
}

export type RetrievalResult = { ok: true; retrieval: Retrieval } | { ok: false; message: string }

const FIELDS = ['MODEL_REPO', 'MODEL_REVISION', 'MODEL_ID', 'MAX_MODEL_LEN', 'KV_CACHE_BYTES', 'GPU_MEMORY_UTILIZATION'] as const

export const RETRIEVAL_NAMES = [
  ...FIELDS.map((field) => `EMBED_${field}`),
  'EMBED_DIMENSIONS',
  ...FIELDS.map((field) => `RERANK_${field}`),
]

const POSITIVE_INTEGER = /^[1-9][0-9]*$/
// A fraction above 0 and at most 1, written as 0.x or 1 (vLLM's --gpu-memory-utilization).
const FRACTION = /^(0\.[0-9]*[1-9][0-9]*|1|1\.0+)$/

function readModel(get: (name: string) => string, prefix: 'EMBED' | 'RERANK'): PoolingModel | string {
  const repo = get(`${prefix}_MODEL_REPO`)
  const revision = get(`${prefix}_MODEL_REVISION`)
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return `${prefix}_MODEL_REPO is not <org>/<name>`
  if (!/^[0-9a-f]{40}$/.test(revision)) return `${prefix}_MODEL_REVISION is not a 40-character commit hash`
  for (const name of [`${prefix}_MAX_MODEL_LEN`, `${prefix}_KV_CACHE_BYTES`]) {
    if (!POSITIVE_INTEGER.test(get(name))) return `${name} is not a positive integer`
  }
  const fraction = get(`${prefix}_GPU_MEMORY_UTILIZATION`)
  if (!FRACTION.test(fraction)) return `${prefix}_GPU_MEMORY_UTILIZATION is not a fraction above 0 and at most 1`
  return {
    modelId: get(`${prefix}_MODEL_ID`),
    modelRepo: repo,
    modelRevision: revision,
    maxModelLen: Number(get(`${prefix}_MAX_MODEL_LEN`)),
    kvCacheBytes: Number(get(`${prefix}_KV_CACHE_BYTES`)),
    gpuMemoryUtilization: Number(fraction),
  }
}

export function readRetrieval(text: string): RetrievalResult {
  const read = readEnv(text, RETRIEVAL_NAMES)
  if (!read.ok) return read
  const get = (name: string): string => read.values.get(name) ?? ''
  const embed = readModel(get, 'EMBED')
  if (typeof embed === 'string') return { ok: false, message: embed }
  const rerank = readModel(get, 'RERANK')
  if (typeof rerank === 'string') return { ok: false, message: rerank }
  if (!POSITIVE_INTEGER.test(get('EMBED_DIMENSIONS'))) return { ok: false, message: 'EMBED_DIMENSIONS is not a positive integer' }
  return { ok: true, retrieval: { embed: { ...embed, dimensions: Number(get('EMBED_DIMENSIONS')) }, rerank } }
}
