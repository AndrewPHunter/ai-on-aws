// Command-line flags of model/setup.sh (contract section 1). Pure: argv and the known tier names in,
// options or a usage error out.

import { isEnvSafe } from './envfile.ts'

export type Options = {
  cacheDir: string | null // null only with --keep-env
  bind: string | null // null only with --keep-env (read from model/.env)
  port: number | null // null only with --keep-env (read from model/.env)
  host: string | null
  tier: string | null
  check: boolean
  keepEnv: boolean
}

export type ParseResult = { ok: true; options: Options } | { ok: false; message: string }

export const DEFAULT_BIND = '127.0.0.1'
export const DEFAULT_PORT = 8000

const VALUE_FLAGS = ['--cache-dir', '--bind', '--port', '--host', '--tier'] as const
const SWITCH_FLAGS = ['--check', '--keep-env'] as const

type ValueFlag = (typeof VALUE_FLAGS)[number]
type SwitchFlag = (typeof SWITCH_FLAGS)[number]

function isValueFlag(token: string): token is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(token)
}

function isSwitchFlag(token: string): token is SwitchFlag {
  return (SWITCH_FLAGS as readonly string[]).includes(token)
}

export function isIpv4(text: string): boolean {
  const parts = text.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)
}

export function isLoopbackIpv4(text: string): boolean {
  return isIpv4(text) && text.split('.')[0] === '127'
}

function fail(message: string): ParseResult {
  return { ok: false, message }
}

export function parseArgs(argv: readonly string[], tierNames: readonly string[]): ParseResult {
  const values = new Map<ValueFlag, string>()
  const switches = new Set<SwitchFlag>()

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === undefined) throw new Error(`parseArgs: argv has no element at index ${i} < argv.length`)
    if (isValueFlag(token)) {
      if (values.has(token)) return fail(`${token} is given twice`)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return fail(`${token} needs a value`)
      values.set(token, value)
      i++
    } else if (isSwitchFlag(token)) {
      if (switches.has(token)) return fail(`${token} is given twice`)
      switches.add(token)
    } else {
      return fail(`unknown flag: ${token}`)
    }
  }

  const keepEnv = switches.has('--keep-env')
  const check = switches.has('--check')
  const cacheDir = values.get('--cache-dir') ?? null
  const bindGiven = values.get('--bind') ?? null
  const portGiven = values.get('--port') ?? null
  const host = values.get('--host') ?? null
  const tier = values.get('--tier') ?? null

  if (keepEnv) {
    for (const flag of ['--cache-dir', '--bind', '--port'] as const) {
      if (values.has(flag)) return fail(`${flag} is not accepted with --keep-env (the value comes from model/.env)`)
    }
  } else {
    if (cacheDir === null) return fail('--cache-dir is required (or pass --keep-env to use the existing model/.env)')
    if (!cacheDir.startsWith('/')) return fail(`--cache-dir must be an absolute path, got: ${cacheDir}`)
    if (!isEnvSafe(cacheDir)) {
      return fail(`--cache-dir must not contain whitespace, quotes, "#", "$" or a backslash (it is written to model/.env), got: ${JSON.stringify(cacheDir)}`)
    }
    if (bindGiven !== null && !isIpv4(bindGiven)) return fail(`--bind must be an IPv4 address, got: ${bindGiven}`)
    if (host !== null && bindGiven === null) {
      return fail('--bind is required with --host: give the GPU machine address the server is published on')
    }
    if (host !== null && bindGiven !== null && isLoopbackIpv4(bindGiven)) {
      return fail(`--bind must not be a loopback address with --host, got: ${bindGiven}`)
    }
    if (portGiven !== null && !/^[1-9][0-9]*$/.test(portGiven)) {
      return fail(`--port must be an integer from 1 to 65535, got: ${portGiven}`)
    }
    if (portGiven !== null && Number(portGiven) > 65535) {
      return fail(`--port must be an integer from 1 to 65535, got: ${portGiven}`)
    }
  }

  if (tier !== null && !tierNames.includes(tier)) {
    return fail(`--tier names no tier in model/tiers.json: ${tier} (tiers: ${tierNames.join(', ')})`)
  }

  return {
    ok: true,
    options: {
      cacheDir,
      bind: keepEnv ? null : (bindGiven ?? DEFAULT_BIND),
      port: keepEnv ? null : portGiven === null ? DEFAULT_PORT : Number(portGiven),
      host,
      tier,
      check,
      keepEnv,
    },
  }
}
