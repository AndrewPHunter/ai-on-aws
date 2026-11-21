// Command-line entry for the decisions behind model/setup.sh. The wrapper runs it in the pinned Node image
// on the local Docker daemon, with model/ mounted read-only at /m and no network.
//
// Usage: node tool.ts <command> [arguments]   (input, where a command takes any, on standard input)
//   args -- <setup.sh flags...>                          parse and check the flags
//   settings <check> <keep_env> <bind> <port> <cache> <embed_port> <rerank_port>
//                                                       existing model/.env against the flags (yes/no switches)
//   running <host or "">                                the running-server guard, on the service of each running
//                                                       container of the lab's project (one per line)
//   image                                               the server image from `docker compose config --images`
//   select <probe_exit_status> <tier or "">            parse nvidia-smi output and select a tier
//   disk <tier> <probe_exit_status> <image_present>     parse the disk probe and give the disk verdict
//   health <inspect_exit_status> <seconds> <state>      the health verdict while a server starts
//   capacity <profile>                                  vLLM's capacity line from the chat server's log, and the verdict
//   embed-capacity                                      vLLM's capacity line from the embedding server's log, and the verdict
//   exit-code <outcome>                                 the exit code of an outcome the wrapper detected
//   render <bind> <port> <embed_port> <rerank_port> <cache> <uid> <gid>
//                                                       the text of model/.env, with a new key (see below)
//
// Protocol (every command but render): results go to standard output as key=value lines (values free of
// newlines), ending with `outcome=<name>` and `exit_code=<n>`, where n is the code the outcome maps to
// (lib/outcome.ts). Messages go to standard error. When the tool ran, the process exits 0, refusals included;
// so a non-zero process exit always means the tool itself could not be started or loaded.
//
// render writes the text of model/.env, and nothing else, to standard output and exits 0; on any failure it
// writes nothing there and exits 2. The API key is generated here and appears only in that text.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

import { isLoopbackIpv4, parseArgs, portClash } from './lib/args.ts'
import { capacityVerdict, embedCapacityVerdict, parseCapacity } from './lib/capacity.ts'
import { diskVerdict, parseDiskProbe } from './lib/disk.ts'
import { ENV_NAMES, readEnv, renderEnv } from './lib/envfile.ts'
import { healthVerdict } from './lib/health.ts'
import { exitCodeFor, isOutcome, type Outcome } from './lib/outcome.ts'
import { parseProbe } from './lib/probe.ts'
import { readProfile, snapshotPath, snapshotPathOf, type Profile } from './lib/profile.ts'
import { readRetrieval, type Retrieval } from './lib/retrieval.ts'
import { runningVerdict } from './lib/running.ts'
import { selectTier } from './lib/select.ts'
import { validateTiers, type Tiers } from './lib/tiers.ts'

const MODEL_DIR = new URL('../', import.meta.url)
const fileIn = (relative: string): URL => new URL(relative, MODEL_DIR)

type Results = Record<string, string | number>

class Stop extends Error {
  readonly outcome: Outcome
  constructor(outcome: Outcome, message: string) {
    super(message)
    this.outcome = outcome
  }
}

function emit(values: Results): void {
  for (const [key, value] of Object.entries(values)) {
    const text = String(value)
    if (text.includes('\n') || text.includes('\r')) throw new Error(`value of ${key} contains a newline`)
    process.stdout.write(`${key}=${text}\n`)
  }
}

function readStdin(): string {
  return readFileSync(0, 'utf8')
}

function loadTiers(): Tiers {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(fileIn('tiers.json'), 'utf8'))
  } catch (error) {
    throw new Stop('tiers_invalid', `model/tiers.json could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const result = validateTiers(raw)
  if (!result.ok) throw new Stop('tiers_invalid', `model/tiers.json is invalid:\n  ${result.errors.join('\n  ')}`)
  return result.tiers
}

function loadProfile(name: string): Profile {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Stop('repository_invalid', `not a profile name: ${name}`)
  const path = `profiles/${name}.env`
  let text: string
  try {
    text = readFileSync(fileIn(path), 'utf8')
  } catch {
    throw new Stop('repository_invalid', `model/${path} could not be read`)
  }
  const result = readProfile(text)
  if (!result.ok) throw new Stop('repository_invalid', `model/${path}: ${result.message}`)
  return result.profile
}

function loadRetrieval(): Retrieval {
  let text: string
  try {
    text = readFileSync(fileIn('retrieval.env'), 'utf8')
  } catch {
    throw new Stop('repository_invalid', 'model/retrieval.env could not be read')
  }
  const result = readRetrieval(text)
  if (!result.ok) throw new Stop('repository_invalid', `model/retrieval.env: ${result.message}`)
  return result.retrieval
}

function exampleNames(): string[] {
  const result = readEnv(readFileSync(fileIn('.env.example'), 'utf8'), [])
  if (!result.ok) throw new Stop('repository_invalid', `model/.env.example: ${result.message}`)
  return [...result.values.keys()]
}

function yesNo(text: string | undefined, what: string): boolean {
  if (text === 'yes') return true
  if (text === 'no') return false
  throw new Error(`${what} must be yes or no, got: ${String(text)}`)
}

function count(text: string | undefined, what: string): number {
  if (text === undefined || !/^[0-9]+$/.test(text)) throw new Error(`${what} must be a non-negative integer, got: ${String(text)}`)
  return Number(text)
}

// ---------- commands ----------

function commandArgs(argv: string[]): Results {
  if (argv[0] !== '--') throw new Error('args: expected -- before the flags')
  const tiers = loadTiers()
  const result = parseArgs(argv.slice(1), tiers.tiers.map((tier) => tier.name))
  if (!result.ok) throw new Stop('usage', result.message)
  const { options } = result
  return {
    check: options.check ? 'yes' : 'no',
    keep_env: options.keepEnv ? 'yes' : 'no',
    cache_dir: options.cacheDir ?? '',
    bind: options.bind ?? '',
    port: options.port ?? '',
    embed_port: options.embedPort ?? '',
    rerank_port: options.rerankPort ?? '',
    host: options.host ?? '',
    tier: options.tier ?? '',
  }
}

function commandSettings(argv: string[]): Results {
  const check = yesNo(argv[0], 'check')
  const keepEnv = yesNo(argv[1], 'keep_env')
  const envUrl = fileIn('.env')

  if (keepEnv) {
    if (!existsSync(envUrl)) throw new Stop('env_missing', '--keep-env was given but model/.env does not exist')
    const result = readEnv(readFileSync(envUrl, 'utf8'), exampleNames())
    if (!result.ok) {
      throw new Stop('env_missing', `model/.env does not define every variable of model/.env.example with a value: ${result.message}`)
    }
    const get = (name: string): string => result.values.get(name) ?? ''
    const ports = (['MODEL_PORT', 'MODEL_EMBED_PORT', 'MODEL_RERANK_PORT'] as const).map((name) => [name, Number(get(name))] as const)
    const clash = portClash(ports)
    if (clash !== null) throw new Stop('env_missing', `model/.env: ${clash}`)
    const bind = get('MODEL_BIND_ADDRESS')
    return {
      bind,
      port: get('MODEL_PORT'),
      embed_port: get('MODEL_EMBED_PORT'),
      rerank_port: get('MODEL_RERANK_PORT'),
      cache_dir: get('MODEL_CACHE_DIR'),
      base_url: get('MODEL_BASE_URL'),
      embed_base_url: get('MODEL_EMBED_BASE_URL'),
      rerank_base_url: get('MODEL_RERANK_BASE_URL'),
      gate_network: isLoopbackIpv4(bind) ? 'host' : 'default',
    }
  }
  if (!check && existsSync(envUrl)) {
    throw new Stop('env_present', 'model/.env already exists: delete it to write new settings, or pass --keep-env to use it as it is')
  }
  const bind = argv[2] ?? ''
  const port = argv[3] ?? ''
  const embedPort = argv[5] ?? ''
  const rerankPort = argv[6] ?? ''
  return {
    bind,
    port,
    embed_port: embedPort,
    rerank_port: rerankPort,
    cache_dir: argv[4] ?? '',
    base_url: `http://${bind}:${port}/v1`,
    embed_base_url: `http://${bind}:${embedPort}/v1`,
    rerank_base_url: `http://${bind}:${rerankPort}/v1`,
    gate_network: isLoopbackIpv4(bind) ? 'host' : 'default',
  }
}

const PROJECT = 'ai-on-aws-model'

function commandRunning(argv: string[]): Results {
  const host = argv[0] ?? ''
  const verdict = runningVerdict(readStdin())
  if (!verdict.ok) {
    const prefix = host === '' ? '' : `DOCKER_HOST=${host} `
    throw new Stop('server_running', `${verdict.message} Stop the lab's servers first: ${prefix}docker compose -p ${PROJECT} stop`)
  }
  return {}
}

function commandImage(): Results {
  const images = [...new Set(readStdin().split('\n').map((line) => line.trim()).filter((line) => line !== ''))]
  if (images.length !== 1) {
    throw new Stop('repository_invalid', `expected exactly one server image in model/compose.yaml, got ${images.length}: ${images.join(', ')}`)
  }
  const image = images[0]
  if (image === undefined) throw new Error('commandImage: a list of one image has no element 0')
  return { server_image: image }
}

function commandSelect(argv: string[]): Results {
  const probeStatus = count(argv[0], 'probe exit status')
  const tierName = argv[1] === undefined || argv[1] === '' ? null : argv[1]
  const tiers = loadTiers()
  if (probeStatus !== 0) {
    throw new Stop(
      'no_gpu',
      `no NVIDIA GPU is available to containers on that machine: running nvidia-smi in a container with --gpus all exited ${probeStatus}`,
    )
  }
  const probe = parseProbe(readStdin())
  if (!probe.ok) throw new Stop('probe_unreadable', `nvidia-smi output not understood: ${probe.message}`)
  const selection = selectTier(probe.gpus, tiers, tierName)
  if (!selection.ok) throw new Stop(selection.reason, selection.message)
  const profile = loadProfile(selection.tier.profile)
  const retrieval = loadRetrieval()
  return {
    selected_tier: selection.tier.name,
    profile: selection.tier.profile,
    need_mib: selection.needMiB,
    free_mib: selection.freeMiB,
    total_mib: selection.gpu.memoryTotalMiB,
    used_mib: selection.gpu.memoryUsedMiB,
    gpu_name: selection.gpu.name,
    driver: selection.gpu.driverVersion,
    compute_cap: selection.gpu.computeCapability,
    model_id: profile.modelId,
    embed_model_id: retrieval.embed.modelId,
    rerank_model_id: retrieval.rerank.modelId,
    snapshot_path: snapshotPath(profile),
    embed_snapshot_path: snapshotPathOf(retrieval.embed.modelRepo, retrieval.embed.modelRevision),
    rerank_snapshot_path: snapshotPathOf(retrieval.rerank.modelRepo, retrieval.rerank.modelRevision),
  }
}

function commandDisk(argv: string[]): Results {
  const tierName = argv[0] ?? ''
  const probeStatus = count(argv[1], 'disk probe exit status')
  const imagePresent = yesNo(argv[2], 'image_present')
  const tiers = loadTiers()
  const tier = tiers.tiers.find((entry) => entry.name === tierName)
  if (tier === undefined) throw new Error(`disk: no tier named ${tierName}`)
  if (probeStatus === 125) {
    throw new Stop('cache_dir_missing', 'the cache directory does not exist on the GPU machine (docker could not mount it, exit 125)')
  }
  if (probeStatus !== 0) throw new Stop('disk_probe_failed', `the disk probe container exited ${probeStatus}`)
  const parsed = parseDiskProbe(readStdin())
  if (!parsed.ok) throw new Stop('disk_probe_failed', `disk probe output not understood: ${parsed.message}`)
  const { probe } = parsed
  const verdict = diskVerdict({
    weightsPresent: probe.weightsPresent,
    cacheFreeMiB: probe.cacheFreeMiB,
    downloadMiB: tier.downloadMiB,
    embedWeightsPresent: probe.embedWeightsPresent,
    embedDownloadMiB: tiers.embeddingDownloadMiB,
    rerankWeightsPresent: probe.rerankWeightsPresent,
    rerankDownloadMiB: tiers.rerankerDownloadMiB,
    imagePresent,
    dockerFreeMiB: probe.dockerFreeMiB,
    imageDiskMiB: tiers.imageDiskMiB,
  })
  if (!verdict.ok) throw new Stop('insufficient_disk', verdict.shortfalls.map((shortfall) => shortfall.message).join('\n'))
  return {
    uid: probe.ownerUid,
    gid: probe.ownerGid,
    cache_free_mib: probe.cacheFreeMiB,
    docker_free_mib: probe.dockerFreeMiB,
    weights_state: probe.weightsPresent ? 'present' : 'absent',
    embed_weights_state: probe.embedWeightsPresent ? 'present' : 'absent',
    rerank_weights_state: probe.rerankWeightsPresent ? 'present' : 'absent',
    weights_need_mib: verdict.weightsNeedMiB,
    image_state: imagePresent ? 'present' : 'absent',
    image_need_mib: verdict.imageNeedMiB,
  }
}

function commandHealth(argv: string[]): Results {
  const inspectStatus = count(argv[0], 'inspect exit status')
  const seconds = count(argv[1], 'seconds waited')
  const verdict = healthVerdict(inspectStatus === 0 ? (argv[2] ?? '') : null, seconds)
  if (verdict.verdict === 'failed') throw new Stop('not_healthy', verdict.reason)
  return { health: verdict.verdict }
}

function commandCapacity(argv: string[]): Results {
  const profile = loadProfile(argv[0] ?? '')
  const parsed = parseCapacity(readStdin())
  if (!parsed.ok) throw new Stop('capacity_short', parsed.message)
  const verdict = capacityVerdict(parsed.capacity, profile.maxModelLen, profile.maxNumSeqs)
  if (!verdict.ok) throw new Stop('capacity_short', verdict.message)
  return {
    kv_cache_tokens: parsed.capacity.tokens,
    context: parsed.capacity.context,
    concurrency: parsed.capacity.concurrency,
  }
}

function commandEmbedCapacity(): Results {
  const retrieval = loadRetrieval()
  const parsed = parseCapacity(readStdin())
  if (!parsed.ok) throw new Stop('capacity_short', `embedding server: ${parsed.message}`)
  const verdict = embedCapacityVerdict(parsed.capacity, retrieval.embed.maxModelLen)
  if (!verdict.ok) throw new Stop('capacity_short', verdict.message)
  return {
    kv_cache_tokens: parsed.capacity.tokens,
    context: parsed.capacity.context,
    concurrency: parsed.capacity.concurrency,
  }
}

function commandExitCode(argv: string[]): Outcome {
  const name = argv[0] ?? ''
  if (!isOutcome(name)) throw new Error(`exit-code: unknown outcome ${name}`)
  return name
}

function render(argv: string[]): void {
  const [bind, port, embedPort, rerankPort, cacheDir, uid, gid] = argv
  for (const [what, value] of [['port', port], ['embed_port', embedPort], ['rerank_port', rerankPort], ['uid', uid], ['gid', gid]] as const) {
    if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`render: ${what} must be an integer`)
  }
  const names = exampleNames()
  if (names.join(',') !== ENV_NAMES.join(',')) {
    throw new Error(`model/.env.example names ${names.join(', ')}; setup writes ${ENV_NAMES.join(', ')}`)
  }
  const result = renderEnv({
    bindAddress: bind ?? '',
    port: Number(port),
    embedPort: Number(embedPort),
    rerankPort: Number(rerankPort),
    cacheDir: cacheDir ?? '',
    runUid: Number(uid),
    runGid: Number(gid),
    apiKey: randomBytes(24).toString('hex'),
  })
  if (!result.ok) throw new Error(`model/.env not written: ${result.message}`)
  process.stdout.write(result.text)
}

function run(command: string | undefined, rest: string[]): Results {
  switch (command) {
    case 'args':
      return commandArgs(rest)
    case 'settings':
      return commandSettings(rest)
    case 'running':
      return commandRunning(rest)
    case 'image':
      return commandImage()
    case 'select':
      return commandSelect(rest)
    case 'disk':
      return commandDisk(rest)
    case 'health':
      return commandHealth(rest)
    case 'capacity':
      return commandCapacity(rest)
    case 'embed-capacity':
      return commandEmbedCapacity()
    default:
      throw new Error(`unknown command: ${String(command)}`)
  }
}

function finish(outcome: Outcome): void {
  emit({ outcome, exit_code: exitCodeFor(outcome) })
}

const [command, ...rest] = process.argv.slice(2)
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

if (command === 'render') {
  try {
    render(rest)
  } catch (error) {
    process.stderr.write(`setup: ${describe(error)}\n`)
    process.exitCode = 2
  }
} else {
  try {
    if (command === 'exit-code') {
      finish(commandExitCode(rest))
    } else {
      emit(run(command, rest))
      finish('ok')
    }
  } catch (error) {
    if (error instanceof Stop) {
      process.stderr.write(`setup: ${error.message}\n`)
      finish(error.outcome)
    } else {
      process.stderr.write(`setup: the setup tool failed: ${describe(error)}\n`)
      finish('tool_failed')
    }
  }
}
