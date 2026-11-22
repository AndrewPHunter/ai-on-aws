// Entry point of the evaluation commands (see cli.ts for the flags and exit codes). Gives the command line the
// platform's transport and clock, the process's environment, and its standard output and standard error.

import { runCommand } from './cli.ts';

process.exitCode = await runCommand(process.argv.slice(2), {
  fetch: globalThis.fetch,
  now: () => new Date(),
  env: process.env,
  log: (line) => {
    process.stdout.write(`${line}\n`);
  },
  warn: (line) => {
    process.stderr.write(`${line}\n`);
  },
});
