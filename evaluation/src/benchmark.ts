// The benchmark's questions as the harness reads them, and the set ids of the corpus. Only these fields are read; a
// line that does not have them stops the command, named by its line number, never quoted.

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { ManifestSchema } from '../../knowledge/src/schema.ts';

export const QUESTION_TYPES = ['refusal', 'factual', 'multihop', 'numeric', 'list'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

const questionSchema = z.object({
  qid: z.string().min(1),
  set_id: z.string(),
  question: z.string(),
  answer: z.string(),
  // A list of section names, or (in some factual questions) one section name as a plain string.
  references: z.union([z.array(z.string()), z.string()]),
  task: z.string(),
  question_type: z.enum(QUESTION_TYPES),
});

// One sampled question, as the harness keeps it under evaluation/data (ignored): the fields the runner, the scorer
// and the judge need, with the references always a list.
export type Question = {
  qid: string;
  set_id: string;
  question: string;
  answer: string;
  references: string[];
  task: string;
  question_type: QuestionType;
};

export class InputError extends Error {}

export function parseQuestions(text: string, shown: string): Question[] {
  const questions: Question[] = [];
  for (const [at, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new InputError(`${shown} line ${at + 1} is not JSON`);
    }
    const parsed = questionSchema.safeParse(value);
    if (!parsed.success) throw new InputError(`${shown} line ${at + 1} is not a benchmark question this harness reads`);
    const { references, ...rest } = parsed.data;
    questions.push({ ...rest, references: typeof references === 'string' ? [references] : references });
  }
  return questions;
}

export async function readText(path: string, shown: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new InputError(`${shown} could not be read`);
  }
}

// The set ids of the labels the corpus manifest pins.
export function manifestSetIds(text: string): Set<string> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InputError('knowledge/corpus/manifest.json is not JSON');
  }
  const parsed = ManifestSchema.safeParse(value);
  if (!parsed.success) throw new InputError('knowledge/corpus/manifest.json is not a manifest');
  return new Set(parsed.data.labels.map((label) => label.setId));
}
