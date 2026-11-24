// The lab explorer's reader of the evaluation harness's runs, from the harness's data folder (evaluation/data,
// mounted read-only; evaluation/README.md, "Where the data lives"). It imports no code of the harness: it reads the
// files the harness writes, with schemas of its own that name only the fields it uses, and drops every other field.
//
// What it reads, and which harness code writes it:
//   runs/<name>/scores.json      written by `score` (evaluation/src/cli.ts, from scoreRun in evaluation/src/score.ts,
//                                type Scores): every measure, as counts and shares. Its stop sentences (stopReasons) and
//                                its per-question results are not read.
//   runs/<name>/run.json         written by runQuestions (evaluation/src/run.ts, type RunFile): the agent, the models and
//                                strategies its responses named, start and end. Optional.
//   attacks/<name>/results.jsonl written by runAttacks (evaluation/src/attacks/runner.ts): one line per case. Only id,
//                                class, target, decided_by, verdict and the failed expectations' kinds are read; never
//                                what was observed, the traces, the findings or the reasons.
//
// Every value read is an identifier, a count or a figure: the identifiers are checked against a pattern that no
// sentence matches. A file that does not parse, or lacks a field read, is named and skipped. A figure is shown as the
// file holds it, under the name the harness's own table (evaluation/src/table.ts) prints it with; none is worked out
// here.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type {
  AttackCaseResult,
  AttackVerdict,
  BenchmarkRunFacts,
  EvaluationGroup,
  EvaluationKind,
  EvaluationList,
  EvaluationRow,
  EvaluationRunResponse,
  EvaluationShare,
  EvaluationSkipped,
} from '../shared/api.ts';

// The two kinds of run, the folder each is in and the file that holds its figures.
const FOLDERS: readonly { kind: EvaluationKind; folder: string; file: string; command: string }[] = [
  { kind: 'benchmark', folder: 'runs', file: 'scores.json', command: 'evaluation/score.sh' },
  { kind: 'attack', folder: 'attacks', file: 'results.jsonl', command: 'evaluation/attacks.sh' },
];

// An identifier, a fixed name of the harness's, or a model's served name: no spaces, no sentence.
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/);
// A fixed name the harness prints, such as a third's ("lowest third"): lower-case words.
const fixedName = z.string().regex(/^[a-z][a-z ]{0,39}$/);
const count = z.number().int().min(0);
const fraction = z.number().min(0).max(1);

const shareSchema = z.object({
  numerator: count,
  denominator: count,
  share: fraction.nullable(),
  low: fraction.nullable(),
  high: fraction.nullable(),
  tooFew: z.boolean(),
});
const effortSchema = z.object({ count, median: z.number().nullable(), p95: z.number().nullable() });
const correctnessShares = z.object({ correct: shareSchema, partlyCorrect: shareSchema, incorrect: shareSchema });
const answersShares = z.object({
  answersUncontradicted: shareSchema,
  contradicts: shareSchema,
  coverage: z.object({ all: shareSchema, some: shareSchema, none: shareSchema }),
});
const agreementSchema = z.object({ judgeAndPersonAgree: shareSchema }).nullable();

// scores.json, as evaluation/src/score.ts's Scores. A file written before variants, wording overlap or the
// answers-question rubric existed has none of them, as the harness itself reads it.
const scoresSchema = z.object({
  questions: count,
  outcomes: z.object({ completed: count, stopped: count, failed: count, callFailures: count }),
  labelAnswers: z.record(identifier, count),
  declining: z.object({ refusalDeclined: shareSchema, answerableAnswered: shareSchema, declinedThatWereRefusal: shareSchema }),
  rightLabel: shareSchema,
  citations: z.object({ precision: shareSchema, recall: shareSchema, citedPassages: count, citedWithoutSection: count }),
  retrieval: z.object({ anySearch: shareSchema, firstSearch: shareSchema }),
  numbers: shareSchema,
  effort: z.object({ searches: effortSchema, corrections: effortSchema, seconds: effortSchema, inputTokens: effortSchema, outputTokens: effortSchema }),
  correctness: z.object({ judged: count, failures: count, leftOut: count, byType: z.record(identifier, correctnessShares), all: correctnessShares }).nullable(),
  agreement: agreementSchema,
  answersQuestion: z
    .object({ judged: count, failures: count, leftOut: count, byType: z.record(identifier, answersShares), all: answersShares })
    .nullable()
    .optional(),
  answersAgreement: agreementSchema.optional(),
  variant: identifier.optional(),
  rewordedQids: z.array(z.string()).optional(),
  overlap: z
    .object({
      questions: count,
      withoutContentWords: count,
      median: fraction.nullable(),
      cuts: z.object({ low: fraction, high: fraction }).nullable(),
      thirds: z.array(
        z.object({
          third: z.number().int().min(1).max(3),
          name: fixedName,
          questions: count,
          measures: z.object({ retrieved_first: shareSchema, retrieved_any: shareSchema, answers_uncontradicted: shareSchema }),
        }),
      ),
    })
    .nullable()
    .optional(),
});
type Scores = z.infer<typeof scoresSchema>;

// run.json, as evaluation/src/run.ts's RunFile.
const runFileSchema = z.object({
  agent_id: identifier.nullable(),
  models: z.array(identifier),
  strategies: z.array(identifier),
  started_at: z.iso.datetime({ offset: true }),
  ended_at: z.iso.datetime({ offset: true }).nullable(),
});

const decider = z.enum(['code', 'model']);
// One line of results.jsonl: the fields read, and no other.
const resultLineSchema = z.object({
  id: identifier,
  class: identifier,
  target: identifier,
  decided_by: decider,
  verdict: z.enum(['held', 'failed', 'inconclusive', 'not_run']),
  failed: z.array(z.object({ kind: identifier, scope: identifier.optional(), decided_by: decider })),
});

type Figures =
  | { kind: 'benchmark'; run: BenchmarkRunFacts | null; variant: string; scores: Scores }
  | { kind: 'attack'; cases: AttackCaseResult[] };

// A run found on disk, with its figures already read: the server answers only from these, so an id from the browser
// is matched against them and never used to build a path.
export type FoundRun = { id: string; kind: EvaluationKind; name: string; written_at: string; figures: Figures };
export type Found = { data: 'not_configured' | 'empty' | 'found'; runs: FoundRun[]; skipped: EvaluationSkipped[] };

// The names in a folder, or none when it does not exist.
async function namesIn(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return [];
    throw error;
  }
}

const where = (issues: readonly { path: readonly PropertyKey[] }[]): string => {
  const path = issues[0]?.path.map(String).join('.') ?? '';
  return path === '' ? 'at its top' : `at ${path}`;
};

type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

function parseJson<T>(text: string, schema: z.ZodType<T>): Read<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'It is not JSON.' };
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: `It lacks a field this page reads, or holds one in another form, ${where(parsed.error.issues)}.` };
}

function parseResults(text: string): Read<AttackCaseResult[]> {
  const cases: AttackCaseResult[] = [];
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  for (const [at, line] of lines.entries()) {
    const read = parseJson(line, resultLineSchema);
    if (!read.ok) return { ok: false, reason: `Line ${at + 1}: ${read.reason}` };
    const { id, class: caseClass, target, decided_by, verdict, failed } = read.value;
    cases.push({ id, class: caseClass, target, decided_by, verdict, failed: failed.map((f) => ({ kind: f.kind, scope: f.scope ?? null, decided_by: f.decided_by })) });
  }
  return lines.length === 0 ? { ok: false, reason: 'It holds no case.' } : { ok: true, value: cases };
}

async function readRunFile(folder: string): Promise<BenchmarkRunFacts | null> {
  let text: string;
  try {
    text = await readFile(join(folder, 'run.json'), 'utf8');
  } catch {
    return null;
  }
  const read = parseJson(text, runFileSchema);
  return read.ok ? read.value : null;
}

// Every run in the data folder whose figures could be read, newest first by when its file was last written (then by
// id), and every one that could not, named with the reason.
export async function findRuns(dataDir: string | null): Promise<Found> {
  if (dataDir === null) return { data: 'not_configured', runs: [], skipped: [] };
  const runs: FoundRun[] = [];
  const skipped: EvaluationSkipped[] = [];
  for (const { kind, folder, file, command } of FOLDERS) {
    for (const name of await namesIn(join(dataDir, folder))) {
      const runDir = join(dataDir, folder, name);
      const shown = `${folder}/${name}/${file}`;
      let text: string;
      let writtenAt: string;
      try {
        text = await readFile(join(runDir, file), 'utf8');
        writtenAt = (await stat(join(runDir, file))).mtime.toISOString();
      } catch {
        skipped.push({ file: shown, reason: `There is no such file: run ${command} to make it.` });
        continue;
      }
      const id = `${folder}/${name}`;
      if (kind === 'benchmark') {
        const read = parseJson(text, scoresSchema);
        if (!read.ok) {
          skipped.push({ file: shown, reason: read.reason });
          continue;
        }
        runs.push({ id, kind, name, written_at: writtenAt, figures: { kind, run: await readRunFile(runDir), variant: read.value.variant ?? 'original', scores: read.value } });
      } else {
        const read = parseResults(text);
        if (!read.ok) {
          skipped.push({ file: shown, reason: read.reason });
          continue;
        }
        runs.push({ id, kind, name, written_at: writtenAt, figures: { kind, cases: read.value } });
      }
    }
  }
  runs.sort((a, b) => (a.written_at === b.written_at ? (a.id < b.id ? -1 : 1) : a.written_at < b.written_at ? 1 : -1));
  return { data: runs.length === 0 && skipped.length === 0 ? 'empty' : 'found', runs, skipped };
}

export function runList(found: Found): EvaluationList {
  return { data: found.data, runs: found.runs.map(({ id, kind, name, written_at }) => ({ id, kind, name, written_at })), skipped: found.skipped };
}

// ---------- one run's figures ----------

const share = (name: string, value: z.infer<typeof shareSchema>): EvaluationRow => {
  const shown: EvaluationShare = { numerator: value.numerator, denominator: value.denominator, share: value.share, low: value.low, high: value.high, too_few: value.tooFew };
  return { name, kind: 'share', share: shown };
};
const counted = (name: string, value: number): EvaluationRow => ({ name, kind: 'count', count: value });
const effort = (name: string, value: z.infer<typeof effortSchema>): EvaluationRow => ({ name, kind: 'effort', count: value.count, median: value.median, p95: value.p95 });

// The measures of scores.json, grouped and named as evaluation/src/table.ts prints them.
function benchmarkGroups(scores: Scores): EvaluationGroup[] {
  const o = scores.outcomes;
  const groups: EvaluationGroup[] = [
    {
      name: 'outcomes',
      rows: [counted('questions', scores.questions), counted('completed', o.completed), counted('stopped', o.stopped), counted('failed', o.failed), counted('call failures', o.callFailures)],
    },
    { name: 'label answers', rows: Object.entries(scores.labelAnswers).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, value]) => counted(name, value)) },
    {
      name: 'declining',
      rows: [
        share('refusal questions declined', scores.declining.refusalDeclined),
        share('answerable questions answered', scores.declining.answerableAnswered),
        share('declined questions that were refusal questions', scores.declining.declinedThatWereRefusal),
      ],
    },
    {
      name: 'answers',
      rows: [
        share('answered, every citation from the right label', scores.rightLabel),
        share('cited sections that match a reference', scores.citations.precision),
        share('references cited', scores.citations.recall),
        counted('cited passages', scores.citations.citedPassages),
        counted('cited passages with neither a section number nor a title to match on', scores.citations.citedWithoutSection),
        share('numeric answered, every reference number given', scores.numbers),
      ],
    },
    {
      name: 'retrieval',
      rows: [share('a referenced section shown, in any search', scores.retrieval.anySearch), share('a referenced section shown, in the first search', scores.retrieval.firstSearch)],
    },
    {
      name: 'effort, per question with a response',
      rows: [
        effort('searches', scores.effort.searches),
        effort('corrections', scores.effort.corrections),
        effort('seconds', scores.effort.seconds),
        effort('tokens in', scores.effort.inputTokens),
        effort('tokens out', scores.effort.outputTokens),
      ],
    },
  ];
  const answers = scores.answersQuestion ?? null;
  if (scores.correctness === null && answers === null) groups.push({ name: 'correctness', rows: [{ name: 'correctness', kind: 'not_judged' }] });
  if (answers !== null) {
    const rows: EvaluationRow[] = [counted('judged', answers.judged), counted('judge failures', answers.failures), counted('left out of judging', answers.leftOut)];
    for (const [type, shares] of [['all', answers.all], ...Object.entries(answers.byType)] as const) {
      rows.push(
        share(`${type}: answers the question, uncontradicted`, shares.answersUncontradicted),
        share(`${type}: contradicts the reference`, shares.contradicts),
        share(`${type}: covers all of the reference`, shares.coverage.all),
        share(`${type}: covers some of the reference`, shares.coverage.some),
        share(`${type}: covers none of the reference`, shares.coverage.none),
      );
    }
    const agreement = scores.answersAgreement ?? null;
    if (agreement !== null) rows.push(share('the judge agrees with the person (answers, uncontradicted)', agreement.judgeAndPersonAgree));
    groups.push({ name: 'rubric answers-question', rows });
  }
  if (scores.correctness !== null) {
    const c = scores.correctness;
    const rows: EvaluationRow[] = [counted('judged', c.judged), counted('judge failures', c.failures), counted('left out of judging', c.leftOut)];
    for (const [type, shares] of [['all', c.all], ...Object.entries(c.byType)] as const) {
      rows.push(share(`${type}: correct`, shares.correct), share(`${type}: partly correct`, shares.partlyCorrect), share(`${type}: incorrect`, shares.incorrect));
    }
    if (scores.agreement !== null) rows.push(share('the judge agrees with the person', scores.agreement.judgeAndPersonAgree));
    groups.push({ name: 'correctness, rubric completeness', rows });
  }
  const variantRows: EvaluationRow[] = scores.variant === 'reworded' ? [counted('questions reworded', (scores.rewordedQids ?? []).length)] : [];
  const overlap = scores.overlap ?? null;
  if (overlap !== null) {
    const rows: EvaluationRow[] = [
      ...variantRows,
      counted('questions with a wording overlap', overlap.questions),
      { name: 'median wording overlap', kind: 'fraction', value: overlap.median },
      counted('questions with no content words, in no third', overlap.withoutContentWords),
    ];
    if (overlap.cuts !== null) {
      rows.push({ name: 'thirds cut at (low)', kind: 'fraction', value: overlap.cuts.low }, { name: 'thirds cut at (high)', kind: 'fraction', value: overlap.cuts.high });
    }
    for (const third of overlap.thirds) {
      rows.push(
        counted(`${third.name}: questions`, third.questions),
        share(`${third.name}: a referenced section shown, first search`, third.measures.retrieved_first),
        share(`${third.name}: a referenced section shown, any search`, third.measures.retrieved_any),
        answers === null
          ? { name: `${third.name}: answers the question, uncontradicted`, kind: 'not_judged' }
          : share(`${third.name}: answers the question, uncontradicted`, third.measures.answers_uncontradicted),
      );
    }
    groups.push({ name: 'wording overlap', rows });
  } else if (variantRows.length > 0) {
    groups.push({ name: 'sample variant', rows: variantRows });
  }
  return groups;
}

export function runFigures(run: FoundRun): EvaluationRunResponse {
  const { id, name, written_at, figures } = run;
  if (figures.kind === 'benchmark') {
    return { kind: 'benchmark', id, name, written_at, run: figures.run, variant: figures.variant, groups: benchmarkGroups(figures.scores) };
  }
  const totals: Record<AttackVerdict, number> = { held: 0, failed: 0, inconclusive: 0, not_run: 0 };
  for (const item of figures.cases) totals[item.verdict] += 1;
  return { kind: 'attack', id, name, written_at, cases: figures.cases, totals };
}
