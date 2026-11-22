// Q23 to Q25. The answers-question agreement from a filled check file (the two person columns combined, a half-filled
// row refused with its row named); a run folder's old judge-check.csv still read as the completeness check; score and
// the judge's prepare step on a run file with no variant, read as the original sample and not refused.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCommand } from '../src/cli.ts';
import { personAnswers } from '../src/judge.ts';
import type { AnswersJudgment } from '../src/rubric.ts';
import { scoreRun } from '../src/score.ts';
import { benchmarkLineWith, folder, io, question, record, response } from './support.ts';

const HEADER = '"qid","question","reference","reply","person_answers","person_contradicts"';

test('Q23. answers-question agreement: the two person columns combined; a half-filled row refused, named by its row', () => {
  const name = 'judge-check-answers-question.csv';
  const filled = [
    HEADER,
    '"a","q","r","x","yes","false"', // answers, uncontradicted
    '"b","q","r","x","yes","true"', // contradicted: not
    '"c","q","r","x","partly","false"', // only partly: not
    '"d","q","r","x","",""', // not graded
  ].join('\n');
  assert.deepEqual([...(personAnswers(filled, name) ?? new Map())], [['a', true], ['b', false], ['c', false]]);
  assert.equal(personAnswers(`${HEADER}\n"a","q","r","x","",""\n`, name), null);
  assert.throws(() => personAnswers(`${HEADER}\n"a","q","r","x","yes","false"\n"b","q","r","x","yes",""\n`, name), /judge-check-answers-question\.csv row 3/);
  assert.throws(() => personAnswers(`${HEADER}\n"a","q","r","x","","true"\n`, name), /row 2/);
  assert.throws(() => personAnswers(`${HEADER}\n"a","q","r","x","maybe","false"\n`, name), /row 2/);

  // The judge and the person agree on "answers the question, uncontradicted": a and b agree, c does not.
  const questions = ['a', 'b', 'c', 'd'].map((qid) => question(qid, 'factual'));
  const records = questions.map((q) => record(q.qid, response({ labelAnswer: 'answered' })));
  const judge = (qid: string, answers: 'yes' | 'partly', contradicts: boolean): AnswersJudgment => ({ qid, ok: true, answers, contradicts, coverage: 'some', reason: 'Invented.' });
  const scores = scoreRun({
    questions,
    records,
    sections: new Map(),
    judgments: null,
    personVerdicts: null,
    answersJudgments: [judge('a', 'yes', false), judge('b', 'partly', false), judge('c', 'yes', false), judge('d', 'yes', false)],
    answersPersonChecks: personAnswers(filled, name),
  });
  const agree = scores.answersAgreement?.judgeAndPersonAgree;
  assert.deepEqual([agree?.numerator, agree?.denominator], [2, 3]);
});

// A run folder as an earlier harness left it: a run file with no variant, responses, and the files of the first judge.
async function oldRun(dir: string) {
  const data = join(dir, 'data');
  const runDir = join(data, 'runs', 'old-1');
  await mkdir(runDir, { recursive: true });
  const questions = [question('f1', 'factual'), question('f2', 'factual'), question('r1', 'refusal')];
  const sampleText = questions.map((q) => `${JSON.stringify(q)}\n`).join('');
  const sample = join(data, 'sample.jsonl');
  await writeFile(sample, sampleText);
  const sha = createHash('sha256').update(sampleText).digest('hex');
  await writeFile(join(runDir, 'run.json'), JSON.stringify({ sample_sha256: sha, agent_id: 'expert', models: [], strategies: [], started_at: '', ended_at: '' }));
  await writeFile(join(runDir, 'responses.jsonl'), questions.map((q) => `${JSON.stringify(record(q.qid, response({ labelAnswer: 'answered' })))}\n`).join(''));
  const knowledge = join(dir, 'knowledge');
  await mkdir(join(knowledge, 'benchmark'), { recursive: true });
  await writeFile(join(knowledge, 'chunk-report.json'), JSON.stringify({ labels: [] }));
  await writeFile(join(knowledge, 'benchmark', 'qa.jsonl'), `${questions.map((q) => benchmarkLineWith(q, ['Invented passage.'])).join('\n')}\n`);
  return { sample, runDir, knowledge };
}

test('Q24. an old judge-check.csv is still read as the completeness check', async (t) => {
  const { sample, runDir, knowledge } = await oldRun(await folder(t));
  await writeFile(join(runDir, 'judgments.jsonl'), `${JSON.stringify({ qid: 'f1', ok: true, verdict: 'correct', reason: 'Invented.' })}\n${JSON.stringify({ qid: 'f2', ok: true, verdict: 'incorrect', reason: 'Invented.' })}\n`);
  await writeFile(join(runDir, 'judge-check.csv'), '"qid","question","reference","reply","person_verdict"\n"f1","q","r","x","correct"\n"f2","q","r","x","correct"\n');
  assert.equal(await runCommand(['score', '--sample', sample, '--run-dir', runDir, '--knowledge-data', knowledge], io().io), 0);
  const scores = JSON.parse(await readFile(join(runDir, 'scores.json'), 'utf8')) as { agreement: { judgeAndPersonAgree: { numerator: number; denominator: number } } | null };
  assert.deepEqual([scores.agreement?.judgeAndPersonAgree.numerator, scores.agreement?.judgeAndPersonAgree.denominator], [1, 2]);
});

test('Q25. score and the judge\'s prepare step on a run file with no variant: read as the original sample, not refused', async (t) => {
  const { sample, runDir, knowledge } = await oldRun(await folder(t));
  const scored = io();
  assert.equal(await runCommand(['score', '--sample', sample, '--run-dir', runDir, '--knowledge-data', knowledge], scored.io), 0);
  assert.ok(scored.out.includes('sample variant: original'));
  const scores = JSON.parse(await readFile(join(runDir, 'scores.json'), 'utf8')) as { variant: string; rewordedQids: string[] };
  assert.deepEqual([scores.variant, scores.rewordedQids], ['original', []]);
  const prepared = io();
  assert.equal(await runCommand(['judge-prepare', '--sample', sample, '--run-dir', runDir, '--rubric', 'answers-question'], prepared.io), 0);
  assert.ok(prepared.out.includes('rubric answers-question; to judge: 2'));
});
