// Q07 to Q09. Each scoring measure on small synthetic responses built for it; the Wilson interval for known cases and
// the too-few mark; compare's four counts and the sign test for a known table, and runs on different samples refused.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCommand } from '../src/cli.ts';
import { compareScores } from '../src/compare.ts';
import { scoreRun } from '../src/score.ts';
import { formatScores } from '../src/table.ts';
import type { ScoreInput, Section } from '../src/score.ts';
import { signTest, wilson } from '../src/stats.ts';
import { SET_B, folder, io, question, record, response } from './support.ts';

const SECTIONS = new Map<string, Section>([
  ['p-dose', { number: '2.1', title: '2.1 Invented Dosing' }],
  ['p-warn', { number: '5.1', title: '5.1 Invented Warning' }],
  ['p-high', { number: null, title: 'Invented Dosing Highlights' }],
]);

const score = (input: Partial<ScoreInput>) => scoreRun({ questions: [], records: [], sections: SECTIONS, judgments: null, personVerdicts: null, ...input });

test('Q07. declining: refusal questions declined, answerable answered, and the share of the declined that were refusal', () => {
  const questions = [question('r1', 'refusal'), question('r2', 'refusal'), question('r3', 'refusal'), question('f1', 'factual'), question('f2', 'factual')];
  const records = [
    record('r1', response({ labelAnswer: 'label_does_not_answer' })),
    record('r2', response({ labelAnswer: 'no_label' })),
    record('r3', response({ labelAnswer: 'answered' })),
    record('f1', response({ labelAnswer: 'answered' })),
    record('f2', response({ labelAnswer: 'label_does_not_answer' })),
  ];
  const scores = score({ questions, records });
  assert.deepEqual([scores.declining.refusalDeclined.numerator, scores.declining.refusalDeclined.denominator], [2, 3]);
  assert.deepEqual([scores.declining.answerableAnswered.numerator, scores.declining.answerableAnswered.denominator], [1, 2]);
  assert.deepEqual([scores.declining.declinedThatWereRefusal.numerator, scores.declining.declinedThatWereRefusal.denominator], [2, 3]);
  assert.deepEqual(scores.labelAnswers, { answered: 2, label_does_not_answer: 2, no_label: 1 });
  assert.equal(scores.perQuestion.r3?.declined_rightly, false);
  assert.equal(scores.perQuestion.f1?.declined_rightly, true);
});

test('Q07. outcomes count completed, stopped, failed and call failures', () => {
  const questions = ['a', 'b', 'c', 'd'].map((qid) => question(qid, 'factual'));
  const records = [record('a', response({ labelAnswer: 'answered' })), record('b', response({ outcome: 'stopped' })), record('c', response({ outcome: 'failed' })), record('d', null)];
  assert.deepEqual(score({ questions, records }).outcomes, { completed: 1, stopped: 1, failed: 1, callFailures: 1 });
});

test('Q07. why runs stopped: each distinct stop reason of stopped and failed runs, with its count', () => {
  const stopped = (reason: string) => ({ ...response({ outcome: 'stopped' }), stop_reason: reason });
  const questions = ['a', 'b', 'c', 'd', 'e'].map((qid) => question(qid, 'factual'));
  const records = [
    record('a', stopped('The answer did not pass the checks after 2 corrections, and was not returned.')),
    record('b', stopped('The answer did not pass the checks after 2 corrections, and was not returned.')),
    record('c', stopped('The run reached its limit of 8 turns with the model.')),
    record('d', { ...response({ outcome: 'failed' }), stop_reason: 'The model could not be reached.' }),
    record('e', response({ labelAnswer: 'answered' })),
  ];
  const scores = score({ questions, records });
  assert.deepEqual(scores.stopReasons, [
    { outcome: 'stopped', reason: 'The answer did not pass the checks after 2 corrections, and was not returned.', count: 2 },
    { outcome: 'failed', reason: 'The model could not be reached.', count: 1 },
    { outcome: 'stopped', reason: 'The run reached its limit of 8 turns with the model.', count: 1 },
  ]);
  const table = formatScores(scores);
  assert.ok(table.includes('  stopped 2: The answer did not pass the checks after 2 corrections, and was not returned.'));
  assert.ok(table.includes('  failed 1: The model could not be reached.'));
});

test('Q07. right label: of the answered, every citation from the question\'s label', () => {
  const questions = ['a', 'b', 'c'].map((qid) => question(qid, 'factual'));
  const records = [
    record('a', response({ labelAnswer: 'answered', citations: [{ passage: 'p-dose' }, { passage: 'p-warn' }] })),
    record('b', response({ labelAnswer: 'answered', citations: [{ passage: 'p-dose' }, { passage: 'p-x', set_id: SET_B }] })),
    record('c', response({ labelAnswer: 'answered', citations: [] })),
  ];
  const right = score({ questions, records }).rightLabel;
  assert.deepEqual([right.numerator, right.denominator], [1, 3]);
});

test('Q07. citations by section, with the shared rule: precision over cited sections, recall over references', () => {
  const questions = [
    question('a', 'factual', { references: ['2.1 Invented Dosing', '5.1 Something Else'] }),
    question('b', 'factual', { references: ['invented dosing highlights'] }),
  ];
  const records = [
    // a cites 2.1 (matches by number) and 5.1 (matches by number too); a third passage has no known section.
    record('a', response({ labelAnswer: 'answered', citations: [{ passage: 'p-dose' }, { passage: 'p-warn' }, { passage: 'p-unknown' }] })),
    // b cites the Highlights passage, matched by title ignoring case, twice (counted once).
    record('b', response({ labelAnswer: 'answered', citations: [{ passage: 'p-high' }, { passage: 'p-high' }, { passage: 'p-bare' }] })),
  ];
  // p-bare's chunk has neither a section number nor a title.
  const scores = score({ questions, records, sections: new Map([...SECTIONS, ['p-bare', { number: null, title: null }]]) });
  assert.deepEqual([scores.citations.precision.numerator, scores.citations.precision.denominator], [3, 5]);
  assert.deepEqual([scores.citations.recall.numerator, scores.citations.recall.denominator], [3, 3]);
  // Of the 5 cited passages the measures read, 2 have nothing to match on: p-unknown (in no chunk) and p-bare.
  assert.deepEqual([scores.citations.citedPassages, scores.citations.citedWithoutSection], [5, 2]);
  assert.ok(formatScores(scores).includes('  of the 5 cited passages above, 2 have neither a section number nor a title to match on (or are in no chunk): each counts as not matching, and cites no reference'));
});

test('Q07. retrieval: a referenced section shown in any search, and in the first', () => {
  const questions = ['a', 'b', 'c', 'r'].map((qid) => question(qid, qid === 'r' ? 'refusal' : 'factual'));
  const records = [
    record('a', response({ searches: [{ hits: [{ passage: 'p-dose', shown: true }] }] })),
    record('b', response({ searches: [{ hits: [{ passage: 'p-dose', shown: false }, { passage: 'p-warn', shown: true }] }, { hits: [{ passage: 'p-dose', shown: true }] }] })),
    record('c', response({ searches: [{ hits: [{ passage: 'p-warn', shown: true }] }] })),
    record('r', response({ searches: [{ hits: [{ passage: 'p-dose', shown: true }] }] })),
  ];
  const scores = score({ questions, records });
  assert.deepEqual([scores.retrieval.anySearch.numerator, scores.retrieval.anySearch.denominator], [2, 3]);
  assert.deepEqual([scores.retrieval.firstSearch.numerator, scores.retrieval.firstSearch.denominator], [1, 3]);
});

test('Q07. numbers: every number of the benchmark answer in the reply, with the expert\'s normalisation', () => {
  const questions = [
    question('a', 'numeric', { answer: 'Take 1,200 mg twice a day for 7 days.' }),
    question('b', 'numeric', { answer: 'Take 600 mg.' }),
    question('c', 'numeric', { answer: 'No number here.' }),
  ];
  const records = [
    record('a', response({ labelAnswer: 'answered', reply: 'Take 1200 mg [1] twice a day for 7 days.' })),
    record('b', response({ labelAnswer: 'answered', reply: 'Take 60 mg.' })),
    record('c', response({ labelAnswer: 'answered', reply: 'Invented.' })),
  ];
  const numbers = score({ questions, records }).numbers;
  assert.deepEqual([numbers.numerator, numbers.denominator], [1, 2]);
});

test('Q07. effort: searches, corrections, seconds and tokens, median and 95th percentile', () => {
  const questions = ['a', 'b', 'c'].map((qid) => question(qid, 'factual'));
  const records = [
    record('a', response({ searches: [{ hits: [] }], corrections: 0, tokens: [{ input: 100, output: 10 }] }), { duration_ms: 1000 }),
    record('b', response({ searches: [{ hits: [] }, { hits: [] }], corrections: 1, tokens: [{ input: 100, output: 10 }, { input: 200, output: 20 }] }), { duration_ms: 3000 }),
    record('c', response({ searches: [{ hits: [] }, { hits: [] }, { hits: [] }], corrections: 2, tokens: [{ input: 50, output: 5 }] }), { duration_ms: 2000 }),
  ];
  const effort = score({ questions, records }).effort;
  assert.deepEqual([effort.searches.median, effort.searches.p95], [2, 3]);
  assert.deepEqual([effort.corrections.median, effort.corrections.p95], [1, 2]);
  assert.deepEqual([effort.seconds.median, effort.seconds.p95], [2, 3]);
  assert.deepEqual([effort.inputTokens.median, effort.inputTokens.p95], [100, 300]);
  assert.deepEqual([effort.outputTokens.median, effort.outputTokens.p95], [10, 30]);
});

test('Q08. the Wilson interval for known cases, and the too-few mark', () => {
  const zero = wilson(0, 10);
  assert.equal(zero.low, 0);
  assert.ok(Math.abs((zero.high ?? 0) - 0.27753) < 1e-4);
  const all = wilson(10, 10);
  assert.ok(Math.abs((all.low ?? 0) - 0.72247) < 1e-4);
  assert.equal(all.high, 1);
  const half = wilson(5, 10);
  assert.ok(Math.abs((half.low ?? 0) - 0.23659) < 1e-4);
  assert.ok(Math.abs((half.high ?? 0) - 0.76341) < 1e-4);
  assert.equal(half.tooFew, true);
  assert.equal(wilson(10, 20).tooFew, false);
  assert.deepEqual(wilson(0, 0), { numerator: 0, denominator: 0, share: null, low: null, high: null, tooFew: true });
});

test('Q09. compare: the four counts and the sign test for a known table', () => {
  const marks = (values: boolean[]) => Object.fromEntries(values.map((value, at) => [`q${at}`, { right_label: value }]));
  // A: 1 1 1 1 0 0 0 1 1 1   B: 1 1 0 0 0 1 0 0 0 0  -> both 2, only A 5, only B 1, neither 2
  const a = marks([true, true, true, true, false, false, false, true, true, true]);
  const b = marks([true, true, false, false, false, true, false, false, false, false]);
  const row = compareScores({ perQuestion: a }, { perQuestion: b }).find((r) => r.measure === 'right_label');
  assert.deepEqual([row?.both, row?.onlyA, row?.onlyB, row?.neither], [2, 5, 1, 2]);
  // Two-sided exact: 2 * (C(6,0) + C(6,1)) / 64 = 14 / 64.
  assert.ok(Math.abs((row?.signTestP ?? 0) - 14 / 64) < 1e-12);
  assert.equal(signTest(0, 0), 1);
  assert.equal(signTest(3, 3), 1);
});

test('Q09. runs with different samples are refused', async (t) => {
  const dir = await folder(t);
  for (const [name, sample] of [['a', 'a'.repeat(64)], ['b', 'b'.repeat(64)]] as const) {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, 'run.json'), JSON.stringify({ sample_sha256: sample, agent_id: 'expert', models: [], strategies: [], started_at: '', ended_at: '' }));
    await writeFile(join(dir, name, 'scores.json'), JSON.stringify({ perQuestion: {} }));
  }
  const captured = io();
  assert.equal(await runCommand(['compare', '--run-a', join(dir, 'a'), '--run-b', join(dir, 'b')], captured.io), 2);
  assert.match(captured.err.join('\n'), /were made on different samples/);
});
