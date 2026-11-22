// The variants of the sample a run can be made on. `original` is the sample as sample.sh draws it
// (evaluation/data/sample.jsonl); `reworded` is the same questions with each answerable question's text rewritten by
// reword.sh (evaluation/data/sample-reworded.jsonl, beside it). A run records its variant and the SHA-256 of that
// variant's file; a run file from before variants existed has no variant and is a run on `original`.

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { InputError, parseQuestions, readText } from './benchmark.ts';
import type { Question } from './benchmark.ts';

export const VARIANTS = ['original', 'reworded'] as const;
export type Variant = (typeof VARIANTS)[number];

export const REWORDED_FILE = 'sample-reworded.jsonl';

export const isVariant = (value: string): value is Variant => (VARIANTS as readonly string[]).includes(value);

// The variant's file, given the original sample's path: the reworded file sits beside it under its fixed name.
export const variantPath = (samplePath: string, variant: Variant): string => (variant === 'original' ? samplePath : join(dirname(samplePath), REWORDED_FILE));

const shownName = (variant: Variant): string => (variant === 'original' ? 'evaluation/data/sample.jsonl' : `evaluation/data/${REWORDED_FILE}`);

const rewordedLineSchema = z.object({ qid: z.string(), reworded: z.boolean() });

export type VariantSample = {
  variant: Variant;
  questions: Question[];
  sha256: string;
  // The qids whose text was actually rewritten; null for the original variant.
  reworded: Set<string> | null;
};

export async function readVariant(samplePath: string, variant: Variant): Promise<VariantSample> {
  const shown = shownName(variant);
  const bytes = await readText(variantPath(samplePath, variant), variant === 'original' ? shown : `${shown} (run evaluation/reword.sh first)`);
  const text = bytes.toString('utf8');
  const questions = parseQuestions(text, shown);
  let reworded: Set<string> | null = null;
  if (variant === 'reworded') {
    reworded = new Set();
    for (const [at, line] of text.split('\n').entries()) {
      if (line.trim() === '') continue;
      const parsed = rewordedLineSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new InputError(`${shown} line ${at + 1} does not say whether it was reworded`);
      if (parsed.data.reworded) reworded.add(parsed.data.qid);
    }
  }
  return { variant, questions, sha256: createHash('sha256').update(bytes).digest('hex'), reworded };
}
