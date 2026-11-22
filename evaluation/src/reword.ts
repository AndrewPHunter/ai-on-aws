// The reworded variant of the sample: the same questions (same qid, answer and references), with each answerable
// question's text rewritten by a model as a clinician or pharmacist would ask it, and checked by a second call that the
// rewrite asks the same thing. Refusal questions are copied unchanged. A rewrite is used only when it keeps the drug's
// name as the original writes it and the checker says it asks the same thing; otherwise the question keeps its original
// text and is counted as not reworded, with the reason.
//
// The rewriter sits behind the same kind of boundary as the judge: a command that takes the output schema file as its
// argument, reads one JSON request on standard input and writes one JSON answer on standard output
// (evaluation/reword/codex.sh). This module writes the requests and reads back the answers; the calls are made by
// evaluation/judge/call-all.sh on the operator's machine, in two rounds: the rewrites, then the checks.
//
// The rewriter is given the question and the drug's name; the checker the original and the rewrite. Neither is given
// the reference, the label, a passage or an identifier.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { InputError } from './benchmark.ts';
import type { BenchmarkExtra, Question } from './benchmark.ts';
import { readCall, requestName } from './judge.ts';
import { thirdCuts, thirdOf, wordingOverlap } from './overlap.ts';
import type { Cuts } from './overlap.ts';
import { seededShuffle } from './sample.ts';
import { isRefusal } from './score.ts';
import { percentile } from './stats.ts';

export const REWORD_CONCURRENCY = 4;

export const REWRITE_INSTRUCTIONS =
  'Rewrite a question about a medicine as a clinician or pharmacist would ask it, in their own words. ' +
  'Keep exactly the same meaning: ask for the same information, under the same conditions. ' +
  'If the question names the drug, keep the drug\'s name exactly as the question writes it. Keep every number and unit as it is. ' +
  'Otherwise use different words from the original wherever a plain clinical or everyday word exists. ' +
  'Answer only with the JSON object the schema asks for, the rewritten question in "question".';

export const CHECK_INSTRUCTIONS =
  'You are given an original question about a medicine and a rewrite of it. Decide whether they ask the same thing: the same information, ' +
  'about the same drug, under the same conditions, with the same numbers and units. Wording may differ. ' +
  'Answer "same": true or false, with one sentence of reason. Answer only with the JSON object the schema asks for.';

export type RewriteRequest = { instructions: string; question: string; drug_name: string };
export type CheckRequest = { instructions: string; original: string; rewrite: string };

export const rewriteRequest = (question: string, drugName: string): RewriteRequest => ({ instructions: REWRITE_INSTRUCTIONS, question, drug_name: drugName });
export const checkRequest = (original: string, rewrite: string): CheckRequest => ({ instructions: CHECK_INSTRUCTIONS, original, rewrite });

export const rewriteSchema = z.strictObject({ question: z.string().trim().min(1).max(2000) });
export const sameSchema = z.strictObject({ same: z.boolean(), reason: z.string().min(1).max(1000) });
export const rewriterDescribeSchema = z.object({ rewriter: z.string().min(1), model: z.string().min(1), effort: z.string().min(1) });

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export const rewordInstructionsSha256 = (): { rewrite: string; check: string } => ({ rewrite: sha256(REWRITE_INSTRUCTIONS), check: sha256(CHECK_INSTRUCTIONS) });

// The drug's name as the original question writes it: the name itself when it appears exactly, otherwise its first
// appearance ignoring case, as spelled there; null when the question does not name the drug.
export function nameAsWritten(original: string, drugName: string): string | null {
  if (drugName === '') return null;
  if (original.includes(drugName)) return drugName;
  const at = original.toLowerCase().indexOf(drugName.toLowerCase());
  return at < 0 ? null : original.slice(at, at + drugName.length);
}

// A rewrite keeps the drug's name when the original names it and the rewrite holds the name as the original writes
// it. A rewrite of a question that does not name the drug has no name to keep.
export function keepsName(original: string, rewrite: string, drugName: string): boolean {
  const name = nameAsWritten(original, drugName);
  return name === null || rewrite.includes(name);
}

// A rewrite that is the original, ignoring case and white space, is not a rewrite.
export const sameText = (original: string, rewrite: string): boolean => {
  const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, '');
  return norm(original) === norm(rewrite);
};

// Why a question kept its original text.
export const KEPT = {
  refusal: 'a refusal question: copied unchanged',
  rewriteFailed: 'the rewrite call failed',
  rewriteOutside: 'the rewrite answered outside the schema',
  nameMissing: 'the rewrite does not keep the drug\'s name',
  unchanged: 'the rewrite is the original, ignoring case and white space',
  checkFailed: 'the check call failed',
  checkOutside: 'the check answered outside the schema',
  notSame: 'the checker judged it not the same',
} as const;
export type KeptBecause = (typeof KEPT)[keyof typeof KEPT];

// One line of the reworded file: the sampled question, its text replaced when reworded, and why not when not.
export type RewordedQuestion = Question & { reworded: boolean; kept_because: KeptBecause | null };

const REWRITE = 'rewrite';
const CHECK = 'check';
const REWRITES_FILE = 'rewrites.json';

// Round one: one rewrite request per answerable question, in <pending>/rewrite/, with index.json naming each file's
// qid. Returns how many were written.
export async function prepareRewording(pending: string, questions: readonly Question[], extras: ReadonlyMap<string, BenchmarkExtra>): Promise<number> {
  await rm(pending, { recursive: true, force: true });
  await mkdir(join(pending, REWRITE), { recursive: true });
  const index: Record<string, string> = {};
  for (const question of questions) {
    if (isRefusal(question)) continue;
    const name = requestName(question.qid);
    index[name] = question.qid;
    await writeFile(join(pending, REWRITE, `${name}.json`), JSON.stringify(rewriteRequest(question.question, extras.get(question.qid)?.drugName ?? '')));
  }
  await writeFile(join(pending, REWRITE, 'index.json'), JSON.stringify(index));
  return Object.keys(index).length;
}

type Interim = Record<string, { rewrite: string } | { kept: KeptBecause }>;

async function readIndex(folder: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(join(folder, 'index.json'), 'utf8')) as Record<string, string>;
  } catch {
    throw new InputError('the rewording requests are not there: run evaluation/reword.sh from the start');
  }
}

// Round two: reads each rewrite back; one that failed, answered outside the schema, is the original again, or lost the
// drug's name is settled
// here (kept, with its reason) and is not sent to the checker. Each other gets a check request in <pending>/check/.
export async function prepareChecks(pending: string, questions: readonly Question[], extras: ReadonlyMap<string, BenchmarkExtra>): Promise<{ toCheck: number; settled: number }> {
  const folder = join(pending, REWRITE);
  const index = await readIndex(folder);
  const present = new Set(await readdir(folder));
  const byQid = new Map(questions.map((question) => [question.qid, question]));
  const interim: Interim = {};
  const checkIndex: Record<string, string> = {};
  await rm(join(pending, CHECK), { recursive: true, force: true });
  await mkdir(join(pending, CHECK), { recursive: true });
  for (const [name, qid] of Object.entries(index)) {
    const question = byQid.get(qid);
    if (question === undefined) throw new InputError('a rewording request names a qid the sample does not hold');
    const call = await readCall(folder, present, name, rewriteSchema, 'rewrite');
    if (!call.ok) {
      interim[qid] = { kept: call.failure.endsWith('outside the schema') ? KEPT.rewriteOutside : KEPT.rewriteFailed };
      continue;
    }
    const rewrite = call.value.question;
    if (sameText(question.question, rewrite)) {
      interim[qid] = { kept: KEPT.unchanged };
      continue;
    }
    if (!keepsName(question.question, rewrite, extras.get(qid)?.drugName ?? '')) {
      interim[qid] = { kept: KEPT.nameMissing };
      continue;
    }
    interim[qid] = { rewrite };
    checkIndex[name] = qid;
    await writeFile(join(pending, CHECK, `${name}.json`), JSON.stringify(checkRequest(question.question, rewrite)));
  }
  await writeFile(join(pending, CHECK, 'index.json'), JSON.stringify(checkIndex));
  await writeFile(join(pending, REWRITES_FILE), JSON.stringify(interim));
  return { toCheck: Object.keys(checkIndex).length, settled: Object.keys(interim).length - Object.keys(checkIndex).length };
}

export type OverlapSummary = { questions: number; median: number | null; cuts: Cuts | null; inThirds: [number, number, number] };

export type RewordOutcome = {
  lines: RewordedQuestion[];
  counts: { questions: number; reworded: number; refusalCopied: number; kept: Record<string, number> };
  callFailures: number;
  overlap: { before: OverlapSummary; after: OverlapSummary };
};

// The overlap of a set of question texts, counted in thirds cut at `cuts` (the original wording's).
function summarise(texts: ReadonlyMap<string, string>, extras: ReadonlyMap<string, BenchmarkExtra>, cuts: Cuts | null): OverlapSummary {
  const values: number[] = [];
  for (const [qid, text] of texts) {
    const extra = extras.get(qid);
    const value = extra === undefined ? null : wordingOverlap(text, extra.drugName, extra.context);
    if (value !== null) values.push(value);
  }
  const ownCuts = cuts ?? thirdCuts(values);
  const thirds = ownCuts === null ? [] : values.map((value) => thirdOf(value, ownCuts));
  const inThirds: [number, number, number] = [thirds.filter((third) => third === 1).length, thirds.filter((third) => third === 2).length, thirds.filter((third) => third === 3).length];
  return { questions: values.length, median: percentile(values, 50), cuts: ownCuts, inThirds };
}

// The last step: reads each check back and builds the reworded sample, in the sample's order.
export async function collectRewording(pending: string, questions: readonly Question[], extras: ReadonlyMap<string, BenchmarkExtra>): Promise<RewordOutcome> {
  const folder = join(pending, CHECK);
  const index = await readIndex(folder);
  let interim: Interim;
  try {
    interim = JSON.parse(await readFile(join(pending, REWRITES_FILE), 'utf8')) as Interim;
  } catch {
    throw new InputError('the rewrites were not read back: run evaluation/reword.sh from the start');
  }
  const present = new Set(await readdir(folder));
  const checked = new Map<string, KeptBecause | null>();
  for (const [name, qid] of Object.entries(index)) {
    const call = await readCall(folder, present, name, sameSchema, 'check');
    if (!call.ok) checked.set(qid, call.failure.endsWith('outside the schema') ? KEPT.checkOutside : KEPT.checkFailed);
    else checked.set(qid, call.value.same ? null : KEPT.notSame);
  }

  const lines: RewordedQuestion[] = [];
  const kept: Record<string, number> = {};
  let callFailures = 0;
  const failures: readonly string[] = [KEPT.rewriteFailed, KEPT.rewriteOutside, KEPT.checkFailed, KEPT.checkOutside];
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  for (const question of questions) {
    if (isRefusal(question)) {
      lines.push({ ...question, reworded: false, kept_because: KEPT.refusal });
      continue;
    }
    const state = interim[question.qid];
    if (state === undefined) throw new InputError('a sampled question was not sent to the rewriter: run evaluation/reword.sh from the start');
    let because: KeptBecause | null;
    let text = question.question;
    if ('kept' in state) because = state.kept;
    else {
      const verdict = checked.get(question.qid);
      // A rewrite with no check read back was not checked: it is not used.
      because = verdict === undefined ? KEPT.checkFailed : verdict;
      if (because === null) text = state.rewrite;
    }
    lines.push({ ...question, question: text, reworded: because === null, kept_because: because });
    if (because !== null) {
      kept[because] = (kept[because] ?? 0) + 1;
      if (failures.includes(because)) callFailures++;
    }
    before.set(question.qid, question.question);
    after.set(question.qid, text);
  }
  const beforeSummary = summarise(before, extras, null);
  return {
    lines,
    counts: { questions: questions.length, reworded: lines.filter((line) => line.reworded).length, refusalCopied: questions.filter(isRefusal).length, kept },
    callFailures,
    overlap: { before: beforeSummary, after: summarise(after, extras, beforeSummary.cuts) },
  };
}

// ---------- pairs for a person to read ----------

export const REWORD_CHECK_FILE = 'reword-check.csv';
const REWORD_CHECK_SEED = 20261124;

const csvField = (value: string): string => `"${value.replace(/"/g, '""')}"`;

// `count` reworded questions drawn by seed, each with its original and its reworded text.
export function rewordCheckFile(original: readonly Question[], reworded: readonly Question[], rewordedQids: ReadonlySet<string>, count: number): string {
  const originals = new Map(original.map((question) => [question.qid, question.question]));
  const chosen = new Set(seededShuffle([...rewordedQids], REWORD_CHECK_SEED, 'reword-check').slice(0, count));
  const rows = [['qid', 'original', 'reworded'].map(csvField).join(',')];
  for (const question of reworded) {
    if (!chosen.has(question.qid)) continue;
    rows.push([question.qid, originals.get(question.qid) ?? '', question.question].map(csvField).join(','));
  }
  return `${rows.join('\n')}\n`;
}
