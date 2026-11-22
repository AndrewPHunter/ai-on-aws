// The judge of answer correctness, behind one boundary: a command that reads one JSON request on standard input and
// writes one JSON verdict on standard output. This module prepares the requests, reads back what the command wrote,
// and draws the check file a person fills in. The calls themselves are made by evaluation/judge/call-all.sh on the
// operator's machine, because the only adapter (evaluation/judge/codex.sh) needs the operator's own login.
//
// The judge is given the question, the benchmark's answer and the agent's reply with its citation markers removed,
// and nothing else: no passage, no citation, no identifier.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { Question } from './benchmark.ts';
import type { CallRecord } from './run.ts';
import { latestByQid } from './run.ts';
import { VERDICTS, isRefusal, judgeable } from './score.ts';
import type { Judgment, Verdict } from './score.ts';
import { seededShuffle } from './sample.ts';

export const JUDGE_CONCURRENCY = 4;

// The instructions every request carries. Its hash is recorded with the judgments, so a change to it is visible.
export const JUDGE_INSTRUCTIONS =
  'You grade an answer to a question about a medicine against a reference answer taken from the medicine\'s approved label. ' +
  'Compare only what the reply says with what the reference says. Grade "correct" when the reply gives every fact the reference gives and ' +
  'contradicts none; "partly_correct" when it gives some of them and contradicts none; "incorrect" when it gives none of them, or contradicts ' +
  'the reference. Extra true detail is not an error. Give one sentence of reason. Answer only with the JSON object the schema asks for.';

export const promptSha256 = (): string => createHash('sha256').update(JUDGE_INSTRUCTIONS).digest('hex');

export type JudgeRequest = { instructions: string; question: string; reference: string; reply: string };

// The citation markers the expert writes after each statement: " [1]", " [2]".
export const withoutCitationMarkers = (reply: string): string => reply.replace(/[ \t]*\[\d+\]/g, '').trim();

export function judgeRequest(question: Question, reply: string): JudgeRequest {
  return { instructions: JUDGE_INSTRUCTIONS, question: question.question, reference: question.answer, reply: withoutCitationMarkers(reply) };
}

export const verdictSchema = z.strictObject({ verdict: z.enum(VERDICTS), reason: z.string().min(1).max(1000) });

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

export const JUDGMENTS = 'judgments.jsonl';
export const JUDGE_FILE = 'judge.json';
export const PENDING = 'judge-pending';

export async function readJudgments(runDir: string): Promise<Judgment[] | null> {
  let text: string;
  try {
    text = await readFile(join(runDir, JUDGMENTS), 'utf8');
  } catch {
    return null;
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Judgment);
}

// A request file's name: from the qid's hash, so no qid's characters reach a path.
const fileName = (qid: string): string => createHash('sha256').update(qid).digest('hex').slice(0, 24);

// Writes one request file per question still to judge into judge-pending/, and index.json naming each file's qid.
// A question already judged is skipped; one whose judging failed is skipped unless retryFailed.
export async function prepareJudging(runDir: string, questions: readonly Question[], records: readonly CallRecord[], retryFailed: boolean): Promise<number> {
  const done = new Map(((await readJudgments(runDir)) ?? []).map((judgment) => [judgment.qid, judgment]));
  const pending = join(runDir, PENDING);
  await rm(pending, { recursive: true, force: true });
  await mkdir(pending, { recursive: true });
  const index: Record<string, string> = {};
  for (const { question, reply } of toJudge(questions, records)) {
    const previous = done.get(question.qid);
    if (previous !== undefined && (previous.ok || !retryFailed)) continue;
    const name = fileName(question.qid);
    index[name] = question.qid;
    await writeFile(join(pending, `${name}.json`), JSON.stringify(judgeRequest(question, reply)));
  }
  await writeFile(join(pending, 'index.json'), JSON.stringify(index));
  return Object.keys(index).length;
}

const describeSchema = z.object({ judge: z.string().min(1), model: z.string().min(1), effort: z.string().min(1) });

// Reads what the adapter wrote for each pending request (<name>.out and <name>.status, from call-all.sh), records a
// judgment for each, and writes the judge file. A failing command, or an answer outside the schema, is a failure.
export async function collectJudging(runDir: string): Promise<{ judged: number; failures: number }> {
  const pending = join(runDir, PENDING);
  const index = JSON.parse(await readFile(join(pending, 'index.json'), 'utf8')) as Record<string, string>;
  let describe: z.infer<typeof describeSchema>;
  try {
    describe = describeSchema.parse(JSON.parse(await readFile(join(pending, 'describe.json'), 'utf8')));
  } catch {
    throw new Error('the adapter did not describe itself (judge, model, effort)');
  }
  const present = new Set(await readdir(pending));
  const lines: string[] = [];
  let judged = 0;
  let failures = 0;
  for (const [name, qid] of Object.entries(index)) {
    let judgment: Judgment;
    const status = present.has(`${name}.status`) ? (await readFile(join(pending, `${name}.status`), 'utf8')).trim() : 'missing';
    if (status !== '0') {
      judgment = { qid, ok: false, failure: status === 'missing' ? 'the judge was not called' : `the judge command exited ${status}` };
    } else {
      const out = present.has(`${name}.out`) ? await readFile(join(pending, `${name}.out`), 'utf8') : '';
      let value: unknown;
      try {
        value = JSON.parse(out);
      } catch {
        value = undefined;
      }
      const verdict = verdictSchema.safeParse(value);
      judgment = verdict.success ? { qid, ok: true, verdict: verdict.data.verdict, reason: verdict.data.reason } : { qid, ok: false, failure: 'the judge answered outside the schema' };
    }
    if (judgment.ok) judged++;
    else failures++;
    lines.push(`${JSON.stringify(judgment)}\n`);
  }
  const previous = (await readJudgments(runDir)) ?? [];
  const kept = previous.filter((judgment) => !Object.values(index).includes(judgment.qid));
  await writeFile(join(runDir, JUDGMENTS), [...kept.map((judgment) => `${JSON.stringify(judgment)}\n`), ...lines].join(''));
  await writeFile(join(runDir, JUDGE_FILE), `${JSON.stringify({ ...describe, prompt_sha256: promptSha256() }, null, 2)}\n`);
  await rm(pending, { recursive: true, force: true });
  return { judged, failures };
}

// ---------- the check of the judge by a person ----------

export const CHECK_FILE = 'judge-check.csv';
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

// The check file: `count` judged items drawn by seed, each with the question, the reference, the reply and an empty
// column for a person's verdict. It holds text and lives only under evaluation/data (ignored).
export function checkFile(items: readonly { question: Question; reply: string }[], judgments: readonly Judgment[], count: number): string {
  const judged = new Set(judgments.filter((judgment) => judgment.ok).map((judgment) => judgment.qid));
  const candidates = items.filter((item) => judged.has(item.question.qid));
  const chosen = new Set(seededShuffle(candidates.map((item) => item.question.qid), CHECK_SEED, 'check').slice(0, count));
  const rows = [['qid', 'question', 'reference', 'reply', 'person_verdict'].map(csvField).join(',')];
  for (const item of candidates) {
    if (!chosen.has(item.question.qid)) continue;
    rows.push([item.question.qid, item.question.question, item.question.answer, withoutCitationMarkers(item.reply), ''].map(csvField).join(','));
  }
  return `${rows.join('\n')}\n`;
}

// A person's verdicts from a filled check file, by qid; null when none is filled. A cell that is not one of the three
// verdicts is an error, named by its row.
export function personVerdicts(text: string): Map<string, Verdict> | null {
  const rows = parseCsv(text);
  const [header, ...body] = rows;
  const qidAt = header?.indexOf('qid') ?? -1;
  const verdictAt = header?.indexOf('person_verdict') ?? -1;
  if (qidAt < 0 || verdictAt < 0) throw new Error(`${CHECK_FILE} has no qid or person_verdict column`);
  const verdicts = new Map<string, Verdict>();
  body.forEach((row, at) => {
    const value = (row[verdictAt] ?? '').trim();
    if (value === '') return;
    const verdict = VERDICTS.find((candidate) => candidate === value);
    if (verdict === undefined) throw new Error(`${CHECK_FILE} row ${at + 2}: person_verdict must be correct, partly_correct or incorrect`);
    verdicts.set(row[qidAt] ?? '', verdict);
  });
  return verdicts.size === 0 ? null : verdicts;
}
