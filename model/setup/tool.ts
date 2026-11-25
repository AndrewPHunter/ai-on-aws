// Command-line entry for the decisions behind model/setup.sh. The wrapper runs it in the pinned Node image
// on the local Docker daemon, with model/ mounted read-only at /m and no network.
//
// Usage: node tool.ts <command> [arguments]   (input, where a command takes any, on standard input)
//   args <uname -s> <uname -m> -- <setup.sh flags...>   choose the toolchain, parse and check the flags
//   settings <toolchain> <check> <keep_env> <bind> <port> <cache> <embed_port> <rerank_port>
//                                                       existing model/.env against the flags (yes/no switches)
//   running <host or "">                                the running-server guard, on the service of each running
//                                                       container of the lab's project (one per line)
//   image                                               the server image from `docker compose config --images`
//   select <probe_exit_status> <tier or "">            parse nvidia-smi output and select a tier
//   disk <tier> <probe_exit_status> <image_present>     parse the disk probe and give the disk verdict
//   health <inspect_exit_status> <seconds> <state>      the health verdict while a server starts
//   capacity <toolchain> <profile>                      vLLM's capacity line from the chat server's log, and the verdict
//   embed-capacity <toolchain>                          vLLM's capacity line from the embedding server's log, and the verdict
//   exit-code <outcome>                                 the exit code of an outcome the wrapper detected
//   render <bind> <port> <embed_port> <rerank_port> <cache> <uid> <gid>
//                                                       the text of an NVIDIA machine's model/.env, with a new key
//   Metal (model/metal/steps.sh):
//   metal-running                                       the running-server guard, on `ps -A -ww -o pid= -o command=`
//   ports                                               the ports something listens on (one per line); refused if any
//   metal-select <tier or ""> <macos_version> <memory_bytes>
//                                                       the machine check and the tier
//   metal-disk <tier> <ok|missing|unwritable>           parse the disk probe and give the disk verdict
//   metal-health <alive yes|no> <healthy yes|no> <seconds>
//                                                       the health verdict while a server starts
//   render-metal <port> <embed_port> <rerank_port> <cache> <uid> <gid>
//                                                       the text of a Mac's model/.env, with a new key
//
// Protocol (every command but render): results go to standard output as key=value lines (values free of
// newlines), ending with `outcome=<name>` and `exit_code=<n>`, where n is the code the outcome maps to
// (lib/outcome.ts). Messages go to standard error. When the tool ran, the process exits 0, refusals included;
// so a non-zero process exit always means the tool itself could not be started or loaded.
//
// render and render-metal write the text of model/.env, and nothing else, to standard output and exit 0; on any
// failure they write nothing there and exit 2. The API key is generated here and appears only in that text.

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

import { isLoopbackIpv4, parseArgs, portClash } from './lib/args.ts'
import { capacityVerdict, embedCapacityVerdict, parseCapacity } from './lib/capacity.ts'
import { diskVerdict, metalDiskVerdict, parseDiskProbe, parseMetalDiskProbe } from './lib/disk.ts'
import { baseUrl, ENV_NAMES, readEnv, renderEnv, TOOLCHAIN_NAMES, type EnvInput } from './lib/envfile.ts'
import { healthVerdict, metalHealthVerdict } from './lib/health.ts'
import { exitCodeFor, isOutcome, type Outcome } from './lib/outcome.ts'
import { parseProbe } from './lib/probe.ts'
import { readProfile, snapshotPath, snapshotPathOf, type Profile } from './lib/profile.ts'
import { readRetrieval, type Retrieval } from './lib/retrieval.ts'
import { metalRunningVerdict, runningVerdict } from './lib/running.ts'
import { selectMetalTier, selectTier } from './lib/select.ts'
import { validateMetalTiers, validateTiers, type MetalTiers, type Tiers } from './lib/tiers.ts'
import { CACHE_DEVICE, RETRIEVAL_ENV, recordedToolchain, TIERS_FILE, TOOLCHAINS, type Toolchain } from './lib/toolchain.ts'

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

function loadMetalTiers(): MetalTiers {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(fileIn(TIERS_FILE.metal), 'utf8'))
  } catch (error) {
    throw new Stop('tiers_invalid', `model/${TIERS_FILE.metal} could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const result = validateMetalTiers(raw)
  if (!result.ok) throw new Stop('tiers_invalid', `model/${TIERS_FILE.metal} is invalid:\n  ${result.errors.join('\n  ')}`)
  return result.tiers
}

// Only the two retrieval files the toolchains name are ever read; never a path taken from model/.env.
function loadRetrieval(toolchain: Toolchain): Retrieval {
  const path = RETRIEVAL_ENV[toolchain]
  let text: string
  try {
    text = readFileSync(fileIn(path), 'utf8')
  } catch {
    throw new Stop('repository_invalid', `model/${path} could not be read`)
  }
  const result = readRetrieval(text)
  if (!result.ok) throw new Stop('repository_invalid', `model/${path}: ${result.message}`)
  return result.retrieval
}

function toolchainArg(text: string | undefined): Toolchain {
  const known = TOOLCHAINS.find((name) => name === text)
  if (known === undefined) throw new Error(`toolchain must be ${TOOLCHAINS.join(' or ')}, got: ${String(text)}`)
  return known
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
  const [system, machine, separator, ...flags] = argv
  if (system === undefined || machine === undefined || separator !== '--') {
    throw new Error('args: expected <uname -s> <uname -m> -- before the flags')
  }
  // Only the chosen toolchain's tiers file is read.
  const tierNamesOf = (toolchain: Toolchain): string[] =>
    (toolchain === 'metal' ? loadMetalTiers().tiers : loadTiers().tiers).map((tier) => tier.name)
  const result = parseArgs(flags, { system, machine }, tierNamesOf)
  if (!result.ok) throw new Stop(result.reason, result.message)
  const { options } = result
  return {
    toolchain: options.toolchain,
    toolchain_reason: options.toolchainReason,
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
  const toolchain = toolchainArg(argv[0])
  const check = yesNo(argv[1], 'check')
  const keepEnv = yesNo(argv[2], 'keep_env')
  const envUrl = fileIn('.env')
  // On Metal the gate reaches the servers at host.docker.internal from its default network (invariant 19).
  const gateNetwork = (bind: string): string => (toolchain === 'nvidia' && isLoopbackIpv4(bind) ? 'host' : 'default')

  if (keepEnv) {
    if (!existsSync(envUrl)) throw new Stop('env_missing', '--keep-env was given but model/.env does not exist')
    const required = exampleNames().filter((name) => !(TOOLCHAIN_NAMES as readonly string[]).includes(name))
    const result = readEnv(readFileSync(envUrl, 'utf8'), required)
    if (!result.ok) {
      throw new Stop('env_missing', `model/.env does not define every variable of model/.env.example with a value: ${result.message}`)
    }
    const recorded = recordedToolchain(result.values, toolchain)
    if (!recorded.ok) throw new Stop(recorded.reason, recorded.message)
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
      gate_network: gateNetwork(bind),
      retrieval_env: recorded.retrievalEnv,
    }
  }
  if (!check && existsSync(envUrl)) {
    throw new Stop('env_present', 'model/.env already exists: delete it to write new settings, or pass --keep-env to use it as it is')
  }
  const bind = argv[3] ?? ''
  const port = argv[4] ?? ''
  const embedPort = argv[6] ?? ''
  const rerankPort = argv[7] ?? ''
  return {
    bind,
    port,
    embed_port: embedPort,
    rerank_port: rerankPort,
    cache_dir: argv[5] ?? '',
    base_url: baseUrl(toolchain, bind, port),
    embed_base_url: baseUrl(toolchain, bind, embedPort),
    rerank_base_url: baseUrl(toolchain, bind, rerankPort),
    gate_network: gateNetwork(bind),
    retrieval_env: RETRIEVAL_ENV[toolchain],
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

function commandMetalRunning(): Results {
  const verdict = metalRunningVerdict(readStdin())
  if (!verdict.ok) throw new Stop('server_running', verdict.message)
  return {}
}

function commandPorts(): Results {
  const inUse = [...new Set(readStdin().split('\n').map((line) => line.trim()).filter((line) => line !== ''))]
  if (inUse.length > 0) {
    throw new Stop(
      'port_in_use',
      `${inUse.length === 1 ? 'port' : 'ports'} ${inUse.join(', ')} of this Mac ${inUse.length === 1 ? 'is' : 'are'} taken (a connection to 127.0.0.1 was not refused): ` +
        'stop what holds it, or give setup other ports (--port, --embed-port, --rerank-port)',
    )
  }
  return {}
}

function commandMetalSelect(argv: string[]): Results {
  const tierName = argv[0] === undefined || argv[0] === '' ? null : argv[0]
  const tiers = loadMetalTiers()
  const selection = selectMetalTier(argv[1] ?? '', argv[2] ?? '', tiers, tierName)
  if (!selection.ok) throw new Stop(selection.reason, selection.message)
  const profile = loadProfile(selection.tier.profile)
  const retrieval = loadRetrieval('metal')
  return {
    selected_tier: selection.tier.name,
    profile: selection.tier.profile,
    need_mib: selection.needMiB,
    memory_mib: selection.memoryMiB,
    macos_version: (argv[1] ?? '').trim(),
    model_id: profile.modelId,
    embed_model_id: retrieval.embed.modelId,
    rerank_model_id: retrieval.rerank.modelId,
    chat_repo: profile.modelRepo,
    chat_revision: profile.modelRevision,
    embed_repo: retrieval.embed.modelRepo,
    embed_revision: retrieval.embed.modelRevision,
    rerank_repo: retrieval.rerank.modelRepo,
    rerank_revision: retrieval.rerank.modelRevision,
    snapshot_path: snapshotPath(profile),
    embed_snapshot_path: snapshotPathOf(retrieval.embed.modelRepo, retrieval.embed.modelRevision),
    rerank_snapshot_path: snapshotPathOf(retrieval.rerank.modelRepo, retrieval.rerank.modelRevision),
  }
}

function commandMetalDisk(argv: string[]): Results {
  const tierName = argv[0] ?? ''
  const cacheState = argv[1] ?? ''
  const tiers = loadMetalTiers()
  const tier = tiers.tiers.find((entry) => entry.name === tierName)
  if (tier === undefined) throw new Error(`metal-disk: no tier named ${tierName}`)
  if (cacheState === 'missing') throw new Stop('cache_dir_missing', 'the cache directory does not exist on this Mac')
  if (cacheState === 'unwritable') throw new Stop('cache_dir_unwritable', 'the cache directory is not writable by the user running setup')
  if (cacheState !== 'ok') throw new Error(`metal-disk: cache state must be ok, missing or unwritable, got: ${cacheState}`)
  const parsed = parseMetalDiskProbe(readStdin())
  if (!parsed.ok) throw new Stop('disk_probe_failed', `disk probe output not understood: ${parsed.message}`)
  const { probe } = parsed
  // The environment is setup's own: it counts as installed only when it was installed from this lock.
  const lockSha256 = createHash('sha256').update(readFileSync(fileIn('metal/requirements.txt'))).digest('hex')
  const environmentPresent = probe.stamp === lockSha256
  const verdict = metalDiskVerdict({
    cacheFreeMiB: probe.cacheFreeMiB,
    environmentPresent,
    environmentDiskMiB: tiers.environmentDiskMiB,
    weightsPresent: probe.weightsPresent,
    downloadMiB: tier.downloadMiB,
    embedWeightsPresent: probe.embedWeightsPresent,
    embedDownloadMiB: tiers.embeddingDownloadMiB,
    rerankWeightsPresent: probe.rerankWeightsPresent,
    rerankDownloadMiB: tiers.rerankerDownloadMiB,
  })
  if (!verdict.ok) throw new Stop('insufficient_disk', verdict.message)
  return {
    lock_sha256: lockSha256,
    env_state: environmentPresent ? 'present' : 'absent',
    cache_free_mib: probe.cacheFreeMiB,
    weights_state: probe.weightsPresent ? 'present' : 'absent',
    embed_weights_state: probe.embedWeightsPresent ? 'present' : 'absent',
    rerank_weights_state: probe.rerankWeightsPresent ? 'present' : 'absent',
    weights_need_mib: verdict.weightsNeedMiB,
    environment_need_mib: verdict.environmentNeedMiB,
  }
}

function commandMetalHealth(argv: string[]): Results {
  const verdict = metalHealthVerdict(yesNo(argv[0], 'alive'), yesNo(argv[1], 'healthy'), count(argv[2], 'seconds waited'))
  if (verdict.verdict === 'failed') throw new Stop('not_healthy', verdict.reason)
  return { health: verdict.verdict }
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
  const retrieval = loadRetrieval('nvidia')
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
  const toolchain = toolchainArg(argv[0])
  const profile = loadProfile(argv[1] ?? '')
  const parsed = parseCapacity(readStdin(), CACHE_DEVICE[toolchain])
  if (!parsed.ok) throw new Stop('capacity_short', parsed.message)
  const verdict = capacityVerdict(parsed.capacity, profile.maxModelLen, profile.maxNumSeqs)
  if (!verdict.ok) throw new Stop('capacity_short', verdict.message)
  return {
    kv_cache_tokens: parsed.capacity.tokens,
    context: parsed.capacity.context,
    concurrency: parsed.capacity.concurrency,
  }
}

function commandEmbedCapacity(argv: string[]): Results {
  const toolchain = toolchainArg(argv[0])
  const retrieval = loadRetrieval(toolchain)
  const parsed = parseCapacity(readStdin(), CACHE_DEVICE[toolchain])
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

// The text of model/.env for either toolchain: render takes the NVIDIA bind address, render-metal has none (the
// servers listen on the loopback address only).
function renderFor(command: 'render' | 'render-metal', argv: string[]): void {
  const metal = command === 'render-metal'
  const [bind, port, embedPort, rerankPort, cacheDir, uid, gid] = metal ? ['', ...argv] : argv
  for (const [what, value] of [['port', port], ['embed_port', embedPort], ['rerank_port', rerankPort], ['uid', uid], ['gid', gid]] as const) {
    if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${command}: ${what} must be an integer`)
  }
  const names = exampleNames()
  if (names.join(',') !== ENV_NAMES.join(',')) {
    throw new Error(`model/.env.example names ${names.join(', ')}; setup writes ${ENV_NAMES.join(', ')}`)
  }
  const common = {
    port: Number(port),
    embedPort: Number(embedPort),
    rerankPort: Number(rerankPort),
    cacheDir: cacheDir ?? '',
    runUid: Number(uid),
    runGid: Number(gid),
    apiKey: randomBytes(24).toString('hex'),
  }
  const input: EnvInput = metal ? { ...common, toolchain: 'metal' } : { ...common, toolchain: 'nvidia', bindAddress: bind ?? '' }
  const result = renderEnv(input)
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
      return commandEmbedCapacity(rest)
    case 'metal-running':
      return commandMetalRunning()
    case 'ports':
      return commandPorts()
    case 'metal-select':
      return commandMetalSelect(rest)
    case 'metal-disk':
      return commandMetalDisk(rest)
    case 'metal-health':
      return commandMetalHealth(rest)
    default:
      throw new Error(`unknown command: ${String(command)}`)
  }
}

function finish(outcome: Outcome): void {
  emit({ outcome, exit_code: exitCodeFor(outcome) })
}

const [command, ...rest] = process.argv.slice(2)
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

if (command === 'render' || command === 'render-metal') {
  try {
    renderFor(command, rest)
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
