// Invariants of docs/architecture/model-server.md that the shipped files and processes of model/ show, one test
// each, and two probes that the shipped settings are connected. No test opens model/.env, starts Docker or needs
// a network: setup.sh is run only as far as its shell guard, and tool.ts only to render settings.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { readEnv } from '../lib/envfile.ts'
import { readProfile } from '../lib/profile.ts'
import { readRetrieval } from '../lib/retrieval.ts'
import { validateMetalTiers, validateTiers, type MetalTiers, type Tiers } from '../lib/tiers.ts'

const path = (relative: string): string => fileURLToPath(new URL(`../../${relative}`, import.meta.url))
const read = (relative: string): string => readFileSync(path(relative), 'utf8')

function shippedTiers(): Tiers {
  const result = validateTiers(JSON.parse(read('tiers.json')))
  if (!result.ok) throw new Error(`model/tiers.json: ${result.errors.join('; ')}`)
  return result.tiers
}

function shippedMetalTiers(): MetalTiers {
  const result = validateMetalTiers(JSON.parse(read('metal/tiers.json')))
  if (!result.ok) throw new Error(`model/metal/tiers.json: ${result.errors.join('; ')}`)
  return result.tiers
}

function names(relative: string): Set<string> {
  const result = readEnv(read(relative), [])
  if (!result.ok) throw new Error(`model/${relative}: ${result.message}`)
  return new Set(result.values.keys())
}

test('2. setup refuses a shell variable that would override the settings files, before it reaches Docker', () => {
  const run = (name: string): { status: number | null; stderr: string } => {
    const result = spawnSync('sh', [path('setup.sh')], { env: { PATH: '/usr/bin:/bin', [name]: 'x' }, encoding: 'utf8' })
    return { status: result.status, stderr: result.stderr }
  }
  for (const name of ['DOCKER_HOST', 'MODEL_PORT', 'CHAT_MAX_NUM_SEQS', 'EMBED_MODEL_REPO', 'RERANK_MODEL_ID', 'COMPOSE_FILE']) {
    const { status, stderr } = run(name)
    assert.equal(status, 2, `${name}: ${stderr}`)
    assert.ok(stderr.includes(name), `${name} is not named: ${stderr}`)
  }
  // A name the guard does not cover goes on to the Docker check, which fails here with no Docker on PATH.
  assert.ok(!run('EMBEDDED').stderr.includes('EMBEDDED'))
})

test('5. compose.yaml names one server image, pinned by digest, and the tool image is one Node image pinned by digest', () => {
  const uncommented = (relative: string): string =>
    read(relative)
      .split('\n')
      .filter((text) => !text.trimStart().startsWith('#'))
      .join('\n')
  const servers = [...uncommented('compose.yaml').matchAll(/^\s*image:\s*(\S+)/gm)].map((match) => match[1])
  assert.equal(servers.length, 1, servers.join(', '))
  assert.match(servers[0] ?? '', /@sha256:[0-9a-f]{64}$/)

  const tools = ['setup.sh', 'setup/run-tests.sh', 'gate/compose.yaml'].map((relative) => [
    relative,
    [...uncommented(relative).matchAll(/\bnode[@:][^\s"']*/g)].map((match) => match[0]),
  ] as const)
  for (const [relative, references] of tools) assert.ok(references.length > 0, `${relative} names no Node image`)
  const all = new Set(tools.flatMap(([, references]) => references))
  assert.equal(all.size, 1, [...all].join(', '))
  assert.match([...all][0] ?? '', /^node@sha256:[0-9a-f]{64}$/)
})

test('11. the settings setup writes carry a key the tool made, a new one each time, and given on no command line', () => {
  const args = ['render', '192.0.2.1', '8000', '8001', '8002', '/srv/models', '1000', '1001']
  const key = (): string => {
    const result = spawnSync(process.execPath, [path('setup/tool.ts'), ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const found = /^MODEL_API_KEY=(.+)$/m.exec(result.stdout)?.[1]
    if (found === undefined) throw new Error('the rendered settings have no MODEL_API_KEY')
    return found
  }
  const first = key()
  const second = key()
  assert.notEqual(first, second)
  for (const made of [first, second]) assert.ok(!args.includes(made))
})

test("13. every tier's profile gives the chat server an explicit start-up share", () => {
  for (const tier of shippedTiers().tiers) {
    const profile = readEnv(read(`profiles/${tier.profile}.env`), ['CHAT_EXTRA_ARGS'])
    if (!profile.ok) throw new Error(`profiles/${tier.profile}.env: ${profile.message}`)
    assert.match(profile.values.get('CHAT_EXTRA_ARGS') ?? '', /(^|\s)--gpu-memory-utilization (0\.[0-9]*[1-9][0-9]*|1)(\s|$)/, tier.profile)
  }
})

test('18. the embedding model is the same in both retrieval files', () => {
  const values = (relative: string): Map<string, string> => {
    const result = readEnv(read(relative), [])
    if (!result.ok) throw new Error(`model/${relative}: ${result.message}`)
    return result.values
  }
  const nvidia = values('retrieval.env')
  const metal = values('metal/retrieval.env')
  for (const name of ['EMBED_MODEL_REPO', 'EMBED_MODEL_REVISION', 'EMBED_MODEL_ID', 'EMBED_DIMENSIONS', 'EMBED_MAX_MODEL_LEN']) {
    assert.ok(nvidia.has(name), `${name} is not in retrieval.env`)
    assert.equal(metal.get(name), nvidia.get(name), name)
  }
})

test("P1. the shipped tiers files are valid, and every tier's profile and both retrieval settings read", () => {
  for (const tier of [...shippedTiers().tiers, ...shippedMetalTiers().tiers]) {
    const profile = readProfile(read(`profiles/${tier.profile}.env`))
    assert.ok(profile.ok, `profiles/${tier.profile}.env: ${profile.ok ? '' : profile.message}`)
  }
  for (const relative of ['retrieval.env', 'metal/retrieval.env']) {
    const retrieval = readRetrieval(read(relative))
    assert.ok(retrieval.ok, `${relative}: ${retrieval.ok ? '' : retrieval.message}`)
  }
})

test('P2. every variable compose.yaml reads is supplied by one of the three files, and every setting servers.sh reads by the file it reads', () => {
  const machine = names('.env.example')
  const retrieval = names('retrieval.env')
  const profiles = shippedTiers().tiers.map((tier) => names(`profiles/${tier.profile}.env`))
  const used = new Set([...read('compose.yaml').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1] ?? ''))
  assert.ok(used.size > 0)
  for (const name of used) {
    assert.ok(machine.has(name) || retrieval.has(name) || profiles.every((profile) => profile.has(name)), `${name} is in none of the three files`)
  }

  // model/metal/servers.sh reads each setting as `setting "$<file>" NAME`, from one of its three files.
  const metalProfiles = shippedMetalTiers().tiers.map((tier) => names(`profiles/${tier.profile}.env`))
  const metalRetrieval = names('metal/retrieval.env')
  const supplies: Record<string, (name: string) => boolean> = {
    env_file: (name) => machine.has(name),
    profile_file: (name) => metalProfiles.every((profile) => profile.has(name)),
    retrieval_file: (name) => metalRetrieval.has(name),
  }
  const reads = [...read('metal/servers.sh').matchAll(/\bsetting "\$([a-z_]+)" ([A-Z][A-Z0-9_]*)/g)]
  assert.ok(reads.length > 0)
  for (const [, file = '', name = ''] of reads) {
    assert.ok(supplies[file]?.(name) === true, `servers.sh reads ${name} from $${file}, which does not supply it`)
  }
})
