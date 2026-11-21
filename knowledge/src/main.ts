// Entry point of the three corpus commands (see cli.ts for the flags and exit codes). Gives the command line the
// platform's transport, real waiting, and the process's standard output and standard error.

import { setTimeout as delay } from 'node:timers/promises'

import { runCommand } from './cli.ts'

const code = await runCommand(process.argv.slice(2), {
  fetch: globalThis.fetch,
  sleep: async (ms) => {
    await delay(ms)
  },
  log: (line) => {
    process.stdout.write(`${line}\n`)
  },
  warn: (line) => {
    process.stderr.write(`${line}\n`)
  },
})
process.exitCode = code
