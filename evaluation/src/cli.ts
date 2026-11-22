// The command line of the evaluation commands, run through evaluation/src/main.ts by the scripts in evaluation/.
// Every setting is a named flag; nothing has a default. The runner's identity secrets come from the environment it is
// given (platform/identity/.env, passed by Compose). Input and output (the transport, the clock, the environment, the
// two output streams) are passed in, so the whole command line runs in tests.
//
//   node evaluation/src/main.ts sample  --qa <file> --manifest <file> --settings <file> --out <file> [--record]
//   node evaluation/src/main.ts run     --sample <file> --run-dir <dir> --agent-url <url> [--retry-failed]
//   node evaluation/src/main.ts score   --sample <file> --run-dir <dir> --knowledge-data <dir>
//   node evaluation/src/main.ts compare --run-a <dir> --run-b <dir>
//   node evaluation/src/main.ts judge-prepare --sample <file> --run-dir <dir> [--retry-failed]
//   node evaluation/src/main.ts judge-collect --run-dir <dir>
//   node evaluation/src/main.ts judge-check   --sample <file> --run-dir <dir> --count <n>
//
// Exit codes: 0 done; 1 done with failures (run: calls that failed; judge-collect: judge calls that failed);
//             2 could not run. Output is counts, codes, identifiers and file names: never a question, an answer, a
//             reply or a judge's reason.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { InputError, manifestSetIds, parseQuestions, readText } from './benchmark.ts';
import type { Question } from './benchmark.ts';
import { compareScores, formatComparison } from './compare.ts';
import { CHECK_FILE, checkFile, collectJudging, personVerdicts, prepareJudging, readJudgments, toJudge } from './judge.ts';
import { RUN_FILE, readRecords, runQuestions } from './run.ts';
import type { RunFile } from './run.ts';
import { drawSample, sampleDifference, sampleSettingsSchema } from './sample.ts';
import { scoreRun } from './score.ts';
import type { Scores } from './score.ts';
import { readSections } from './sections.ts';
import { SignInFailed, TokenSource, signIn } from './sign-in.ts';
import { formatScores } from './table.ts';

export type CommandIo = {
  fetch: typeof fetch;
  now: () => Date;
  log: (line: string) => void;
  warn: (line: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  // How the runner gets a token; signs in as the gates do unless a test gives its own.
  signIn?: () => Promise<{ token: string; expiresAt: number }>;
};

class UsageError extends Error {}

const FLAGS: Record<string, { required: string[]; switches: string[] }> = {
  sample: { required: ['qa', 'manifest', 'settings', 'out'], switches: ['record'] },
  run: { required: ['sample', 'run-dir', 'agent-url'], switches: ['retry-failed'] },
  score: { required: ['sample', 'run-dir', 'knowledge-data'], switches: [] },
  compare: { required: ['run-a', 'run-b'], switches: [] },
  'judge-prepare': { required: ['sample', 'run-dir'], switches: ['retry-failed'] },
  'judge-collect': { required: ['run-dir'], switches: [] },
  'judge-check': { required: ['sample', 'run-dir', 'count'], switches: [] },
};

function parseFlags(command: string, args: readonly string[]): { values: Map<string, string>; switches: Set<string> } {
  const spec = FLAGS[command];
  if (spec === undefined) throw new UsageError(`the first argument must be one of ${Object.keys(FLAGS).join(', ')}`);
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let at = 0; at < args.length; at++) {
    const name = (args[at] ?? '').replace(/^--/, '');
    if (!(args[at] ?? '').startsWith('--')) throw new UsageError(`unexpected argument for ${command}`);
    if (spec.switches.includes(name)) {
      switches.add(name);
      continue;
    }
    if (!spec.required.includes(name)) throw new UsageError(`unknown flag for ${command}: --${name}`);
    const value = args[at + 1];
    if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`);
    values.set(name, value);
    at++;
  }
  const missing = spec.required.filter((name) => !values.has(name));
  if (missing.length > 0) throw new UsageError(`${command} needs: ${missing.map((name) => `--${name}`).join(' ')}`);
  return { values, switches };
}

const flag = (values: Map<string, string>, name: string): string => values.get(name) ?? '';

async function readSample(path: string): Promise<{ questions: Question[]; sha256: string }> {
  const bytes = await readText(path, 'evaluation/data/sample.jsonl');
  return { questions: parseQuestions(bytes.toString('utf8'), 'evaluation/data/sample.jsonl'), sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function readRunFile(runDir: string): Promise<RunFile> {
  try {
    return JSON.parse(await readFile(join(runDir, RUN_FILE), 'utf8')) as RunFile;
  } catch {
    throw new InputError(`the run ${basename(runDir)} has no ${RUN_FILE}: run evaluation/run.sh first`);
  }
}

async function scoresOf(runDir: string): Promise<Scores> {
  try {
    return JSON.parse(await readFile(join(runDir, 'scores.json'), 'utf8')) as Scores;
  } catch {
    throw new InputError(`the run ${basename(runDir)} has no scores.json: run evaluation/score.sh first`);
  }
}

export async function runCommand(argv: readonly string[], io: CommandIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (error) {
    // Only this harness's own messages are written: they name files, lines, counts and codes.
    if (error instanceof UsageError || error instanceof InputError || error instanceof SignInFailed) io.warn(error.message);
    else io.warn(`could not run: an unexpected ${error instanceof Error ? error.name : 'error'}`);
    return 2;
  }
}

async function run(argv: readonly string[], io: CommandIo): Promise<number> {
  const [command = '', ...rest] = argv;
  const { values, switches } = parseFlags(command, rest);

  if (command === 'sample') {
    const qa = await readText(flag(values, 'qa'), 'knowledge/data/benchmark/qa.jsonl');
    const manifest = await readText(flag(values, 'manifest'), 'knowledge/corpus/manifest.json');
    const settingsText = await readText(flag(values, 'settings'), 'evaluation/sample.json');
    let settingsValue: unknown;
    try {
      settingsValue = JSON.parse(settingsText.toString('utf8'));
    } catch {
      throw new InputError('evaluation/sample.json is not JSON');
    }
    const settings = sampleSettingsSchema.safeParse(settingsValue);
    if (!settings.success) throw new InputError('evaluation/sample.json is not sample settings');
    const hashes = { qa: createHash('sha256').update(qa).digest('hex'), manifest: createHash('sha256').update(manifest).digest('hex') };
    const sample = drawSample(parseQuestions(qa.toString('utf8'), 'knowledge/data/benchmark/qa.jsonl'), manifestSetIds(manifest.toString('utf8')), settings.data);
    const qids = sample.map((question) => question.qid);
    if (switches.has('record')) {
      await writeFile(flag(values, 'settings'), `${JSON.stringify({ ...settings.data, drawnFrom: hashes, qids }, null, 2)}\n`);
      io.log(`recorded ${qids.length} qids in evaluation/sample.json: commit it`);
    } else {
      const difference = sampleDifference(qids, settings.data, hashes);
      if (difference !== null) throw new InputError(difference);
    }
    await mkdir(dirname(flag(values, 'out')), { recursive: true });
    await writeFile(flag(values, 'out'), sample.map((question) => `${JSON.stringify(question)}\n`).join(''));
    const counts = Object.entries(settings.data.strata).map(([type, count]) => `${type} ${count}`).join(', ');
    io.log(`sample: ${qids.length} questions (${counts})`);
    return 0;
  }

  if (command === 'run') {
    const { questions, sha256 } = await readSample(flag(values, 'sample'));
    const runDir = flag(values, 'run-dir');
    await mkdir(runDir, { recursive: true });
    const nowMs = (): number => io.now().getTime();
    let get = io.signIn;
    if (get === undefined) {
      const secret = io.env.IDENTITY_DESK_CLIENT_SECRET;
      const password = io.env.IDENTITY_DANA_PASSWORD;
      if (!secret || !password) throw new UsageError('IDENTITY_DESK_CLIENT_SECRET and IDENTITY_DANA_PASSWORD must be set (evaluation/run.sh passes them)');
      get = () => signIn(secret, password, nowMs);
    }
    const tokens = new TokenSource(get, nowMs);
    const result = await runQuestions({
      questions,
      sampleSha256: sha256,
      runDir,
      agentUrl: flag(values, 'agent-url').replace(/\/+$/, ''),
      token: () => tokens.token(),
      retryFailed: switches.has('retry-failed'),
      now: io.now,
      fetch: io.fetch,
      log: io.log,
    });
    return result.exitCode;
  }

  if (command === 'score') {
    const { questions } = await readSample(flag(values, 'sample'));
    const runDir = flag(values, 'run-dir');
    await readRunFile(runDir);
    const records = await readRecords(runDir);
    const sections = await readSections(flag(values, 'knowledge-data'), new Set(questions.map((question) => question.set_id)));
    const judgments = await readJudgments(runDir);
    let verdicts = null;
    try {
      verdicts = personVerdicts(await readFile(join(runDir, CHECK_FILE), 'utf8'));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new InputError(error instanceof Error ? error.message : `${CHECK_FILE} could not be read`);
    }
    const scores = scoreRun({ questions, records, sections, judgments, personVerdicts: verdicts });
    await writeFile(join(runDir, 'scores.json'), `${JSON.stringify(scores, null, 2)}\n`);
    for (const line of formatScores(scores)) io.log(line);
    return 0;
  }

  if (command === 'compare') {
    const runA = flag(values, 'run-a');
    const runB = flag(values, 'run-b');
    const [fileA, fileB] = [await readRunFile(runA), await readRunFile(runB)];
    if (fileA.sample_sha256 !== fileB.sample_sha256) throw new InputError(`the runs ${basename(runA)} and ${basename(runB)} were made on different samples`);
    const rows = compareScores(await scoresOf(runA), await scoresOf(runB));
    const lines = formatComparison(basename(runA), basename(runB), rows);
    await writeFile(join(runB, `compare-${basename(runA)}.json`), `${JSON.stringify({ runA: basename(runA), runB: basename(runB), rows }, null, 2)}\n`);
    for (const line of lines) io.log(line);
    return 0;
  }

  if (command === 'judge-prepare') {
    const { questions } = await readSample(flag(values, 'sample'));
    const runDir = flag(values, 'run-dir');
    await readRunFile(runDir);
    const count = await prepareJudging(runDir, questions, await readRecords(runDir), switches.has('retry-failed'));
    io.log(`to judge: ${count}`);
    return 0;
  }

  if (command === 'judge-collect') {
    let outcome: { judged: number; failures: number };
    try {
      outcome = await collectJudging(flag(values, 'run-dir'));
    } catch (error) {
      throw new InputError(error instanceof Error && error.message.startsWith('the adapter') ? error.message : 'the judge calls could not be read back');
    }
    io.log(`judged: ${outcome.judged}; judge failures: ${outcome.failures}`);
    return outcome.failures === 0 ? 0 : 1;
  }

  // judge-check
  const countText = flag(values, 'count');
  if (!/^[1-9]\d*$/.test(countText)) throw new UsageError('--count must be a whole number of 1 or more');
  const { questions } = await readSample(flag(values, 'sample'));
  const runDir = flag(values, 'run-dir');
  const judgments = await readJudgments(runDir);
  if (judgments === null) throw new InputError(`the run ${basename(runDir)} has no judgments: run evaluation/judge.sh first`);
  const text = checkFile(toJudge(questions, await readRecords(runDir)), judgments, Number(countText));
  await writeFile(join(runDir, CHECK_FILE), text);
  io.log(`wrote ${CHECK_FILE} beside the run: fill in person_verdict, then run evaluation/score.sh`);
  return 0;
}
