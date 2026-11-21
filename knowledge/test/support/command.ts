// Runs the command line (cli.ts) against the stand-in, with waits that take no time, collecting its output.

import { runCommand } from '../../src/cli.ts'
import type { Folders } from './fixture.ts'
import { REPOSITORY, REVISION, USER_AGENT } from './fixture.ts'
import type { StandIn } from './standin.ts'

export function clientFlags(standIn: StandIn, dailymedConcurrency: string): string[] {
  return [
    '--raw-base', standIn.rawBase,
    '--dailymed-base', standIn.dailymedBase,
    '--user-agent', USER_AGENT,
    '--dailymed-concurrency', dailymedConcurrency,
    '--github-concurrency', '1',
    '--workers', '2',
    '--attempts', '3',
    '--waits-ms', '100,400',
    '--timeout-ms', '30000',
    '--zip-max-bytes', String(64 * 1024),
    '--xml-max-bytes', String(16 * 1024),
    '--benchmark-max-bytes', String(1024 * 1024),
  ]
}

export const pinArgs = (where: Folders, standIn: StandIn, dailymedConcurrency = '2'): string[] => [
  'pin',
  '--corpus', where.corpusDir,
  '--data', where.dataDir,
  '--repository', REPOSITORY,
  '--revision', REVISION,
  '--licence', 'Apache-2.0',
  '--labels-path', 'data/labels/labels.jsonl',
  '--qa-path', 'data/qa/qa.jsonl',
  ...clientFlags(standIn, dailymedConcurrency),
]

export const fetchArgs = (where: Folders, standIn: StandIn, dailymedConcurrency = '2'): string[] => [
  'fetch',
  '--corpus', where.corpusDir,
  '--data', where.dataDir,
  ...clientFlags(standIn, dailymedConcurrency),
]

export async function command(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = []
  const err: string[] = []
  const code = await runCommand(argv, {
    fetch: globalThis.fetch,
    sleep: async () => {},
    log: (line) => out.push(line),
    warn: (line) => err.push(line),
  })
  return { code, out, err }
}
