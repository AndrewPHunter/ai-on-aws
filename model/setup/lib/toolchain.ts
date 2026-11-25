// The toolchain setup brings the servers up with (invariant 17). Pure: whether --host was given and the machine
// as `uname -s` and `uname -m` print it in; the toolchain and why, or the refusal, out. Nothing overrides it.

export const TOOLCHAINS = ['nvidia', 'metal'] as const
export type Toolchain = (typeof TOOLCHAINS)[number]

// On an Apple silicon Mac the servers listen on the loopback address only, and the lab's containers reach them by
// Docker Desktop's name for the Mac.
export const METAL_BIND = '127.0.0.1'
export const METAL_CLIENT_HOST = 'host.docker.internal'

// What differs by toolchain in the files setup reads, as paths under model/.
export const RETRIEVAL_ENV: Record<Toolchain, string> = { nvidia: 'retrieval.env', metal: 'metal/retrieval.env' }
export const TIERS_FILE: Record<Toolchain, string> = { nvidia: 'tiers.json', metal: 'metal/tiers.json' }
// The word vLLM's start-up capacity line begins with: "GPU KV cache size" on NVIDIA, "CPU KV cache size" on Metal.
export const CACHE_DEVICE: Record<Toolchain, 'GPU' | 'CPU'> = { nvidia: 'GPU', metal: 'CPU' }

export type ToolchainChoice = { ok: true; toolchain: Toolchain; reason: string } | { ok: false; message: string }

export function chooseToolchain(hostGiven: boolean, system: string, machine: string): ToolchainChoice {
  if (hostGiven) return { ok: true, toolchain: 'nvidia', reason: '--host names the Docker daemon of an NVIDIA GPU machine' }
  if (system === 'Darwin' && machine === 'arm64') {
    return { ok: true, toolchain: 'metal', reason: 'this machine is an Apple silicon Mac (Darwin arm64) and --host is not given' }
  }
  if (system === 'Linux') return { ok: true, toolchain: 'nvidia', reason: 'this machine runs Linux and --host is not given' }
  return {
    ok: false,
    message:
      `this machine (${system} ${machine}) is not supported: setup runs on Linux with an NVIDIA GPU, on an Apple silicon ` +
      'Mac (Darwin arm64), or with --host naming the Docker daemon of an NVIDIA GPU machine',
  }
}

export type RecordedToolchain =
  | { ok: true; toolchain: Toolchain; retrievalEnv: string }
  | { ok: false; reason: 'env_missing' | 'toolchain_mismatch'; message: string }

// The toolchain existing machine settings record, which --keep-env must find equal to the one chosen for this run.
// Settings that name neither MODEL_TOOLCHAIN nor MODEL_RETRIEVAL_ENV were written before there were two toolchains:
// they are an NVIDIA machine's, with model/retrieval.env.
export function recordedToolchain(values: ReadonlyMap<string, string>, chosen: Toolchain): RecordedToolchain {
  const toolchain = values.get('MODEL_TOOLCHAIN')
  const retrievalEnv = values.get('MODEL_RETRIEVAL_ENV')
  let recorded: Toolchain
  if (toolchain === undefined && retrievalEnv === undefined) {
    recorded = 'nvidia'
  } else {
    if (toolchain === undefined || retrievalEnv === undefined) {
      return { ok: false, reason: 'env_missing', message: 'model/.env names one of MODEL_TOOLCHAIN and MODEL_RETRIEVAL_ENV without the other' }
    }
    const known = TOOLCHAINS.find((name) => name === toolchain)
    if (known === undefined) {
      return { ok: false, reason: 'env_missing', message: `model/.env: MODEL_TOOLCHAIN is not ${TOOLCHAINS.join(' or ')}: ${toolchain}` }
    }
    if (retrievalEnv !== RETRIEVAL_ENV[known]) {
      return {
        ok: false,
        reason: 'env_missing',
        message: `model/.env: MODEL_RETRIEVAL_ENV must be ${RETRIEVAL_ENV[known]} for the ${known} toolchain, got: ${retrievalEnv}`,
      }
    }
    recorded = known
  }
  if (recorded !== chosen) {
    return {
      ok: false,
      reason: 'toolchain_mismatch',
      message:
        `model/.env records the ${recorded} toolchain, but this run takes the ${chosen} toolchain: ` +
        'delete model/.env to set this machine up, or run setup where the settings were written',
    }
  }
  return { ok: true, toolchain: recorded, retrievalEnv: RETRIEVAL_ENV[recorded] }
}
