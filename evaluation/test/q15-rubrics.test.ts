// Q15 and Q16. The judge's rubrics: each rubric's request and verdict schema (the committed schema file the adapter
// hands the model agrees with the schema the verdicts are checked against); judgments stored per rubric; a run folder's
// old judgments.jsonl read as completeness, carried over and never rewritten; a verdict outside the rubric's schema
// recorded as a failure. The scores of the answers-question rubric, by type, where "answers the question,
// uncontradicted" needs both of its conditions. The judge is the labelled stand-in adapter (a test double).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { collectJudging, judgeRequest, prepareJudging, readJudgments } from '../src/judge.ts';
import { ANSWERS, ANSWERS_QUESTION_INSTRUCTIONS, COMPLETENESS_INSTRUCTIONS, COVERAGE, RUBRICS, RUBRIC_NAMES, VERDICTS, instructionsSha256 } from '../src/rubric.ts';
import type { AnswersJudgment, RubricName } from '../src/rubric.ts';
import { scoreRun } from '../src/score.ts';
import { formatScores } from '../src/table.ts';
import { folder, question, record, response } from './support.ts';

const run = promisify(execFile);
const CALL_ALL = new URL('../judge/call-all.sh', import.meta.url).pathname;
// The labelled stand-in for the judge adapter (evaluation/test/stand-in-adapter.sh, a test double, not a judge).
const STAND_IN = new URL('./stand-in-adapter.sh', import.meta.url).pathname;
const schemaPath = (rubric: RubricName): string => new URL(`../judge/${RUBRICS[rubric].schemaFile}`, import.meta.url).pathname;

type JsonSchema = { type: string; properties: Record<string, { type: string; enum?: string[] }>; required: string[]; additionalProperties: boolean };

test('Q15. each rubric\'s request holds its instructions, the question, the reference and the reply; its schema file agrees with its verdict schema', async () => {
  const q = question('q1', 'factual', { question: 'Invented question?', answer: 'Invented reference.' });
  for (const rubric of RUBRIC_NAMES) {
    const request = judgeRequest(rubric, q, 'Invented reply. [1]');
    assert.deepEqual(Object.keys(request).sort(), ['instructions', 'question', 'reference', 'reply']);
    assert.deepEqual([request.question, request.reference, request.reply], ['Invented question?', 'Invented reference.', 'Invented reply.']);
  }
  assert.equal(judgeRequest('completeness', q, 'x').instructions, COMPLETENESS_INSTRUCTIONS);
  assert.equal(judgeRequest('answers-question', q, 'x').instructions, ANSWERS_QUESTION_INSTRUCTIONS);
  assert.notEqual(instructionsSha256('completeness'), instructionsSha256('answers-question'));

  // The committed schema files, as the adapter hands them to the model.
  const completeness = JSON.parse(await readFile(schemaPath('completeness'), 'utf8')) as JsonSchema;
  assert.deepEqual(completeness.required.sort(), ['reason', 'verdict']);
  assert.deepEqual(completeness.properties.verdict?.enum, [...VERDICTS]);
  assert.equal(completeness.additionalProperties, false);
  const answers = JSON.parse(await readFile(schemaPath('answers-question'), 'utf8')) as JsonSchema;
  assert.deepEqual(answers.required.sort(), ['answers', 'contradicts', 'coverage', 'reason']);
  assert.deepEqual(answers.properties.answers?.enum, [...ANSWERS]);
  assert.equal(answers.properties.contradicts?.type, 'boolean');
  assert.deepEqual(answers.properties.coverage?.enum, [...COVERAGE]);
  assert.equal(answers.additionalProperties, false);

  // The verdict schemas the answers are checked against: each accepts its own shape, and refuses the other's, a value
  // outside an enum, and an extra field.
  const good = { answers: 'yes', contradicts: false, coverage: 'all', reason: 'Invented.' };
  assert.equal(RUBRICS['answers-question'].verdictSchema.safeParse(good).success, true);
  assert.equal(RUBRICS['answers-question'].verdictSchema.safeParse({ ...good, answers: 'maybe' }).success, false);
  assert.equal(RUBRICS['answers-question'].verdictSchema.safeParse({ ...good, extra: 1 }).success, false);
  assert.equal(RUBRICS['answers-question'].verdictSchema.safeParse({ verdict: 'correct', reason: 'Invented.' }).success, false);
  assert.equal(RUBRICS.completeness.verdictSchema.safeParse({ verdict: 'correct', reason: 'Invented.' }).success, true);
  assert.equal(RUBRICS.completeness.verdictSchema.safeParse(good).success, false);
});

// What judge.sh does on the operator's machine, under one rubric, with the stand-in in place of the Codex adapter.
async function judgeOnce(runDir: string, rubric: RubricName, calls: string, questions: ReturnType<typeof question>[], records: ReturnType<typeof record>[]) {
  const env = { ...process.env, STAND_IN_CALLS: calls };
  await prepareJudging(runDir, rubric, questions, records, false);
  const { stdout } = await run(STAND_IN, ['--describe'], { env });
  await writeFile(join(runDir, `judge-pending-${rubric}`, 'describe.json'), stdout);
  await run(CALL_ALL, [join(runDir, `judge-pending-${rubric}`), STAND_IN, '4', '20', schemaPath(rubric)], { env });
  return collectJudging(runDir, rubric);
}

const callCount = async (path: string): Promise<number> => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '').length;

test('Q15. judgments are stored per rubric; an old judgments.jsonl is read as completeness; a verdict outside the rubric\'s schema is a failure', async (t) => {
  const dir = await folder(t);
  const calls = join(dir, 'calls');
  const words = ['GOOD', 'HALF', 'CONTRA', 'ODD', 'WRONGSHAPE', 'NOPE'];
  const questions = words.map((word, at) => question(`q${at}`, 'factual'));
  const records = words.map((word, at) => record(`q${at}`, response({ labelAnswer: 'answered', reply: `Invented ${word} reply. [1]` })));

  // A run folder judged before rubrics existed: judgments.jsonl, for two of the questions.
  const legacy = `${JSON.stringify({ qid: 'q0', ok: true, verdict: 'correct', reason: 'Invented.' })}\n${JSON.stringify({ qid: 'q1', ok: true, verdict: 'partly_correct', reason: 'Invented.' })}\n`;
  await writeFile(join(dir, 'judgments.jsonl'), legacy);
  assert.deepEqual(((await readJudgments(dir, 'completeness')) ?? []).map((j) => j.qid), ['q0', 'q1']);
  assert.equal(await readJudgments(dir, 'answers-question'), null);

  // answers-question: every question is asked; the ODD and the completeness-shaped verdicts are failures.
  assert.deepEqual(await judgeOnce(dir, 'answers-question', calls, questions, records), { judged: 4, failures: 2 });
  assert.equal(await callCount(calls), 6);
  const answers = (await readJudgments(dir, 'answers-question')) ?? [];
  assert.deepEqual(
    answers.map((j) => (j.ok ? [j.qid, j.answers, j.contradicts, j.coverage] : [j.qid, j.failure])),
    [
      ['q0', 'yes', false, 'all'],
      ['q1', 'partly', false, 'some'],
      ['q2', 'yes', true, 'some'],
      ['q3', 'the judge answered outside the schema'],
      ['q4', 'the judge answered outside the schema'],
      ['q5', 'no', false, 'none'],
    ],
  );
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'judge-answers-question.json'), 'utf8')), {
    judge: 'stand-in',
    model: 'none',
    effort: 'none',
    rubric: 'answers-question',
    instructions_sha256: instructionsSha256('answers-question'),
  });

  // completeness: the two questions in the old file are not asked again; the four others are.
  assert.deepEqual(await judgeOnce(dir, 'completeness', calls, questions, records), { judged: 3, failures: 1 });
  assert.equal(await callCount(calls), 10);
  const completeness = (await readJudgments(dir, 'completeness')) ?? [];
  assert.deepEqual(completeness.map((j) => j.qid), ['q0', 'q1', 'q2', 'q3', 'q4', 'q5']);
  assert.deepEqual((completeness[3] as { failure?: string }).failure, 'the judge answered outside the schema');
  // The new file carries the old judgments over; the old file is left as it was, and each rubric keeps its own.
  assert.equal(await readFile(join(dir, 'judgments.jsonl'), 'utf8'), legacy);
  assert.equal((await readFile(join(dir, 'judgments-completeness.jsonl'), 'utf8')).split('\n').filter(Boolean).length, 6);
  assert.equal(((await readJudgments(dir, 'answers-question')) ?? []).length, 6);
  assert.equal(JSON.parse(await readFile(join(dir, 'judge-completeness.json'), 'utf8')).rubric, 'completeness');
});

test('Q16. answers-question scores: answers uncontradicted, contradicts, and coverage, by type; the first needs both conditions', () => {
  const questions = [question('f1', 'factual'), question('f2', 'factual'), question('f3', 'factual'), question('f4', 'factual'), question('n1', 'numeric'), question('l1', 'list')];
  const records = questions.map((q) => record(q.qid, response({ labelAnswer: 'answered' })));
  const verdict = (qid: string, answers: 'yes' | 'partly' | 'no', contradicts: boolean, coverage: 'all' | 'some' | 'none'): AnswersJudgment => ({ qid, ok: true, answers, contradicts, coverage, reason: 'Invented.' });
  const answersJudgments: AnswersJudgment[] = [
    verdict('f1', 'yes', false, 'some'), // answers, uncontradicted
    verdict('f2', 'yes', true, 'some'), // answers, but contradicted: not counted
    verdict('f3', 'partly', false, 'all'), // uncontradicted, but only partly: not counted
    verdict('f4', 'no', false, 'none'),
    verdict('n1', 'yes', false, 'all'),
    { qid: 'l1', ok: false, failure: 'the judge command exited 3' },
  ];
  const scores = scoreRun({ questions, records, sections: new Map(), judgments: null, personVerdicts: null, answersJudgments });
  const a = scores.answersQuestion;
  assert.ok(a !== null);
  assert.deepEqual([a.judged, a.failures], [5, 1]);
  const pair = (share: { numerator: number; denominator: number } | undefined) => [share?.numerator, share?.denominator];
  assert.deepEqual(pair(a.all.answersUncontradicted), [2, 5]);
  assert.deepEqual(pair(a.all.contradicts), [1, 5]);
  assert.deepEqual([pair(a.all.coverage.all), pair(a.all.coverage.some), pair(a.all.coverage.none)], [[2, 5], [2, 5], [1, 5]]);
  assert.deepEqual(pair(a.byType.factual?.answersUncontradicted), [1, 4]);
  assert.deepEqual(pair(a.byType.factual?.contradicts), [1, 4]);
  assert.deepEqual(pair(a.byType.numeric?.answersUncontradicted), [1, 1]);
  assert.deepEqual(pair(a.byType.list?.answersUncontradicted), [0, 0]);
  assert.deepEqual(
    ['f1', 'f2', 'f3', 'f4', 'n1', 'l1'].map((qid) => scores.perQuestion[qid]?.answers_uncontradicted),
    [true, false, false, false, true, undefined],
  );
  // The completeness rubric is not judged here, and the table reports only the rubric that is.
  assert.equal(scores.correctness, null);
  const table = formatScores(scores);
  assert.ok(table.includes('rubric answers-question (judged 5, judge failures 1):'));
  assert.ok(table.some((line) => line.includes('all: answers the question, uncontradicted') && line.includes('2 of 5')));
  assert.equal(table.includes('correctness: not judged'), false);
  assert.equal(table.some((line) => line.startsWith('correctness, rubric completeness')), false);
});
