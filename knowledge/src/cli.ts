// The command line of the three corpus commands, run through knowledge/src/main.ts by knowledge/pin.sh, fetch.sh
// and census.sh in the pinned Node image. Every setting is a named flag, and every flag a command takes is
// required: nothing has a default. Input and output (the transport, waiting, the two output streams) are passed
// in, so the whole command line runs in tests against the stand-in.
//
//   node knowledge/src/main.ts pin    --corpus <dir> --data <dir> --repository <url> --revision <sha> --licence <id>
//                                     --labels-path <path> --qa-path <path> --benchmark-max-bytes <n> <client flags>
//   node knowledge/src/main.ts fetch  --corpus <dir> --data <dir> --benchmark-max-bytes <n> <client flags>
//   node knowledge/src/main.ts census --corpus <dir> --data <dir>
//
//   client flags: --raw-base <url> --dailymed-base <url> --user-agent <text> --dailymed-concurrency <n>
//                 --github-concurrency <n> --workers <n> --attempts <n> --waits-ms <n,n,...> --timeout-ms <n>
//                 --zip-max-bytes <n> --xml-max-bytes <n>
//
// Exit codes: 0 done; 1 done, with labels or files refused (fetch, census) or a request that failed (pin);
//             2 could not run (flags, or tracked files that do not pass the schema).

import { runCensus } from './census.ts'
import { InputError, fetchCorpus } from './fetch.ts'
import { PoliteClient } from './http.ts'
import { pin } from './pin.ts'

// DailyMed states no rate limit. This is the most requests this tool will ever have in flight to it.
const DAILYMED_MAX_CONCURRENCY = 4

const CLIENT_FLAGS = [
  'raw-base',
  'dailymed-base',
  'user-agent',
  'dailymed-concurrency',
  'github-concurrency',
  'workers',
  'attempts',
  'waits-ms',
  'timeout-ms',
  'zip-max-bytes',
  'xml-max-bytes',
] as const

const FLAGS = {
  pin: ['corpus', 'data', 'repository', 'revision', 'licence', 'labels-path', 'qa-path', 'benchmark-max-bytes', ...CLIENT_FLAGS],
  fetch: ['corpus', 'data', 'benchmark-max-bytes', ...CLIENT_FLAGS],
  census: ['corpus', 'data'],
} as const

type Command = keyof typeof FLAGS

class UsageError extends Error {}

function parseFlags(command: Command, args: readonly string[]): Map<string, string> {
  const allowed = new Set<string>(FLAGS[command])
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index] ?? ''
    const value = args[index + 1]
    if (!name.startsWith('--') || !allowed.has(name.slice(2))) throw new UsageError(`unknown flag for ${command}: ${name}`)
    if (value === undefined) throw new UsageError(`${name} needs a value`)
    if (flags.has(name.slice(2))) throw new UsageError(`${name} given twice`)
    flags.set(name.slice(2), value)
  }
  const missing = FLAGS[command].filter((flag) => !flags.has(flag))
  if (missing.length > 0) throw new UsageError(`${command} needs: ${missing.map((flag) => `--${flag}`).join(' ')}`)
  return flags
}

const text = (flags: Map<string, string>, name: string): string => {
  const value = flags.get(name)
  if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`)
  return value
}

const count = (flags: Map<string, string>, name: string): number => {
  const value = text(flags, name)
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be a whole number`)
  return Number(value)
}

export type CommandIo = {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  // Standard output and standard error, one line at a time.
  log: (line: string) => void
  warn: (line: string) => void
}

function clients(
  flags: Map<string, string>,
  io: CommandIo,
): { dailymed: PoliteClient; github: PoliteClient; workers: number } {
  const waitsMs = text(flags, 'waits-ms').split(',').map((part) => {
    if (!/^\d+$/.test(part)) throw new UsageError('--waits-ms must be whole numbers separated by commas')
    return Number(part)
  })
  const shared = {
    fetch: io.fetch,
    userAgent: text(flags, 'user-agent'),
    attempts: count(flags, 'attempts'),
    waitsMs,
    timeoutMs: count(flags, 'timeout-ms'),
    sleep: io.sleep,
  }
  return {
    dailymed: new PoliteClient({ ...shared, maxConcurrent: count(flags, 'dailymed-concurrency') }),
    github: new PoliteClient({ ...shared, maxConcurrent: count(flags, 'github-concurrency') }),
    workers: count(flags, 'workers'),
  }
}

// Runs one command and returns its exit code. Every flag is read and checked before any request is made.
export async function runCommand(argv: readonly string[], io: CommandIo): Promise<number> {
  try {
    return await run(argv, io)
  } catch (error) {
    io.warn(error instanceof Error ? error.message : 'failed')
    return error instanceof UsageError || error instanceof InputError ? 2 : 1
  }
}

async function run(argv: readonly string[], io: CommandIo): Promise<number> {
  const { log, warn } = io
  const [command, ...rest] = argv
  if (command !== 'pin' && command !== 'fetch' && command !== 'census') {
    throw new UsageError('the first argument must be pin, fetch or census')
  }
  const flags = parseFlags(command, rest)
  const corpusDir = text(flags, 'corpus')
  const dataDir = text(flags, 'data')

  if (command === 'census') {
    const { exitCode } = await runCensus({ corpusDir, dataDir, log, warn })
    return exitCode
  }

  const dailymedConcurrency = count(flags, 'dailymed-concurrency')
  if (dailymedConcurrency < 1 || dailymedConcurrency > DAILYMED_MAX_CONCURRENCY) {
    throw new UsageError(`--dailymed-concurrency must be from 1 to ${DAILYMED_MAX_CONCURRENCY}, not ${dailymedConcurrency}`)
  }
  const { dailymed, github, workers } = clients(flags, io)
  const caps = { zipBytes: count(flags, 'zip-max-bytes'), xmlBytes: count(flags, 'xml-max-bytes') }
  const started = process.hrtime.bigint()
  const requests = (): string => `requests sent: DailyMed ${dailymed.requests}, benchmark host ${github.requests}`
  const elapsed = (): string => `${Number((process.hrtime.bigint() - started) / 1_000_000n) / 1000} s`

  if (command === 'pin') {
    try {
      const result = await pin({
        corpusDir,
        dataDir,
        benchmark: {
          repository: text(flags, 'repository'),
          revision: text(flags, 'revision'),
          licence: text(flags, 'licence'),
          labelsPath: text(flags, 'labels-path'),
          qaPath: text(flags, 'qa-path'),
          rawBase: text(flags, 'raw-base'),
          maxBytes: count(flags, 'benchmark-max-bytes'),
        },
        dailymedBase: text(flags, 'dailymed-base'),
        caps,
        dailymed,
        github,
        workers,
        log: warn,
      })
      const reasons = new Map<string, number>()
      for (const entry of result.manifest.notPinned) reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1)
      log(`pinned ${result.manifest.labels.length}; not pinned ${result.manifest.notPinned.length}`)
      for (const [reason, n] of [...reasons.entries()].sort()) log(`  not pinned, ${reason}: ${n}`)
      log(requests())
      log(`time: ${elapsed()}`)
      return 0
    } catch (error) {
      warn(error instanceof Error ? error.message : 'pinning failed')
      warn(requests())
      return 1
    }
  }

  const { exitCode } = await fetchCorpus({
    corpusDir,
    dataDir,
    rawBase: text(flags, 'raw-base'),
    dailymedBase: text(flags, 'dailymed-base'),
    caps,
    benchmarkMaxBytes: count(flags, 'benchmark-max-bytes'),
    dailymed,
    github,
    workers,
    log,
    warn,
  })
  log(requests())
  log(`time: ${elapsed()}`)
  return exitCode
}
