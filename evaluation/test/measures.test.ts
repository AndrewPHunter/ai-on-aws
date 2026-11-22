// The invariants of the figures and the sample ("Always true" 10 and 11 in docs/architecture/evaluation.md), on
// plain values: the scoring and the draw are pure functions.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { drawSample } from '../src/sample.ts';
import { scoreRun } from '../src/score.ts';
import type { Share } from '../src/stats.ts';
import { formatScores } from '../src/table.ts';
import { question, record, response } from './support.ts';

test('evaluation 10. every share is reported with its count and its 95% interval', () => {
  // 10 refusal questions, 8 declined; 2 answerable questions, answered and judged under both rubrics.
  const refusals = Array.from({ length: 10 }, (_, at) => question(`r${at}`, 'refusal'));
  const answerable = [question('a0', 'factual'), question('a1', 'numeric', { answer: 'Invented 12 mg.' })];
  const records = [
    ...refusals.map((q, at) => record(q.qid, response({ labelAnswer: at < 8 ? 'label_does_not_answer' : 'answered' }))),
    ...answerable.map((q) => record(q.qid, response({ labelAnswer: 'answered', reply: 'Invented 12 mg. [1]' }))),
  ];
  const scores = scoreRun({
    questions: [...refusals, ...answerable],
    records,
    sections: new Map(),
    judgments: [{ qid: 'a0', ok: true, verdict: 'correct', reason: 'Invented.' }],
    personVerdicts: null,
    answersJudgments: [{ qid: 'a1', ok: true, answers: 'yes', contradicts: false, coverage: 'all', reason: 'Invented.' }],
    overlap: new Map([['a0', 0.5], ['a1', 0.8]]),
  });

  const shares: Share[] = [];
  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    if ('numerator' in value && 'denominator' in value) shares.push(value as Share);
    else Object.values(value).forEach(walk);
  };
  walk(scores);
  assert.ok(shares.length > 20, `${shares.length} shares`);
  for (const share of shares) {
    assert.ok(Number.isInteger(share.numerator) && Number.isInteger(share.denominator));
    if (share.denominator > 0) assert.ok(share.low !== null && share.high !== null && share.share !== null && share.low <= share.share && share.share <= share.high);
  }
  const declined = scores.declining.refusalDeclined;
  assert.deepEqual([declined.numerator, declined.denominator, declined.low?.toFixed(4), declined.high?.toFixed(4)], [8, 10, '0.4902', '0.9433']);
  assert.ok(formatScores(scores).some((line) => line.includes('8 of 10 = 80.0% [49.0%, 94.3%]')));
});

test('evaluation 11. the same benchmark file, manifest and settings give the same sample', () => {
  const sets = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b2'];
  const benchmark = (['refusal', 'factual', 'multihop', 'numeric', 'list'] as const).flatMap((type) =>
    Array.from({ length: 8 }, (_, at) => question(`${type}-${at}`, type, { set_id: sets[at % 2] ?? '' })),
  );
  const settings = { seed: 7, strata: { refusal: 3, factual: 4, multihop: 2, numeric: 2, list: 2 } };
  const draw = (questions: typeof benchmark) => drawSample(questions, new Set(sets), settings).map((q) => q.qid);

  const first = draw(benchmark);
  assert.equal(first.length, 13);
  assert.deepEqual(draw(benchmark), first);
  assert.deepEqual(draw([...benchmark].reverse()), first);
});
