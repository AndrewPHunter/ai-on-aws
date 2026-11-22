// The command line of the evaluation commands, run through evaluation/src/main.ts by the scripts in evaluation/.
// Every setting is a named flag; nothing has a default. The runner's identity secrets come from the environment it is
// given (platform/identity/.env, passed by Compose). Input and output (the transport, the clock, the environment, the
// two output streams) are passed in, so the whole command line runs in tests.
//
//   node evaluation/src/main.ts sample  --qa <file> --manifest <file> --settings <file> --out <file> [--record]
//   node evaluation/src/main.ts run     --sample <file> --variant <original|reworded> --run-dir <dir> --agent-url <url> [--retry-failed]
//   node evaluation/src/main.ts score   --sample <file> --run-dir <dir> --knowledge-data <dir>
//   node evaluation/src/main.ts compare --run-a <dir> --run-b <dir> [--only-reworded]
//   node evaluation/src/main.ts judge-prepare --sample <file> --run-dir <dir> --rubric <name> [--retry-failed]
//   node evaluation/src/main.ts judge-collect --run-dir <dir> --rubric <name>
//   node evaluation/src/main.ts judge-check   --sample <file> --run-dir <dir> --rubric <name> --count <n>
//   node evaluation/src/main.ts reword-prepare       --sample <file> --qa <file> --pending <dir>
//   node evaluation/src/main.ts reword-check-prepare --sample <file> --qa <file> --pending <dir>
//   node evaluation/src/main.ts reword-collect       --sample <file> --qa <file> --pending <dir>
//   node evaluation/src/main.ts reword-check         --sample <file> --count <n>
//
// --sample is always the original sample's file (evaluation/data/sample.jsonl); the reworded variant's file sits
// beside it (variant.ts). A command that reads a run reads the file of the run's own variant, and refuses a run whose
// variant file has changed since the run was made.
//
// Exit codes: 0 done; 1 done with failures (run: calls that failed; judge-collect, reword-collect: model calls that
//             failed); 2 could not run. Output is counts, codes, identifiers and file names: never a question, an
//             answer, a reply, a rewrite or a model's reason.

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { InputError, benchmarkExtras, manifestSetIds, parseQuestions, readText } from './benchmark.ts';
import type { BenchmarkExtra, Question } from './benchmark.ts';
import { compareByThird, compareScores, formatComparison } from './compare.ts';
import { checkFile, checkFileName, collectJudging, personAnswers, personVerdicts, prepareJudging, readCheckFile, readJudgments, toJudge } from './judge.ts';
import { wordingOverlap } from './overlap.ts';
import type { Cuts } from './overlap.ts';
import { REWORD_CHECK_FILE, collectRewording, prepareChecks, prepareRewording, rewordCheckFile, rewordInstructionsSha256, rewriterDescribeSchema } from './reword.ts';
import type { OverlapSummary } from './reword.ts';
import { isRubricName } from './rubric.ts';
import type { RubricName } from './rubric.ts';
import { RUN_FILE, readRecords, runQuestions } from './run.ts';
import type { RunFile } from './run.ts';
import { drawSample, sampleDifference, sampleSettingsSchema } from './sample.ts';
import { isRefusal, scoreRun } from './score.ts';
import type { Scores } from './score.ts';
import { readSections } from './sections.ts';
import { SignInFailed, TokenSource, signIn } from './sign-in.ts';
import { formatScores } from './table.ts';
import { REWORDED_FILE, isVariant, readVariant, variantPath } from './variant.ts';
import type { Variant, VariantSample } from './variant.ts';

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
  run: { required: ['sample', 'variant', 'run-dir', 'agent-url'], switches: ['retry-failed'] },
  score: { required: ['sample', 'run-dir', 'knowledge-data'], switches: [] },
  compare: { required: ['run-a', 'run-b'], switches: ['only-reworded'] },
  'judge-prepare': { required: ['sample', 'run-dir', 'rubric'], switches: ['retry-failed'] },
  'judge-collect': { required: ['run-dir', 'rubric'], switches: [] },
  'judge-check': { required: ['sample', 'run-dir', 'rubric', 'count'], switches: [] },
  'reword-prepare': { required: ['sample', 'qa', 'pending'], switches: [] },
  'reword-check-prepare': { required: ['sample', 'qa', 'pending'], switches: [] },
  'reword-collect': { required: ['sample', 'qa', 'pending'], switches: [] },
  'reword-check': { required: ['sample', 'count'], switches: [] },
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

function rubricFlag(values: Map<string, string>): RubricName {
  const value = flag(values, 'rubric');
  if (!isRubricName(value)) throw new UsageError(`--rubric must be completeness or answers-question`);
  return value;
}

function countFlag(values: Map<string, string>): number {
  const countText = flag(values, 'count');
  if (!/^[1-9]\d*$/.test(countText)) throw new UsageError('--count must be a whole number of 1 or more');
  return Number(countText);
}

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

const variantOf = (file: RunFile): Variant => file.variant ?? 'original';

// The run's own variant's sample, refused when that file has changed since the run was made.
async function readRunSample(samplePath: string, runDir: string): Promise<VariantSample> {
  const file = await readRunFile(runDir);
  const sample = await readVariant(samplePath, variantOf(file));
  if (sample.sha256 !== file.sample_sha256) {
    throw new InputError(`the run ${basename(runDir)} was made on the ${sample.variant} sample, and that file has changed since (its SHA-256 differs from the run's)`);
  }
  return sample;
}

// A run's scores. A scores.json written before variants and wording overlap existed has neither: it is read as a run
// on the original sample, with no overlap and nothing reworded.
async function scoresOf(runDir: string): Promise<Scores> {
  let scores: Partial<Scores> & Pick<Scores, 'perQuestion'>;
  try {
    scores = JSON.parse(await readFile(join(runDir, 'scores.json'), 'utf8')) as Partial<Scores> & Pick<Scores, 'perQuestion'>;
  } catch {
    throw new InputError(`the run ${basename(runDir)} has no scores.json: run evaluation/score.sh first`);
  }
  return { ...scores, variant: scores.variant ?? 'original', overlap: scores.overlap ?? null, rewordedQids: scores.rewordedQids ?? [] } as Scores;
}

async function readExtras(qaPath: string, shown: string, questions: readonly Question[]): Promise<Map<string, BenchmarkExtra>> {
  const qa = await readText(qaPath, shown);
  return benchmarkExtras(qa.toString('utf8'), shown, new Set(questions.map((question) => question.qid)));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const pct = (value: number | null): string => (value === null ? '-' : `${(value * 100).toFixed(1)}%`);
const cutsText = (cuts: Cuts | null): string => (cuts === null ? 'no thirds' : `thirds cut at ${pct(cuts.low)} and ${pct(cuts.high)}`);
const overlapText = (summary: OverlapSummary): string => `median ${pct(summary.median)} over ${summary.questions} questions; in the original's thirds: ${summary.inThirds.join(', ')}`;

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
    const variant = flag(values, 'variant');
    if (!isVariant(variant)) throw new UsageError('--variant must be original or reworded');
    const { questions, sha256 } = await readVariant(flag(values, 'sample'), variant);
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
    io.log(`sample variant: ${variant}`);
    const result = await runQuestions({
      questions,
      variant,
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
    const runDir = flag(values, 'run-dir');
    const sample = await readRunSample(flag(values, 'sample'), runDir);
    const { questions } = sample;
    const records = await readRecords(runDir);
    const knowledgeData = flag(values, 'knowledge-data');
    const sections = await readSections(knowledgeData, new Set(questions.map((question) => question.set_id)));
    const answerable = questions.filter((question) => !isRefusal(question));
    const extras = await readExtras(join(knowledgeData, 'benchmark', 'qa.jsonl'), 'knowledge/data/benchmark/qa.jsonl', answerable);
    const overlap = new Map(
      answerable.map((question) => {
        const extra = extras.get(question.qid);
        return [question.qid, extra === undefined ? null : wordingOverlap(question.question, extra.drugName, extra.context)] as const;
      }),
    );
    const checks = async <T>(rubric: RubricName, read: (text: string, name: string) => T): Promise<T | null> => {
      const found = await readCheckFile(runDir, rubric);
      if (found === null) return null;
      try {
        return read(found.text, found.name);
      } catch (error) {
        throw new InputError(error instanceof Error ? error.message : `${found.name} could not be read`);
      }
    };
    const scores = scoreRun({
      questions,
      records,
      sections,
      judgments: await readJudgments(runDir, 'completeness'),
      personVerdicts: await checks('completeness', personVerdicts),
      answersJudgments: await readJudgments(runDir, 'answers-question'),
      answersPersonChecks: await checks('answers-question', personAnswers),
      overlap,
      variant: sample.variant,
      reworded: sample.reworded,
    });
    await writeFile(join(runDir, 'scores.json'), `${JSON.stringify(scores, null, 2)}\n`);
    for (const line of formatScores(scores)) io.log(line);
    return 0;
  }

  if (command === 'compare') {
    const runA = flag(values, 'run-a');
    const runB = flag(values, 'run-b');
    const [nameA, nameB] = [basename(runA), basename(runB)];
    const [fileA, fileB] = [await readRunFile(runA), await readRunFile(runB)];
    const [variantA, variantB] = [variantOf(fileA), variantOf(fileB)];
    if (variantA === variantB && fileA.sample_sha256 !== fileB.sample_sha256) throw new InputError(`the runs ${nameA} and ${nameB} were made on different samples`);
    const [scoresA, scoresB] = [await scoresOf(runA), await scoresOf(runB)];
    const idsA = Object.keys(scoresA.perQuestion);
    const idsB = new Set(Object.keys(scoresB.perQuestion));
    if (idsA.length !== idsB.size || idsA.some((qid) => !idsB.has(qid))) throw new InputError(`the runs ${nameA} and ${nameB} were not made on the same set of questions`);
    let only: Set<string> | null = null;
    if (switches.has('only-reworded')) {
      const reworded = variantA === 'reworded' ? scoresA : variantB === 'reworded' ? scoresB : null;
      if (reworded === null) throw new InputError('--only-reworded needs a run made on the reworded sample');
      only = new Set(reworded.rewordedQids);
    }
    const rows = compareScores(scoresA, scoresB, only);
    const byThird = compareByThird(scoresA, scoresB, only);
    const lines = [`compared: ${nameA} (sample variant ${variantA}) against ${nameB} (sample variant ${variantB})`];
    if (only !== null) lines.push(`restricted to the ${only.size} questions actually reworded`);
    lines.push(...formatComparison(nameA, nameB, rows));
    if (byThird === null) lines.push(`wording overlap: ${nameA}'s scores have none (scored before it existed: run evaluation/score.sh on it again)`);
    else {
      const cuts = scoresA.overlap?.cuts ?? null;
      lines.push(`by thirds of wording overlap, as ${nameA}'s scores cut them (${cutsText(cuts)}):`);
      for (const third of byThird) {
        lines.push(`${third.name} (${third.questions} questions):`);
        lines.push(...formatComparison(nameA, nameB, third.rows));
      }
    }
    const out = { runA: nameA, runB: nameB, variants: { runA: variantA, runB: variantB }, onlyReworded: only === null ? null : only.size, rows, byThird, thirdsFrom: nameA };
    await writeFile(join(runB, `compare-${nameA}${only === null ? '' : '-only-reworded'}.json`), `${JSON.stringify(out, null, 2)}\n`);
    for (const line of lines) io.log(line);
    return 0;
  }

  if (command === 'judge-prepare') {
    const runDir = flag(values, 'run-dir');
    const rubric = rubricFlag(values);
    const { questions } = await readRunSample(flag(values, 'sample'), runDir);
    const count = await prepareJudging(runDir, rubric, questions, await readRecords(runDir), switches.has('retry-failed'));
    io.log(`rubric ${rubric}; to judge: ${count}`);
    return 0;
  }

  if (command === 'judge-collect') {
    const rubric = rubricFlag(values);
    let outcome: { judged: number; failures: number };
    try {
      outcome = await collectJudging(flag(values, 'run-dir'), rubric);
    } catch (error) {
      throw new InputError(error instanceof InputError ? error.message : 'the judge calls could not be read back');
    }
    io.log(`rubric ${rubric}; judged: ${outcome.judged}; judge failures: ${outcome.failures}`);
    return outcome.failures === 0 ? 0 : 1;
  }

  if (command === 'judge-check') {
    const rubric = rubricFlag(values);
    const count = countFlag(values);
    const runDir = flag(values, 'run-dir');
    const { questions } = await readRunSample(flag(values, 'sample'), runDir);
    const judgments = await readJudgments(runDir, rubric);
    if (judgments === null) throw new InputError(`the run ${basename(runDir)} has no ${rubric} judgments: run evaluation/judge.sh --rubric ${rubric} first`);
    await writeFile(join(runDir, checkFileName(rubric)), checkFile(rubric, toJudge(questions, await readRecords(runDir)), judgments, count));
    io.log(`wrote ${checkFileName(rubric)} beside the run: fill in its person columns, then run evaluation/score.sh`);
    return 0;
  }

  // ---------- the reworded variant ----------

  const samplePath = flag(values, 'sample');
  const outPath = variantPath(samplePath, 'reworded');

  if (command === 'reword-check') {
    const count = countFlag(values);
    const original = await readSample(samplePath);
    const reworded = await readVariant(samplePath, 'reworded');
    await writeFile(join(dirname(outPath), REWORD_CHECK_FILE), rewordCheckFile(original.questions, reworded.questions, reworded.reworded ?? new Set(), count));
    io.log(`wrote evaluation/data/${REWORD_CHECK_FILE}: ${Math.min(count, reworded.reworded?.size ?? 0)} original and reworded pairs for a person to read`);
    return 0;
  }

  if (await exists(outPath)) throw new InputError(`evaluation/data/${REWORDED_FILE} exists already: runs may be pinned to it; move it away first to reword again`);
  const original = await readSample(samplePath);
  const extras = await readExtras(flag(values, 'qa'), 'knowledge/data/benchmark/qa.jsonl', original.questions);
  const pending = flag(values, 'pending');

  if (command === 'reword-prepare') {
    io.log(`to rewrite: ${await prepareRewording(pending, original.questions, extras)}`);
    return 0;
  }

  if (command === 'reword-check-prepare') {
    const { toCheck, settled } = await prepareChecks(pending, original.questions, extras);
    io.log(`to check: ${toCheck}; not sent to the checker (the rewrite failed, is the original, or lost the drug's name): ${settled}`);
    return 0;
  }

  // reword-collect
  let describe: unknown;
  try {
    describe = rewriterDescribeSchema.parse(JSON.parse(await readFile(join(pending, 'describe.json'), 'utf8')));
  } catch {
    throw new InputError('the rewriter adapter did not describe itself (rewriter, model, effort)');
  }
  const outcome = await collectRewording(pending, original.questions, extras);
  const text = outcome.lines.map((line) => `${JSON.stringify(line)}\n`).join('');
  await writeFile(outPath, text);
  await writeFile(
    join(dirname(outPath), 'sample-reworded.json'),
    `${JSON.stringify(
      {
        rewriter: describe,
        instructions_sha256: rewordInstructionsSha256(),
        from_sample_sha256: original.sha256,
        sha256: createHash('sha256').update(text).digest('hex'),
        counts: outcome.counts,
        overlap: outcome.overlap,
      },
      null,
      2,
    )}\n`,
  );
  await rm(pending, { recursive: true, force: true });
  const c = outcome.counts;
  io.log(`wrote evaluation/data/${REWORDED_FILE}: ${c.questions} questions; reworded ${c.reworded}; refusal questions copied ${c.refusalCopied}`);
  for (const [because, count] of Object.entries(c.kept).sort(([a], [b]) => (a < b ? -1 : 1))) io.log(`  kept the original, ${count}: ${because}`);
  io.log(`wording overlap before: ${overlapText(outcome.overlap.before)} (${cutsText(outcome.overlap.before.cuts)})`);
  io.log(`wording overlap after:  ${overlapText(outcome.overlap.after)}`);
  io.log(`model calls that failed: ${outcome.callFailures}`);
  return outcome.callFailures === 0 ? 0 : 1;
}
