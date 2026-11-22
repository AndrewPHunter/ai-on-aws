// The judge of answers, behind one boundary: a command that takes the rubric's verdict schema file as its argument,
// reads one JSON request on standard input and writes one JSON verdict on standard output. This module prepares the
// requests, reads back what the command wrote, and draws the check file a person fills in, each for one rubric
// (rubric.ts). The calls themselves are made by evaluation/judge/call-all.sh on the operator's machine, because the
// only adapter (evaluation/judge/codex.sh) needs the operator's own login.
//
// The judge is given the rubric's instructions, the question the agent was sent, the benchmark's answer and the
// agent's reply with its citation markers removed, and nothing else: no passage, no citation, no identifier.
//
// Judgments are stored per rubric: judgments-<rubric>.jsonl, and judge-<rubric>.json (the judge, its model and effort,
// the rubric and the SHA-256 of its instructions). A run folder from before rubrics existed holds judgments.jsonl and
// judge-check.csv: they are read as the completeness rubric's for as long as the per-rubric file does not exist, and
// they are never rewritten or deleted. Judging completeness again carries the old judgments over into the new file.

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { Question } from './benchmark.ts';
import { InputError } from './benchmark.ts';
import type { CallRecord } from './run.ts';
import { latestByQid } from './run.ts';
import { ANSWERS, RUBRICS, VERDICTS, answersUncontradicted, instructionsSha256 } from './rubric.ts';
import type { JudgmentOf, RubricName, Verdict } from './rubric.ts';
import { isRefusal, judgeable } from './score.ts';
import { seededShuffle } from './sample.ts';

export const JUDGE_CONCURRENCY = 4;

export type JudgeRequest = { instructions: string; question: string; reference: string; reply: string };

// The citation markers the expert writes after each statement: " [1]", " [2]".
export const withoutCitationMarkers = (reply: string): string => reply.replace(/[ \t]*\[\d+\]/g, '').trim();

export function judgeRequest(rubric: RubricName, question: Question, reply: string): JudgeRequest {
  return { instructions: RUBRICS[rubric].instructions, question: question.question, reference: question.answer, reply: withoutCitationMarkers(reply) };
}

// The questions the judge grades: answerable, with a reference answer that holds a letter (one that is only section
// numbers gives no fact to grade against), and a response whose label answer is "answered".
export function toJudge(questions: readonly Question[], records: readonly CallRecord[]): { question: Question; reply: string }[] {
  const latest = latestByQid(records);
  return questions.flatMap((question) => {
    if (isRefusal(question) || !judgeable(question)) return [];
    const record = latest.get(question.qid);
    if (record === undefined || !record.ok) return [];
    const parsed = invocationResponseSchema.safeParse(record.response);
    if (!parsed.success || parsed.data.label_answer !== 'answered') return [];
    return [{ question, reply: parsed.data.reply }];
  });
}

// The files of one rubric in a run folder.
export const judgmentsFile = (rubric: RubricName): string => `judgments-${rubric}.jsonl`;
export const judgeFile = (rubric: RubricName): string => `judge-${rubric}.json`;
export const pendingFolder = (rubric: RubricName): string => `judge-pending-${rubric}`;
export const checkFileName = (rubric: RubricName): string => `judge-check-${rubric}.csv`;
// The files of a run folder judged before rubrics existed: the completeness rubric's.
export const LEGACY_JUDGMENTS = 'judgments.jsonl';
export const LEGACY_CHECK_FILE = 'judge-check.csv';

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new InputError(`${path.split('/').slice(-2).join('/')} could not be read`);
  }
}

// The file a rubric's judgments are read from: its own, or for completeness the old judgments.jsonl when its own does
// not exist yet.
async function judgmentsText(runDir: string, rubric: RubricName): Promise<string | null> {
  const own = await readOptional(join(runDir, judgmentsFile(rubric)));
  if (own !== null || rubric !== 'completeness') return own;
  return readOptional(join(runDir, LEGACY_JUDGMENTS));
}

export async function readJudgments<R extends RubricName>(runDir: string, rubric: R): Promise<JudgmentOf[R][] | null> {
  const text = await judgmentsText(runDir, rubric);
  if (text === null) return null;
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line, at) => {
      try {
        return JSON.parse(line) as JudgmentOf[R];
      } catch {
        throw new InputError(`the ${rubric} judgments, line ${at + 1}, is not JSON`);
      }
    });
}

// A request file's name: from the qid's hash, so no qid's characters reach a path.
export const requestName = (qid: string): string => createHash('sha256').update(qid).digest('hex').slice(0, 24);

// Writes one request file per question still to judge under this rubric into judge-pending-<rubric>/, and index.json
// naming each file's qid. A question already judged is skipped; one whose judging failed is skipped unless retryFailed.
export async function prepareJudging(runDir: string, rubric: RubricName, questions: readonly Question[], records: readonly CallRecord[], retryFailed: boolean): Promise<number> {
  const done = new Map(((await readJudgments(runDir, rubric)) ?? []).map((judgment) => [judgment.qid, judgment]));
  const pending = join(runDir, pendingFolder(rubric));
  await rm(pending, { recursive: true, force: true });
  await mkdir(pending, { recursive: true });
  const index: Record<string, string> = {};
  for (const { question, reply } of toJudge(questions, records)) {
    const previous = done.get(question.qid);
    if (previous !== undefined && (previous.ok || !retryFailed)) continue;
    const name = requestName(question.qid);
    index[name] = question.qid;
    await writeFile(join(pending, `${name}.json`), JSON.stringify(judgeRequest(rubric, question, reply)));
  }
  await writeFile(join(pending, 'index.json'), JSON.stringify(index));
  return Object.keys(index).length;
}

export const describeSchema = z.object({ judge: z.string().min(1), model: z.string().min(1), effort: z.string().min(1) });

// What one adapter call left behind (<name>.status and <name>.out, from call-all.sh), checked against a schema: the
// parsed answer, or why it is a failure.
export async function readCall<T>(pending: string, present: ReadonlySet<string>, name: string, schema: z.ZodType<T>, what: string): Promise<{ ok: true; value: T } | { ok: false; failure: string }> {
  const status = present.has(`${name}.status`) ? (await readFile(join(pending, `${name}.status`), 'utf8')).trim() : 'missing';
  if (status === 'missing') return { ok: false, failure: `the ${what} was not called` };
  if (status !== '0') return { ok: false, failure: `the ${what} command exited ${status}` };
  const out = present.has(`${name}.out`) ? await readFile(join(pending, `${name}.out`), 'utf8') : '';
  let value: unknown;
  try {
    value = JSON.parse(out);
  } catch {
    value = undefined;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, failure: `the ${what} answered outside the schema` };
}

// Reads what the adapter wrote for each pending request of this rubric, records a judgment for each in
// judgments-<rubric>.jsonl, and writes judge-<rubric>.json. A failing command, or a verdict outside the rubric's
// schema, is a failure.
export async function collectJudging(runDir: string, rubric: RubricName): Promise<{ judged: number; failures: number }> {
  const pending = join(runDir, pendingFolder(rubric));
  const index = JSON.parse(await readFile(join(pending, 'index.json'), 'utf8')) as Record<string, string>;
  let describe: z.infer<typeof describeSchema>;
  try {
    describe = describeSchema.parse(JSON.parse(await readFile(join(pending, 'describe.json'), 'utf8')));
  } catch {
    throw new InputError('the adapter did not describe itself (judge, model, effort)');
  }
  const present = new Set(await readdir(pending));
  const lines: string[] = [];
  let judged = 0;
  let failures = 0;
  for (const [name, qid] of Object.entries(index)) {
    const call = await readCall(pending, present, name, RUBRICS[rubric].verdictSchema, 'judge');
    const judgment = call.ok ? { qid, ok: true, ...(call.value as object) } : { qid, ok: false, failure: call.failure };
    if (call.ok) judged++;
    else failures++;
    lines.push(`${JSON.stringify(judgment)}\n`);
  }
  const asked = new Set(Object.values(index));
  const kept = ((await readJudgments(runDir, rubric)) ?? []).filter((judgment) => !asked.has(judgment.qid));
  await writeFile(join(runDir, judgmentsFile(rubric)), [...kept.map((judgment) => `${JSON.stringify(judgment)}\n`), ...lines].join(''));
  await writeFile(join(runDir, judgeFile(rubric)), `${JSON.stringify({ ...describe, rubric, instructions_sha256: instructionsSha256(rubric) }, null, 2)}\n`);
  await rm(pending, { recursive: true, force: true });
  return { judged, failures };
}

// ---------- the check of the judge by a person ----------

const CHECK_SEED = 20261123;

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// RFC 4180 fields: quoted fields may hold commas, newlines and doubled quotes.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// The columns a person fills in, per rubric.
export const PERSON_COLUMNS: Record<RubricName, string[]> = {
  completeness: ['person_verdict'],
  'answers-question': ['person_answers', 'person_contradicts'],
};

// The check file: `count` items the judge graded under this rubric, drawn by seed, each with the question, the
// reference, the reply and empty columns for a person's grading. It holds text and lives only under evaluation/data
// (ignored).
export function checkFile(rubric: RubricName, items: readonly { question: Question; reply: string }[], judgments: readonly { qid: string; ok: boolean }[], count: number): string {
  const judged = new Set(judgments.filter((judgment) => judgment.ok).map((judgment) => judgment.qid));
  const candidates = items.filter((item) => judged.has(item.question.qid));
  const chosen = new Set(seededShuffle(candidates.map((item) => item.question.qid), CHECK_SEED, 'check').slice(0, count));
  const columns = PERSON_COLUMNS[rubric];
  const rows = [['qid', 'question', 'reference', 'reply', ...columns].map(csvField).join(',')];
  for (const item of candidates) {
    if (!chosen.has(item.question.qid)) continue;
    rows.push([item.question.qid, item.question.question, item.question.answer, withoutCitationMarkers(item.reply), ...columns.map(() => '')].map(csvField).join(','));
  }
  return `${rows.join('\n')}\n`;
}

// The filled check file of a rubric: its own, or for completeness the old judge-check.csv when its own does not exist.
export async function readCheckFile(runDir: string, rubric: RubricName): Promise<{ text: string; name: string } | null> {
  const own = await readOptional(join(runDir, checkFileName(rubric)));
  if (own !== null) return { text: own, name: checkFileName(rubric) };
  if (rubric !== 'completeness') return null;
  const legacy = await readOptional(join(runDir, LEGACY_CHECK_FILE));
  return legacy === null ? null : { text: legacy, name: LEGACY_CHECK_FILE };
}

function columnsOf(text: string, name: string, wanted: readonly string[]): { body: string[][]; qidAt: number; at: number[] } {
  const [header, ...body] = parseCsv(text);
  const qidAt = header?.indexOf('qid') ?? -1;
  const at = wanted.map((column) => header?.indexOf(column) ?? -1);
  if (qidAt < 0 || at.some((position) => position < 0)) throw new Error(`${name} has no qid or ${wanted.join(' or ')} column`);
  return { body, qidAt, at };
}

// A person's completeness verdicts from a filled check file, by qid; null when none is filled. A cell that is not one
// of the three verdicts is an error, named by its row.
export function personVerdicts(text: string, name: string):Map<string, Verdict> | null {
  const { body, qidAt, at } = columnsOf(text, name, ['person_verdict']);
  const verdicts = new Map<string, Verdict>();
  body.forEach((row, line) => {
    const value = (row[at[0] ?? -1] ?? '').trim();
    if (value === '') return;
    const verdict = VERDICTS.find((candidate) => candidate === value);
    if (verdict === undefined) throw new Error(`${name} row ${line + 2}: person_verdict must be correct, partly_correct or incorrect`);
    verdicts.set(row[qidAt] ?? '', verdict);
  });
  return verdicts.size === 0 ? null : verdicts;
}

// A person's answers-question grading from a filled check file, as "answers the question, uncontradicted" by qid; null
// when none is filled. A row counts when both of its columns are filled; one filled alone, or a value that is not
// allowed, is an error, named by its row.
export function personAnswers(text: string, name: string): Map<string, boolean> | null {
  const { body, qidAt, at } = columnsOf(text, name, PERSON_COLUMNS['answers-question']);
  const graded = new Map<string, boolean>();
  body.forEach((row, line) => {
    const answers = (row[at[0] ?? -1] ?? '').trim();
    const contradicts = (row[at[1] ?? -1] ?? '').trim();
    if (answers === '' && contradicts === '') return;
    const known = ANSWERS.find((candidate) => candidate === answers);
    if (known === undefined || (contradicts !== 'true' && contradicts !== 'false')) {
      throw new Error(`${name} row ${line + 2}: person_answers must be yes, partly or no, and person_contradicts true or false`);
    }
    graded.set(row[qidAt] ?? '', answersUncontradicted({ answers: known, contradicts: contradicts === 'true' }));
  });
  return graded.size === 0 ? null : graded;
}
