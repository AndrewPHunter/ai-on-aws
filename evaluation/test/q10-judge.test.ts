// Q10 to Q12. The judge's request holds the question, the reference and the reply without citation markers, and
// nothing else; the judge through a stand-in adapter command (labelled a test double), with failures and resuming;
// scores with judgments, without, and with a filled check file.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { LEGACY_CHECK_FILE, checkFile, collectJudging, judgeRequest, personVerdicts, prepareJudging, readJudgments, toJudge } from '../src/judge.ts';
import { instructionsSha256 } from '../src/rubric.ts';
import { scoreRun } from '../src/score.ts';
import type { Judgment } from '../src/score.ts';
import { formatScores } from '../src/table.ts';
import { folder, question, record, response } from './support.ts';

const run = promisify(execFile);
const CALL_ALL = new URL('../judge/call-all.sh', import.meta.url).pathname;
const SCHEMA = new URL('../judge/verdict.schema.json', import.meta.url).pathname;

test('Q10. the request holds the question, the reference and the reply without citation markers, and nothing else', () => {
  const q = question('q1', 'factual', { question: 'Invented question?', answer: 'Invented reference.' });
  const request = judgeRequest('completeness', q, 'First invented statement. [1]\n\nSecond invented statement. [2]');
  assert.deepEqual(Object.keys(request).sort(), ['instructions', 'question', 'reference', 'reply']);
  assert.equal(request.question, 'Invented question?');
  assert.equal(request.reference, 'Invented reference.');
  assert.equal(request.reply, 'First invented statement.\n\nSecond invented statement.');
  const text = JSON.stringify(request);
  for (const absent of ['q1', '[1]', '00000000-0000-4000-8000', 'passage', 'set_id', 'citation']) assert.equal(text.includes(absent), false, absent);
});

// The labelled stand-in for the judge adapter (evaluation/test/stand-in-adapter.sh, a test double, not a judge), with
// the file it counts its calls in.
function standInAdapter(dir: string): { path: string; env: NodeJS.ProcessEnv; calls: () => Promise<number> } {
  const counter = join(dir, 'calls');
  return {
    path: new URL('./stand-in-adapter.sh', import.meta.url).pathname,
    env: { ...process.env, STAND_IN_CALLS: counter },
    calls: async () => (await readFile(counter, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '').length,
  };
}

// What judge.sh does on the operator's machine, with the stand-in in place of the Codex adapter.
async function judgeOnce(
  runDir: string,
  adapter: { path: string; env: NodeJS.ProcessEnv },
  questions: ReturnType<typeof question>[],
  records: ReturnType<typeof record>[],
  retryFailed = false,
) {
  await prepareJudging(runDir, 'completeness', questions, records, retryFailed);
  const { stdout } = await run(adapter.path, ['--describe'], { env: adapter.env });
  await writeFile(join(runDir, 'judge-pending-completeness', 'describe.json'), stdout);
  await run(CALL_ALL, [join(runDir, 'judge-pending-completeness'), adapter.path, '4', '20', SCHEMA], { env: adapter.env });
  return collectJudging(runDir, 'completeness');
}

test('Q11. verdicts are stored; a failing command and an answer outside the schema are failures, counted; resuming does not ask again', async (t) => {
  const dir = await folder(t);
  const runDir = join(dir, 'run');
  await mkdir(runDir, { recursive: true });
  const adapter = standInAdapter(dir);
  const words = ['GOOD', 'HALF', 'NOPE', 'FAIL', 'ODD'];
  const questions = [...words.map((word, at) => question(`q${at}`, 'factual')), question('r1', 'refusal'), question('d1', 'factual')];
  const records = [
    ...words.map((word, at) => record(`q${at}`, response({ labelAnswer: 'answered', reply: `Invented ${word} reply. [1]` }))),
    record('r1', response({ labelAnswer: 'answered', reply: 'Invented GOOD reply.' })),
    record('d1', response({ labelAnswer: 'label_does_not_answer' })),
  ];

  const first = await judgeOnce(runDir, adapter, questions, records);

  assert.deepEqual(first, { judged: 3, failures: 2 });
  // Only answerable questions the agent answered are judged.
  assert.equal(await adapter.calls(), 5);
  const judgments = (await readJudgments(runDir, 'completeness')) ?? [];
  assert.deepEqual(
    judgments.map((j) => (j.ok ? [j.qid, j.verdict] : [j.qid, j.failure])),
    [
      ['q0', 'correct'],
      ['q1', 'partly_correct'],
      ['q2', 'incorrect'],
      ['q3', 'the judge command exited 3'],
      ['q4', 'the judge answered outside the schema'],
    ],
  );
  const judgeFile = JSON.parse(await readFile(join(runDir, 'judge-completeness.json'), 'utf8')) as Record<string, string>;
  assert.deepEqual(judgeFile, { judge: 'stand-in', model: 'none', effort: 'none', rubric: 'completeness', instructions_sha256: instructionsSha256('completeness') });
  assert.equal((await readdir(runDir)).includes('judge-pending-completeness'), false);

  // Started again: nothing asked. With --retry-failed: only the two failures.
  assert.deepEqual(await judgeOnce(runDir, adapter, questions, records), { judged: 0, failures: 0 });
  assert.equal(await adapter.calls(), 5);
  await judgeOnce(runDir, adapter, questions, records, true);
  assert.equal(await adapter.calls(), 7);
  assert.equal(((await readJudgments(runDir, 'completeness')) ?? []).length, 5);
});

test('Q12. scores: the three shares by type with judgments; "not judged" without; the agreement with a filled check file', () => {
  const questions = [question('f1', 'factual'), question('f2', 'factual'), question('n1', 'numeric'), question('l1', 'list')];
  const records = questions.map((q) => record(q.qid, response({ labelAnswer: 'answered', reply: 'Invented reply. [1]' })));
  const judgments: Judgment[] = [
    { qid: 'f1', ok: true, verdict: 'correct', reason: 'Invented.' },
    { qid: 'f2', ok: true, verdict: 'incorrect', reason: 'Invented.' },
    { qid: 'n1', ok: true, verdict: 'partly_correct', reason: 'Invented.' },
    { qid: 'l1', ok: false, failure: 'the judge command exited 3' },
  ];
  const base = { questions, records, sections: new Map(), personVerdicts: null };

  const unjudged = scoreRun({ ...base, judgments: null });
  assert.equal(unjudged.correctness, null);
  assert.ok(formatScores(unjudged).includes('correctness: not judged'));

  const judged = scoreRun({ ...base, judgments });
  assert.equal(judged.correctness?.judged, 3);
  assert.equal(judged.correctness?.failures, 1);
  const factual = judged.correctness?.byType.factual;
  assert.deepEqual([factual?.correct.numerator, factual?.incorrect.numerator, factual?.correct.denominator], [1, 1, 2]);
  assert.deepEqual([judged.correctness?.byType.numeric?.partlyCorrect.numerator, judged.correctness?.byType.numeric?.partlyCorrect.denominator], [1, 1]);
  assert.equal(judged.correctness?.byType.list?.correct.denominator, 0);
  assert.equal(judged.perQuestion.f1?.judged_correct, true);

  // The check file: drawn items with an empty person column; filled in, the agreement.
  const text = checkFile('completeness', toJudge(questions, records), judgments, 2);
  const lines = text.trim().split('\n');
  assert.equal(lines[0], '"qid","question","reference","reply","person_verdict"');
  assert.equal(lines.length, 3);
  assert.equal(personVerdicts(text, LEGACY_CHECK_FILE), null);
  const filled = `${lines[0]}\n"f1","q","r","x","correct"\n"f2","q","r","x","correct"\n"n1","q","r","x","partly_correct"\n`;
  const agreement = scoreRun({ ...base, judgments, personVerdicts: personVerdicts(filled, LEGACY_CHECK_FILE) }).agreement;
  assert.deepEqual([agreement?.judgeAndPersonAgree.numerator, agreement?.judgeAndPersonAgree.denominator], [2, 3]);
  assert.throws(() => personVerdicts(`${lines[0]}\n"f1","q","r","x","maybe"\n`, LEGACY_CHECK_FILE), new RegExp(`${LEGACY_CHECK_FILE} row 2`));
});

test('Q12. a reference answer with no letter in it is not judged, and a judgment stored for it is not counted', async (t) => {
  const numbersOnly = question('l2', 'list', { answer: '8.1, 8.2, 8.3' });
  const questions = [question('f1', 'factual'), numbersOnly];
  const records = questions.map((q) => record(q.qid, response({ labelAnswer: 'answered', reply: 'Invented reply. [1]' })));

  // Not asked of the judge.
  assert.deepEqual(toJudge(questions, records).map((item) => item.question.qid), ['f1']);
  const dir = await folder(t);
  assert.equal(await prepareJudging(dir, 'completeness', questions, records, false), 1);

  // A judgment stored before (an incorrect, from a judge that found no fact to grade against) is ignored, not deleted.
  const judgments: Judgment[] = [
    { qid: 'f1', ok: true, verdict: 'correct', reason: 'Invented.' },
    { qid: 'l2', ok: true, verdict: 'incorrect', reason: 'Invented.' },
  ];
  const scores = scoreRun({ questions, records, sections: new Map(), judgments, personVerdicts: null });
  assert.equal(scores.correctness?.judged, 1);
  assert.equal(scores.correctness?.leftOut, 1);
  assert.deepEqual([scores.correctness?.all.incorrect.numerator, scores.correctness?.all.correct.denominator], [0, 1]);
  assert.equal(scores.perQuestion.l2?.judged_correct, undefined);
  assert.ok(formatScores(scores).some((line) => line.includes('left out of judging: 1 answered questions whose reference answer holds no letter')));
  assert.equal(judgments.length, 2);
});
