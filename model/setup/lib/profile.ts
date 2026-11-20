// What setup needs from a profile in model/profiles/: the model, its pinned revision and its capacity figures.

import { readEnv } from './envfile.ts'

export type Profile = {
  modelId: string
  modelRepo: string
  modelRevision: string
  maxModelLen: number
  maxNumSeqs: number
}

export type ProfileResult = { ok: true; profile: Profile } | { ok: false; message: string }

const PROFILE_NAMES = ['MODEL_ID', 'CHAT_MODEL_REPO', 'CHAT_MODEL_REVISION', 'CHAT_MAX_MODEL_LEN', 'CHAT_MAX_NUM_SEQS'] as const

export function readProfile(text: string): ProfileResult {
  const read = readEnv(text, PROFILE_NAMES)
  if (!read.ok) return read
  const get = (name: string): string => read.values.get(name) ?? ''
  const repo = get('CHAT_MODEL_REPO')
  const revision = get('CHAT_MODEL_REVISION')
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return { ok: false, message: 'CHAT_MODEL_REPO is not <org>/<name>' }
  if (!/^[0-9a-f]{40}$/.test(revision)) return { ok: false, message: 'CHAT_MODEL_REVISION is not a 40-character commit hash' }
  if (get('MODEL_ID') === '') return { ok: false, message: 'MODEL_ID is empty' }
  for (const name of ['CHAT_MAX_MODEL_LEN', 'CHAT_MAX_NUM_SEQS']) {
    if (!/^[1-9][0-9]*$/.test(get(name))) return { ok: false, message: `${name} is not a positive integer` }
  }
  return {
    ok: true,
    profile: {
      modelId: get('MODEL_ID'),
      modelRepo: repo,
      modelRevision: revision,
      maxModelLen: Number(get('CHAT_MAX_MODEL_LEN')),
      maxNumSeqs: Number(get('CHAT_MAX_NUM_SEQS')),
    },
  }
}

// Where the Hugging Face cache keeps the pinned revision, relative to the cache directory
// (the compose file sets HF_HOME to <cache>/hf).
export function snapshotPath(profile: Profile): string {
  const [org, name] = profile.modelRepo.split('/')
  return `hf/hub/models--${org}--${name}/snapshots/${profile.modelRevision}`
}
