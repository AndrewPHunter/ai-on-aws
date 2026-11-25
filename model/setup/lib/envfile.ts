// Reading env files (model/.env, model/.env.example, model/profiles/*.env) and rendering model/.env.
// Pure: text in, values out. File reading and the random key are at the edge, in tool.ts.

import { METAL_BIND, METAL_CLIENT_HOST, RETRIEVAL_ENV, type Toolchain } from './toolchain.ts'

export type EnvReadResult = { ok: true; values: Map<string, string> } | { ok: false; message: string }

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

// Lines are NAME=value, blank, or comments starting with "#". The value is taken as written.
// `required` names variables that must be defined with a non-empty value; other variables may be empty.
export function readEnv(text: string, required: readonly string[]): EnvReadResult {
  const values = new Map<string, string>()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw === undefined) throw new Error(`readEnv: no line at index ${i} < lines.length`)
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = ASSIGNMENT.exec(line)
    if (match === null) return { ok: false, message: `line ${i + 1} is not NAME=value` }
    const [, name, value] = match
    if (name === undefined || value === undefined) throw new Error('readEnv: an assignment matched without its name and value groups')
    if (values.has(name)) return { ok: false, message: `${name} is defined more than once` }
    values.set(name, value)
  }
  for (const name of required) {
    if (!values.has(name)) return { ok: false, message: `${name} is missing` }
    if (values.get(name) === '') return { ok: false, message: `${name} is empty` }
  }
  return { ok: true, values }
}

// On NVIDIA the bind address is given; on Metal it is always the loopback address (invariant 19).
export type EnvInput = {
  port: number
  embedPort: number
  rerankPort: number
  cacheDir: string
  runUid: number
  runGid: number
  apiKey: string
} & ({ toolchain: 'nvidia'; bindAddress: string } | { toolchain: 'metal' })

export type RenderResult = { ok: true; text: string } | { ok: false; message: string }

// How clients in the lab's containers reach a server: at its bind address on NVIDIA, and at Docker Desktop's name
// for the Mac on Metal, where the servers listen on the Mac's loopback address.
export function baseUrl(toolchain: Toolchain, bindAddress: string, port: number | string): string {
  return `http://${toolchain === 'metal' ? METAL_CLIENT_HOST : bindAddress}:${port}/v1`
}

// Written by both toolchains, and optional when read: settings without them are an NVIDIA machine's.
export const TOOLCHAIN_NAMES = ['MODEL_TOOLCHAIN', 'MODEL_RETRIEVAL_ENV'] as const

// Exactly the variables of model/.env.example, in its order.
export const ENV_NAMES = [
  'MODEL_BIND_ADDRESS',
  'MODEL_PORT',
  'MODEL_EMBED_PORT',
  'MODEL_RERANK_PORT',
  'MODEL_CACHE_DIR',
  'MODEL_RUN_UID',
  'MODEL_RUN_GID',
  'MODEL_API_KEY',
  'MODEL_BASE_URL',
  'MODEL_EMBED_BASE_URL',
  'MODEL_RERANK_BASE_URL',
  ...TOOLCHAIN_NAMES,
] as const

// Characters that an env file reader (Docker Compose's included) would treat specially.
const UNSAFE = /[\s'"`#$\\]/

// True when the value can be written to model/.env as it is: non-empty, and none of the characters above.
export function isEnvSafe(value: string): boolean {
  return value !== '' && !UNSAFE.test(value)
}

export function renderEnv(input: EnvInput): RenderResult {
  const bind = input.toolchain === 'metal' ? METAL_BIND : input.bindAddress
  const values: Record<(typeof ENV_NAMES)[number], string> = {
    MODEL_BIND_ADDRESS: bind,
    MODEL_PORT: String(input.port),
    MODEL_EMBED_PORT: String(input.embedPort),
    MODEL_RERANK_PORT: String(input.rerankPort),
    MODEL_CACHE_DIR: input.cacheDir,
    MODEL_RUN_UID: String(input.runUid),
    MODEL_RUN_GID: String(input.runGid),
    MODEL_API_KEY: input.apiKey,
    MODEL_BASE_URL: baseUrl(input.toolchain, bind, input.port),
    MODEL_EMBED_BASE_URL: baseUrl(input.toolchain, bind, input.embedPort),
    MODEL_RERANK_BASE_URL: baseUrl(input.toolchain, bind, input.rerankPort),
    MODEL_TOOLCHAIN: input.toolchain,
    MODEL_RETRIEVAL_ENV: RETRIEVAL_ENV[input.toolchain],
  }
  for (const name of ENV_NAMES) {
    const value = values[name]
    if (value === '') return { ok: false, message: `${name} would be empty` }
    if (UNSAFE.test(value)) {
      return { ok: false, message: `${name} contains a character not allowed in model/.env (whitespace, quote, #, $ or backslash)` }
    }
  }
  const lines = [
    '# Written by model/setup.sh. Machine-specific; never commit this file.',
    ...ENV_NAMES.map((name) => `${name}=${values[name]}`),
  ]
  return { ok: true, text: `${lines.join('\n')}\n` }
}
