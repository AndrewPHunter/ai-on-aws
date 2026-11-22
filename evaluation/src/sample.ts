// Draws the sample: only questions whose label is in the corpus manifest, stratified by question type with the counts
// in the committed settings, each stratum chosen by a seeded shuffle of its sorted qids. The same benchmark files and
// settings always give the same sample.

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { InputError, QUESTION_TYPES } from './benchmark.ts';
import type { Question, QuestionType } from './benchmark.ts';

export const sampleSettingsSchema = z.object({
  seed: z.number().int(),
  strata: z.object({ refusal: z.number().int().nonnegative(), factual: z.number().int().nonnegative(), multihop: z.number().int().nonnegative(), numeric: z.number().int().nonnegative(), list: z.number().int().nonnegative() }),
  // The SHA-256 of the benchmark's question file and of the corpus manifest the committed list was drawn from.
  drawnFrom: z.object({ qa: z.string().regex(/^[0-9a-f]{64}$/), manifest: z.string().regex(/^[0-9a-f]{64}$/) }).nullable(),
  // The drawn qids, in sample order: identifiers only. Null until the first draw is recorded.
  qids: z.array(z.string()).nullable(),
});

export type SampleSettings = z.infer<typeof sampleSettingsSchema>;

// A deterministic stream of numbers in [0, 1) for one key: SHA-256 of the key and a counter, read as 32 bits.
function stream(key: string): () => number {
  let counter = 0;
  return () => createHash('sha256').update(`${key}:${counter++}`).digest().readUInt32BE(0) / 2 ** 32;
}

// Fisher-Yates over the qids sorted in code-unit order, with the stream for this seed and type.
export function seededShuffle(ids: readonly string[], seed: number, type: string): string[] {
  const order = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const next = stream(`${seed}:${type}`);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const held = order[i] as string;
    order[i] = order[j] as string;
    order[j] = held;
  }
  return order;
}

// The sample, stratum by stratum in a fixed order. A stratum with fewer eligible questions than it asks for fails,
// naming it.
export function drawSample(questions: readonly Question[], setIds: ReadonlySet<string>, settings: Pick<SampleSettings, 'seed' | 'strata'>): Question[] {
  const byQid = new Map(questions.map((question) => [question.qid, question]));
  if (byQid.size !== questions.length) throw new InputError('the benchmark holds a qid more than once');
  const sample: Question[] = [];
  for (const type of QUESTION_TYPES) {
    const wanted = settings.strata[type as QuestionType];
    const eligible = questions.filter((question) => question.question_type === type && setIds.has(question.set_id)).map((question) => question.qid);
    if (eligible.length < wanted) throw new InputError(`the stratum ${type} has ${eligible.length} questions whose label is in the manifest; ${wanted} are asked for`);
    for (const qid of seededShuffle(eligible, settings.seed, type).slice(0, wanted)) {
      const question = byQid.get(qid);
      if (question !== undefined) sample.push(question);
    }
  }
  return sample;
}

// Compares a draw with the committed list. Null when they agree.
export function sampleDifference(drawn: readonly string[], settings: SampleSettings, hashes: { qa: string; manifest: string }): string | null {
  if (settings.qids === null) return 'evaluation/sample.json holds no list of qids yet: run evaluation/sample.sh --record, and commit the file';
  const same = drawn.length === settings.qids.length && drawn.every((qid, at) => qid === settings.qids?.[at]);
  if (same) return null;
  const changed = settings.drawnFrom === null || settings.drawnFrom.qa !== hashes.qa || settings.drawnFrom.manifest !== hashes.manifest;
  const missing = settings.qids.filter((qid) => !drawn.includes(qid)).length;
  return `the draw differs from the list in evaluation/sample.json (${missing} committed qids not drawn${changed ? '; the benchmark file or the manifest differs from the ones it was drawn from' : ''})`;
}
