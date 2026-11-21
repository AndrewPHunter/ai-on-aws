// C6. The display decisions of the inquiry page, as pure functions of client/web/src/format.ts: the words for
// each label_answer value, a label's date written for a person, and an 8-digit date that is not a real date.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LABEL_ANSWERS } from '../../shared/agent-contract.ts';
import { labelAnswerText, labelDate, labelLinkText } from '../web/src/format.ts';

test('C6. each label_answer value has its own plain words', () => {
  assert.deepEqual(
    LABEL_ANSWERS.map((answer) => [answer, labelAnswerText(answer)]),
    [
      ['answered', 'Answered from the label.'],
      ['no_label', 'No label for this drug.'],
      ['label_does_not_answer', 'The label does not answer this.'],
      ['not_a_label_question', 'Not a question about a label.'],
    ],
  );
});

test('C6. a real date is written for a person, the same in every locale', () => {
  assert.equal(labelDate('20260130'), '30 January 2026');
  assert.equal(labelDate('20240229'), '29 February 2024');
  assert.equal(labelDate('19991201'), '1 December 1999');
});

test('C6. an 8-digit date that is not a real date is shown as its digits, never as Invalid Date', () => {
  for (const impossible of ['20260230', '20230229', '20261301', '20260001', '20260100', '20260132']) {
    assert.equal(labelDate(impossible), impossible);
  }
});

test('C6. a link to the label says which version and where it goes', () => {
  assert.equal(
    labelLinkText('https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=x&version=3', 3),
    'Version 3 of the label, at dailymed.nlm.nih.gov',
  );
});
