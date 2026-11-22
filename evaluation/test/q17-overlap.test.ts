// Q17. Wording overlap: the content-word rule on synthetic text (stop words, short words, the drug's name, case); the
// thirds and their cut points; the retrieval measures and "answers the question, uncontradicted" split by third.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contentWords, thirdCuts, thirdOf, wordingOverlap } from '../src/overlap.ts';
import type { AnswersJudgment } from '../src/rubric.ts';
import { scoreRun } from '../src/score.ts';
import type { Section } from '../src/score.ts';
import { formatScores } from '../src/table.ts';
import { question, record, response } from './support.ts';

test('Q17. content words: lower-cased, distinct, three letters or more, no stop word, no word of the drug\'s name', () => {
  // "What", "the", "for" and "should" are stop words; "of", "a", "is" and "mg" are short; "Zylo" and "Forte" are the
  // name's; "100" has no letters, and "Child's" is "child" and "s".
  assert.deepEqual(contentWords('What is the DOSE of Zylo Forte for a Child\'s weight, and should the dose change? Dose 100 mg.', 'Zylo forte'), ['dose', 'child', 'weight', 'change']);
  assert.deepEqual(contentWords('Is it OK?', 'Zylo'), []);

  // Three content words (dose, child, renal), two of them in the context, whatever their case there.
  assert.equal(wordingOverlap('What dose for a child with renal?', 'Zylo', 'The DOSE in a CHILD is 5 mg.'), 2 / 3);
  // The drug's name is not counted even though the context holds it.
  assert.equal(wordingOverlap('Zylo dose?', 'Zylo', 'Zylo dose'), 1);
  assert.equal(wordingOverlap('Zylo dose?', 'Zylo', 'Zylo only'), 0);
  // No content words: no overlap.
  assert.equal(wordingOverlap('Is it Zylo?', 'Zylo', 'Zylo'), null);
});

test('Q17. thirds: cut at the sample\'s own values, a tie at a cut falling to the lower third', () => {
  const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.5, 0.6, 0.8, 0.9];
  // Nearest rank: the 33⅓th percentile of 9 values is the 3rd (0.3), the 66⅔th the 6th (0.5).
  assert.deepEqual(thirdCuts(values), { low: 0.3, high: 0.5 });
  const cuts = { low: 0.3, high: 0.5 };
  assert.deepEqual(values.map((value) => thirdOf(value, cuts)), [1, 1, 1, 2, 2, 2, 3, 3, 3]);
  assert.equal(thirdCuts([]), null);
});

test('Q17. score.sh splits the two retrieval measures and "answers the question, uncontradicted" into the thirds', () => {
  const sections = new Map<string, Section>([['p-dose', { number: '2.1', title: '2.1 Invented Dosing' }]]);
  const hit = { searches: [{ hits: [{ passage: 'p-dose', shown: true }] }] };
  const miss = { searches: [{ hits: [{ passage: 'p-other', shown: true }] }] };
  const questions = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((qid) => question(qid, 'factual'));
  const allQuestions = [...questions, question('r', 'refusal')];
  // a, b low; c, d middle; e, f high; g has no content words.
  const overlap = new Map<string, number | null>([['a', 0.1], ['b', 0.2], ['c', 0.5], ['d', 0.6], ['e', 0.9], ['f', 1], ['g', null]]);
  const records = [
    record('a', response({ labelAnswer: 'answered', ...miss })),
    record('b', response({ labelAnswer: 'answered', ...hit })),
    record('c', response({ labelAnswer: 'answered', ...hit })),
    record('d', response({ labelAnswer: 'answered', ...hit })),
    record('e', response({ labelAnswer: 'answered', ...hit })),
    record('f', response({ labelAnswer: 'answered', ...hit })),
    record('g', response({ labelAnswer: 'answered', ...miss })),
    record('r', response({ labelAnswer: 'label_does_not_answer' })),
  ];
  const yes = (qid: string): AnswersJudgment => ({ qid, ok: true, answers: 'yes', contradicts: false, coverage: 'all', reason: 'Invented.' });
  const no = (qid: string): AnswersJudgment => ({ qid, ok: true, answers: 'no', contradicts: false, coverage: 'none', reason: 'Invented.' });
  const answersJudgments = [no('a'), no('b'), yes('c'), no('d'), yes('e'), yes('f')];

  const scores = scoreRun({ questions: allQuestions, records, sections, judgments: null, personVerdicts: null, answersJudgments, overlap });
  const o = scores.overlap;
  assert.ok(o !== null);
  assert.deepEqual([o.questions, o.withoutContentWords], [6, 1]);
  // Six values: nearest rank gives the 2nd (0.2) and the 4th (0.6).
  assert.deepEqual(o.cuts, { low: 0.2, high: 0.6 });
  assert.deepEqual(o.byQid.c, { overlap: 0.5, third: 2 });
  assert.deepEqual(o.byQid.g, { overlap: null, third: null });
  assert.equal(o.byQid.r, undefined);
  const counts = o.thirds.map((third) => [
    third.questions,
    third.measures.retrieved_first.numerator,
    third.measures.retrieved_first.denominator,
    third.measures.retrieved_any.numerator,
    third.measures.answers_uncontradicted.numerator,
    third.measures.answers_uncontradicted.denominator,
  ]);
  assert.deepEqual(counts, [
    [2, 1, 2, 1, 0, 2],
    [2, 2, 2, 2, 1, 2],
    [2, 2, 2, 2, 2, 2],
  ]);
  const table = formatScores(scores);
  assert.ok(table.includes('  thirds cut at 20.0% and 60.0% (the sample\'s own values; a tie at a cut falls to the lower third)'));
  assert.ok(table.includes('  lowest third (0% to 20.0%, 2 questions):'));
  assert.ok(table.some((line) => line.includes('6 questions, median 50.0%; 1 with no content words, in no third')));
});
