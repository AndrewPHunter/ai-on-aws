// The command line of the corpus commands, run through knowledge/src/main.ts by knowledge/pin.sh, fetch.sh,
// census.sh, parse.sh, chunk.sh and index.sh in the pinned Node image. Every setting is a named flag, and every flag a command takes is
// required: nothing has a default. Input and output (the transport, waiting, the two output streams) are passed
// in, so the whole command line runs in tests against the stand-in.
//
//   node knowledge/src/main.ts pin    --corpus <dir> --data <dir> --repository <url> --revision <sha> --licence <id>
//                                     --labels-path <path> --qa-path <path> --benchmark-max-bytes <n> <client flags>
//   node knowledge/src/main.ts fetch  --corpus <dir> --data <dir> --benchmark-max-bytes <n> <client flags>
//   node knowledge/src/main.ts census --corpus <dir> --data <dir>
//   node knowledge/src/main.ts parse  --corpus <dir> --data <dir>
//   node knowledge/src/main.ts chunk  --corpus <dir> --data <dir> --text-limit <words> --table-limit <words>
//   node knowledge/src/main.ts index  --data <dir> --search-url <url> --alias <name> --batch-size <n> --timeout-ms <n>
//
//   client flags: --raw-base <url> --dailymed-base <url> --user-agent <text> --dailymed-concurrency <n>
//                 --github-concurrency <n> --workers <n> --attempts <n> --waits-ms <n,n,...> --timeout-ms <n>
//                 --zip-max-bytes <n> --xml-max-bytes <n>
//
// Exit codes: 0 done (for parse and chunk: ran to the end, whatever the labels' results); 1 done, with labels or files
//             refused (fetch, census), a request that failed (pin), or an index whose count differed (index);
//             2 could not run (flags, tracked files that do not pass the schema, or a search engine that could not
//             be asked).

import { runCensus } from './census.ts'
import { runChunk } from './chunk/run.ts'
import { createEngine } from './search/engine.ts'
import { IndexingError, indexChunks } from './search/indexing.ts'
import { runParse } from './parse/run.ts'
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
  parse: ['corpus', 'data'],
  chunk: ['corpus', 'data', 'text-limit', 'table-limit'],
  index: ['data', 'search-url', 'alias', 'batch-size', 'timeout-ms'],
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
  if (command !== 'pin' && command !== 'fetch' && command !== 'census' && command !== 'parse' && command !== 'chunk' && command !== 'index') {
    throw new UsageError('the first argument must be pin, fetch, census, parse, chunk or index')
  }
  const flags = parseFlags(command, rest)
  const dataDir = text(flags, 'data')

  if (command === 'index') {
    const timeoutMs = count(flags, 'timeout-ms')
    const batchSize = count(flags, 'batch-size')
    if (timeoutMs < 1 || batchSize < 1) throw new UsageError('--timeout-ms and --batch-size must be at least 1')
    const engine = createEngine({ baseUrl: text(flags, 'search-url'), fetch: io.fetch, deadline: () => AbortSignal.timeout(timeoutMs) })
    const started = process.hrtime.bigint()
    try {
      const outcome = await indexChunks({ engine, dataDir, alias: text(flags, 'alias'), batchSize, log })
      for (const older of outcome.olderIndexes) log(`older index left in place: ${older}`)
      log(`time: ${Number((process.hrtime.bigint() - started) / 1_000_000n) / 1000} s`)
      return outcome.exitCode
    } catch (error) {
      if (error instanceof IndexingError) {
        warn(error.message)
        return 2
      }
      throw error
    }
  }

  const corpusDir = text(flags, 'corpus')

  if (command === 'census') {
    const { exitCode } = await runCensus({ corpusDir, dataDir, log, warn })
    return exitCode
  }

  if (command === 'chunk') {
    const settings = { textLimit: count(flags, 'text-limit'), tableLimit: count(flags, 'table-limit') }
    if (settings.textLimit < 1 || settings.tableLimit < 1) throw new UsageError('--text-limit and --table-limit must be at least 1')
    const started = process.hrtime.bigint()
    await runChunk({ corpusDir, dataDir, settings, log })
    log(`time: ${Number((process.hrtime.bigint() - started) / 1_000_000n) / 1000} s`)
    return 0
  }

  if (command === 'parse') {
    const started = process.hrtime.bigint()
    await runParse({ corpusDir, dataDir, log })
    log(`time: ${Number((process.hrtime.bigint() - started) / 1_000_000n) / 1000} s`)
    return 0
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
