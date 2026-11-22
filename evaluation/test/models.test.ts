// The invariants of the model calls ("Always true" 6, 7 and 12 in docs/architecture/evaluation.md): the judge and the
// rewriter. Each test runs the steps judge.sh or reword.sh runs, through the files between them and
// evaluation/judge/call-all.sh, with the labelled stand-in adapter (a test double) in place of the model: the files
// between the steps are what these invariants are about.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { collectJudging, prepareJudging, readJudgments } from '../src/judge.ts';
import { CHECK_INSTRUCTIONS, REWRITE_INSTRUCTIONS, collectRewording, prepareChecks, prepareRewording } from '../src/reword.ts';
import { RUBRICS } from '../src/rubric.ts';
import type { RubricName } from '../src/rubric.ts';
import type { Question } from '../src/benchmark.ts';
import type { CallRecord } from '../src/run.ts';
import { callAdapter, describeAdapter, folder, question, record, requests, response } from './support.ts';

const SCHEMA: Record<RubricName, string> = { completeness: 'judge/verdict.schema.json', 'answers-question': 'judge/answers-question.schema.json' };

// What judge.sh does for one rubric: prepare, call the adapter for each request, collect.
async function judge(runDir: string, rubric: RubricName, questions: Question[], records: CallRecord[], log: string) {
  await prepareJudging(runDir, rubric, questions, records, false);
  await describeAdapter(join(runDir, `judge-pending-${rubric}`));
  await callAdapter(join(runDir, `judge-pending-${rubric}`), SCHEMA[rubric], log);
  return collectJudging(runDir, rubric);
}

test('evaluation 6. the judge is given the instructions, the question, the reference and the reply without markers, nothing else; a failing or out-of-schema call is a failure', async (t) => {
  const dir = await folder(t);
  const log = join(dir, 'log');
  const words = ['GOOD', 'FAIL', 'ODD'];
  const questions = words.map((word, at) => question(`qid-${at}`, 'factual', { question: `Invented question ${word}?`, answer: `Invented reference ${word}.` }));
  const records = words.map((word, at) => record(`qid-${at}`, response({ labelAnswer: 'answered', reply: `Invented ${word} reply. [1]\n\nMore. [2]` })));

  assert.deepEqual(await judge(dir, 'answers-question', questions, records, log), { judged: 1, failures: 2 });

  const asked = await requests(log);
  assert.equal(asked.length, 3);
  for (const request of asked) {
    assert.deepEqual(Object.keys(request).sort(), ['instructions', 'question', 'reference', 'reply']);
    for (const absent of ['qid-', 'passage-zz1', '00000000-0000-4000-8000', '[1]']) assert.equal(JSON.stringify(request).includes(absent), false, absent);
  }
  assert.deepEqual(
    asked.find((request) => request.question === 'Invented question GOOD?'),
    { instructions: RUBRICS['answers-question'].instructions, question: 'Invented question GOOD?', reference: 'Invented reference GOOD.', reply: 'Invented GOOD reply.\n\nMore.' },
  );
  const stored = new Map(((await readJudgments(dir, 'answers-question')) ?? []).map((judgment) => [judgment.qid, judgment]));
  assert.equal(stored.get('qid-0')?.ok, true);
  for (const qid of ['qid-1', 'qid-2']) {
    assert.equal(stored.get(qid)?.ok, false, qid);
    assert.equal('answers' in (stored.get(qid) ?? {}), false, qid);
  }
});

test('evaluation 7. the rewriter and the checker are given only their two fields; a rewrite is used only when it keeps the name and is judged the same; any failure keeps the original, counted', async (t) => {
  const dir = await folder(t);
  const pending = join(dir, 'pending');
  const log = join(dir, 'log');
  const rows = [
    ['used', 'GOOD'],
    ['name-lost', 'NONAME'],
    ['not-same', 'DIFF'],
    ['rewrite-failed', 'RWFAIL'],
    ['rewrite-outside', 'RWODD'],
    ['check-failed', 'CKFAIL'],
  ] as const;
  const questions = [...rows.map(([qid, word]) => question(qid, 'factual', { question: `What Examplamab dose, ${word}?` })), question('refusal', 'refusal')];
  const extras = new Map(questions.map((q) => [q.qid, { drugName: 'Examplamab', context: 'Invented passage.' }]));

  await prepareRewording(pending, questions, extras);
  await callAdapter(join(pending, 'rewrite'), 'reword/rewrite.schema.json', log);
  await prepareChecks(pending, questions, extras);
  await callAdapter(join(pending, 'check'), 'reword/same.schema.json', log);
  const outcome = await collectRewording(pending, questions, extras);

  const asked = await requests(log);
  const rewrites = asked.filter((request) => 'drug_name' in request);
  assert.deepEqual(rewrites.map((request) => request.question).sort(), rows.map(([, word]) => `What Examplamab dose, ${word}?`).sort());
  for (const request of rewrites) assert.deepEqual(request, { instructions: REWRITE_INSTRUCTIONS, question: request.question, drug_name: 'Examplamab' });
  const checks = asked.filter((request) => !('drug_name' in request));
  for (const request of checks) assert.deepEqual(Object.keys(request).sort(), ['instructions', 'original', 'rewrite']);
  assert.deepEqual(
    checks.find((request) => request.original === 'What Examplamab dose, GOOD?'),
    { instructions: CHECK_INSTRUCTIONS, original: 'What Examplamab dose, GOOD?', rewrite: 'Rephrased Examplamab question?' },
  );

  const lines = new Map(outcome.lines.map((line) => [line.qid, line]));
  assert.deepEqual([lines.get('used')?.reworded, lines.get('used')?.question], [true, 'Rephrased Examplamab question?']);
  for (const q of questions.filter((q) => q.qid !== 'used')) {
    const line = lines.get(q.qid);
    assert.deepEqual([line?.reworded, line?.question], [false, q.question], q.qid);
    assert.ok(line?.kept_because, q.qid);
  }
  // Each question kept is counted under its own reason.
  assert.deepEqual(Object.values(outcome.counts.kept), [1, 1, 1, 1, 1]);
  assert.equal(outcome.callFailures, 3);
});

test('evaluation 12. judgments are stored per rubric; old judgments are read as the completeness rubric\'s and never rewritten or deleted', async (t) => {
  const dir = await folder(t);
  const log = join(dir, 'log');
  const questions = [question('a', 'factual'), question('b', 'factual')];
  const records = questions.map((q) => record(q.qid, response({ labelAnswer: 'answered', reply: 'Invented GOOD reply.' })));
  const old = `${JSON.stringify({ qid: 'a', ok: true, verdict: 'incorrect', reason: 'Invented old reason.' })}\n`;
  await writeFile(join(dir, 'judgments.jsonl'), old);

  await judge(dir, 'answers-question', questions, records, log);
  await judge(dir, 'completeness', questions, records, log);

  // Completeness asked only about the question the old judgments do not cover.
  const completenessAsked = (await requests(log)).filter((request) => request.instructions === RUBRICS.completeness.instructions);
  assert.deepEqual(completenessAsked.map((request) => request.question), ['Invented question b?']);
  const lines = async (name: string) => (await readFile(join(dir, name), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { qid: string; verdict?: string; answers?: string });
  assert.deepEqual((await lines('judgments-answers-question.jsonl')).map((j) => [j.qid, j.answers]), [['a', 'yes'], ['b', 'yes']]);
  assert.deepEqual((await lines('judgments-completeness.jsonl')).map((j) => [j.qid, j.verdict]), [['a', 'incorrect'], ['b', 'correct']]);
  assert.equal(await readFile(join(dir, 'judgments.jsonl'), 'utf8'), old);
});
