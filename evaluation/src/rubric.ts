// The judge's rubrics. A rubric is a name, the instructions every request under it carries, and the schema its verdict
// must keep to (here in zod, and as the JSON schema file the adapter hands the model, evaluation/judge/<file>). Every
// rubric's request holds the same three things beside its instructions: the question, the benchmark's answer (the
// reference) and the reply without citation markers.
//
//   completeness       correct / partly_correct / incorrect against every fact of the reference (the first rubric)
//   answers-question   does the reply answer what the question asks, does it state anything the reference
//                      contradicts, and how much of the reference it covers

import { createHash } from 'node:crypto';

import { z } from 'zod';

export const RUBRIC_NAMES = ['completeness', 'answers-question'] as const;
export type RubricName = (typeof RUBRIC_NAMES)[number];

export const isRubricName = (value: string): value is RubricName => (RUBRIC_NAMES as readonly string[]).includes(value);

export const VERDICTS = ['correct', 'partly_correct', 'incorrect'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const ANSWERS = ['yes', 'partly', 'no'] as const;
export type Answers = (typeof ANSWERS)[number];
export const COVERAGE = ['all', 'some', 'none'] as const;
export type Coverage = (typeof COVERAGE)[number];

const reason = z.string().min(1).max(1000);

// The first rubric's instructions, unchanged: their hash is the one the first runs' judge files recorded.
export const COMPLETENESS_INSTRUCTIONS =
  'You grade an answer to a question about a medicine against a reference answer taken from the medicine\'s approved label. ' +
  'Compare only what the reply says with what the reference says. Grade "correct" when the reply gives every fact the reference gives and ' +
  'contradicts none; "partly_correct" when it gives some of them and contradicts none; "incorrect" when it gives none of them, or contradicts ' +
  'the reference. Extra true detail is not an error. Give one sentence of reason. Answer only with the JSON object the schema asks for.';

export const ANSWERS_QUESTION_INSTRUCTIONS =
  'You grade a reply to a question about a medicine. You are given the question, a reference answer taken from the medicine\'s approved label, ' +
  'and the reply. The reference may hold more than the question asks for. ' +
  '"answers": "yes" when the reply answers what the question asks and nothing in it is contradicted by the reference; "partly" when it answers ' +
  'part of what the question asks; "no" when it does not answer what the question asks. ' +
  '"contradicts": true when the reply states something the reference contradicts, otherwise false. ' +
  '"coverage": "all" when every fact of the reference appears in the reply, "some" when some do, "none" when none do. ' +
  'Extra true detail is not an error. Give one sentence of reason. Answer only with the JSON object the schema asks for.';

export const completenessVerdictSchema = z.strictObject({ verdict: z.enum(VERDICTS), reason });
export const answersQuestionVerdictSchema = z.strictObject({ answers: z.enum(ANSWERS), contradicts: z.boolean(), coverage: z.enum(COVERAGE), reason });

export type CompletenessVerdict = z.infer<typeof completenessVerdictSchema>;
export type AnswersQuestionVerdict = z.infer<typeof answersQuestionVerdictSchema>;

type Failure = { qid: string; ok: false; failure: string };
// One stored judgment per question and rubric: the verdict's fields, or the failure.
export type Judgment = ({ qid: string; ok: true } & CompletenessVerdict) | Failure;
export type AnswersJudgment = ({ qid: string; ok: true } & AnswersQuestionVerdict) | Failure;
export type JudgmentOf = { completeness: Judgment; 'answers-question': AnswersJudgment };

export type Rubric = { name: RubricName; instructions: string; schemaFile: string; verdictSchema: z.ZodType };

export const RUBRICS: Record<RubricName, Rubric> = {
  completeness: { name: 'completeness', instructions: COMPLETENESS_INSTRUCTIONS, schemaFile: 'verdict.schema.json', verdictSchema: completenessVerdictSchema },
  'answers-question': { name: 'answers-question', instructions: ANSWERS_QUESTION_INSTRUCTIONS, schemaFile: 'answers-question.schema.json', verdictSchema: answersQuestionVerdictSchema },
};

export const instructionsSha256 = (rubric: RubricName): string => createHash('sha256').update(RUBRICS[rubric].instructions).digest('hex');

// "Answers the question, uncontradicted": the answers-question rubric's first measure. Both conditions are needed.
export const answersUncontradicted = (verdict: Pick<AnswersQuestionVerdict, 'answers' | 'contradicts'>): boolean => verdict.answers === 'yes' && !verdict.contradicts;
