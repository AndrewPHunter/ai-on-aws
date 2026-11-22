// The label expert. Each run uses the scripted model stand-in, the real retrieval service in-process over the
// search stand-in, and real tokens from the stand-in issuer. Every response is checked against the contract
// schema (runExpert). Every label name and passage here is invented.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Caller } from '../../shared/access-token.ts';
import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { InvocationResponse } from '../../shared/agent-contract.ts';
import { indexNotFound } from '../../knowledge/test/support/search-standin.ts';
import { createContractServer } from '../src/contract/server.ts';
import {
  ANSWER_CORRECTION_CLOSING,
  numberForm,
  numbersIn,
  numbersWithUnits,
  quoteFoundIn,
  quoteForm,
  unitIn,
  withoutFootnoteMarks,
} from '../src/expert/checks.ts';
import { SYSTEM_PROMPT, userTurn } from '../src/expert/prompt.ts';
import {
  RETRIEVAL_COULD_NOT_CHECK,
  RETRIEVAL_LACKS_TOOLS,
  RETRIEVAL_REFUSED_TOKEN,
  RETRIEVAL_UNREACHABLE,
  SEARCH_FAILURES,
  UNREADABLE_ERROR,
  retrievalDidNotAnswerWithin,
  unexpectedAnswer,
  unknownError,
} from '../src/expert/retrieval.ts';
import { expertSettingsFrom } from '../src/expert/serve.ts';
import { EXPERT_SETTINGS } from '../src/expert/settings.ts';
import { CUT_OFF_AGAIN, RETRIEVAL_STRATEGY, answerNotPassed, endedWithoutFinalTool, handleQuestion } from '../src/expert/strands.ts';
import {
  AGENT_START,
  agentClock,
  call,
  deadUrl,
  item,
  kinds,
  listen,
  message,
  modelRequest,
  modelSteps,
  onlyItem,
  prop,
  startScriptedModel,
  stop,
  text,
  toolCalls,
  toolSteps,
} from './helpers.ts';
import type { ScriptedAnswer, ScriptedModel } from './helpers.ts';
import {
  EXAMPLAMAB,
  EXPERT_IDENTITY,
  EXPERT_TEST_LIMITS,
  INVENTORIN,
  chunk,
  retrievalSteps,
  runExpert,
  sized,
  startExpertTokens,
  startOddRetrieval,
  startRetrieval,
  unreachableIdentityCheck,
} from './expert-helpers.ts';
import type { EngineScript, ExpertRunOptions, ExpertTokens, OddAnswers, Retrieval } from './expert-helpers.ts';

const QUESTION = message('msg-1', 'What is the usual dose of Examplamab?');

// The passages most tests search.
const DOSE = chunk(EXAMPLAMAB, 1, 'Examplamab is given at 1,200 mg once a day. Take each dose with food.');
const KIDNEY = chunk(EXAMPLAMAB, 2, 'Lower the dose to 600 mg in patients with reduced kidney function[^1].');
const HEADACHE = chunk(EXAMPLAMAB, 3, 'About 12 percent of patients had a headache in the first week.', {
  part: 'highlights',
  path: [],
  title: 'Adverse reactions',
});

const find = (drug: string): ReturnType<typeof call> => call('find_labels', { drug });
const search = (setId: string, query: string): ReturnType<typeof call> => call('search_label', { set_id: setId, query });
const statement = (statementText: string, passages: string[], quote: string): Record<string, unknown> => ({ text: statementText, passages, quote });
const answer = (...statements: Record<string, unknown>[]): ReturnType<typeof call> => call('answer', { statements });
const cannot = (reason: string): ReturnType<typeof call> => call('cannot_answer', { reason });

type Rig = { model: ScriptedModel; retrieval: Retrieval; tokens: ExpertTokens; caller: Caller; options: ExpertRunOptions };

async function rig(t: TestContext, answers: ScriptedAnswer[], script: EngineScript = {}): Promise<Rig> {
  const tokens = await startExpertTokens(t);
  const retrieval = await startRetrieval(t, tokens, script);
  const model = await startScriptedModel(t, answers);
  const caller = await tokens.caller();
  return { model, retrieval, tokens, caller, options: { model, mcpUrl: retrieval.mcpUrl, caller } };
}

// What the model was last told, as Strands sent it.
function lastTold(model: ScriptedModel, request: number): string {
  const { results } = modelRequest(model, request);
  return results[results.length - 1]?.told ?? '';
}

function assertNoMoreRequests(model: ScriptedModel, expected: number): void {
  assert.equal(model.requests.length, expected, 'requests to the model');
  assert.equal(model.unexpectedRequests(), 0, 'requests past the script');
}

test('E01. find, search and an accepted answer: completed, answered, a reply with [1] and [2], full citations, steps in order', async (t) => {
  const r = await rig(
    t,
    [
      toolCalls(find('Examplamab')),
      toolCalls(search(EXAMPLAMAB.setId, 'usual dose')),
      toolCalls(
        answer(
          statement('Examplamab is given at 1,200 mg once a day.', ['P1'], 'given at 1,200 mg once a day'),
          statement('About 12 percent of patients had a headache.', ['P2'], 'About 12 percent of patients had a headache'),
        ),
      ),
    ],
    { searches: [[DOSE, HEADACHE]] },
  );

  const response = await runExpert(r.options, QUESTION);

  assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
  assert.equal(response.stop_reason, null);
  assert.equal(response.label_answer, 'answered');
  assert.equal(response.reply, 'Examplamab is given at 1,200 mg once a day. [1]\n\nAbout 12 percent of patients had a headache. [2]');
  assert.deepEqual(response.citations, [
    {
      drug: 'Examplamab',
      section: '2 DOSAGE AND ADMINISTRATION > 2.1 Invented section 1',
      quote: 'given at 1,200 mg once a day',
      set_id: EXAMPLAMAB.setId,
      version: 3,
      effective_date: '20240102',
      source: EXAMPLAMAB.source,
      passage: `${EXAMPLAMAB.setId}/3/sec-1/body/1`,
    },
    {
      drug: 'Examplamab',
      section: 'Highlights > Adverse reactions',
      quote: 'About 12 percent of patients had a headache',
      set_id: EXAMPLAMAB.setId,
      version: 3,
      effective_date: '20240102',
      source: EXAMPLAMAB.source,
      passage: `${EXAMPLAMAB.setId}/3/sec-3/highlights/1`,
    },
  ]);
  assert.deepEqual(kinds(response), ['model', 'tool', 'model', 'retrieval', 'model']);
  const retrieval = onlyItem(retrievalSteps(response), 'retrieval step');
  assert.equal(retrieval.query, 'usual dose');
  assert.equal(retrieval.strategy, RETRIEVAL_STRATEGY);
  assert.deepEqual(
    retrieval.hits.map((hit) => [hit.drug, hit.section, hit.score, hit.excerpt, hit.passage, hit.handle, hit.shown]),
    [
      ['Examplamab', '2 DOSAGE AND ADMINISTRATION > 2.1 Invented section 1', 10, prop(DOSE, 'text'), `${EXAMPLAMAB.setId}/3/sec-1/body/1`, 'P1', true],
      ['Examplamab', 'Highlights > Adverse reactions', 9, prop(HEADACHE, 'text'), `${EXAMPLAMAB.setId}/3/sec-3/highlights/1`, 'P2', true],
    ],
  );
  // The search asked for five passages, within the label found.
  const sent = onlyItem(r.retrieval.searchRequests(), 'search request');
  assert.equal(prop(sent.body, 'size'), 5);
  // The model was given the prompt and the message's text only; it was shown handles, names, section, part, type
  // and text.
  const first = modelRequest(r.model, 0);
  assert.equal(first.system, SYSTEM_PROMPT);
  assert.deepEqual(first.user, [userTurn(QUESTION)]);
  assert.equal(item(first.user, 0, 'user message'), `<message>\n${QUESTION.text}\n</message>`);
  assert.equal(JSON.stringify(r.model.requests).includes(QUESTION.sender), false);
  assert.deepEqual(first.tools, ['find_labels', 'search_label', 'answer', 'cannot_answer']);
  const shown = lastTold(r.model, 2);
  assert.ok(shown.includes(`P1 | Examplamab | 2 DOSAGE AND ADMINISTRATION > 2.1 Invented section 1 | body, text\n${String(prop(DOSE, 'text'))}`), shown);
  assert.ok(shown.includes('P2 | Examplamab | Highlights > Adverse reactions | highlights, text'), shown);
  // Once the answer was accepted, the model was not asked again.
  assertNoMoreRequests(r.model, 3);
});

test('E02. a handle never shown is told by statement number; the corrected answer is accepted; the refusal is in the steps', async (t) => {
  const r = await rig(
    t,
    [
      toolCalls(find('Examplamab')),
      toolCalls(search(EXAMPLAMAB.setId, 'dose')),
      toolCalls(answer(statement('Examplamab is given at 1,200 mg once a day.', ['P5'], 'given at 1,200 mg once a day'))),
      toolCalls(answer(statement('Examplamab is given at 1,200 mg once a day.', ['P1'], 'given at 1,200 mg once a day'))),
    ],
    { searches: [[DOSE]] },
  );

  const response = await runExpert(r.options, QUESTION);

  assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
  assert.equal(response.label_answer, 'answered');
  const told = lastTold(r.model, 3);
  assert.ok(told.includes('Statement 1: it cites P5, which is not a passage shown to you.'), told);
  assert.ok(told.endsWith(ANSWER_CORRECTION_CLOSING), told);
  const refusal = onlyItem(toolSteps(response).filter((step) => step.tool === 'answer'), 'answer step');
  assert.equal(refusal.is_error, true);
  assert.equal(prop(refusal.result, 'error'), 'answer_not_accepted');
  assert.deepEqual(kinds(response), ['model', 'tool', 'model', 'retrieval', 'model', 'tool', 'model']);
  assertNoMoreRequests(r.model, 4);
});

test('E03. quotes: matching nowhere, diverging part way, in an uncited passage, and 14 characters are told, each so it can be corrected; white space, case and a footnote mark are forgiven', async (t) => {
  const kidney = 'The dose is lowered for reduced kidney function.';
  const dose = 'Examplamab is given at 1,200 mg once a day.';
  const r = await rig(
    t,
    [
      toolCalls(find('Examplamab')),
      toolCalls(search(EXAMPLAMAB.setId, 'kidney')),
      toolCalls(
        answer(
          statement(kidney, ['P1'], 'Reduce the dose for kidney problems'),
          statement(kidney, ['P1'], 'Lower the dose ... kidney function'),
          statement(dose, ['P1'], 'given at 1,200 mg once a day'),
        ),
      ),
      toolCalls(answer(statement(kidney, ['P1'], 'Lower the dose'))),
      toolCalls(
        answer(
          statement(kidney, ['P1'], 'LOWER the  dose to 600 mg in patients with reduced\nkidney function.'),
          statement(dose, ['P1', 'P2'], 'given at 1,200 mg once a day'),
        ),
      ),
    ],
    { searches: [[KIDNEY, DOSE]] },
  );

  const response = await runExpert(r.options, QUESTION);

  const first = lastTold(r.model, 3);
  // Matching nowhere from its first word.
  assert.ok(first.includes('Statement 1: its quote is not in P1 word for word. Its first words are not in that passage.'), first);
  // Diverging part way: the matching start, in the model's own words, and nothing of the passage after it.
  assert.ok(
    first.includes('Statement 2: its quote is not in P1 word for word. It matches as far as "Lower the dose" and then the passage differs. A quote is one continuous span'),
    first,
  );
  assert.equal(first.includes('to 600 mg in patients'), false, first);
  // In a passage shown and not cited.
  assert.ok(first.includes('Statement 3: its quote is in P2, which the statement does not cite. Cite P2 as well, or quote from a passage it cites.'), first);
  assert.ok(first.endsWith(ANSWER_CORRECTION_CLOSING), first);
  const second = lastTold(r.model, 4);
  assert.ok(second.includes('Statement 1: its quote is 14 characters; a quote must be 15 to 600.'), second);
  assert.ok(second.endsWith(ANSWER_CORRECTION_CLOSING), second);
  // Citing P2 as well is accepted, and the citation is of the passage the quote is in.
  assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
  assert.equal(response.label_answer, 'answered');
  // The quote is returned as the model wrote it.
  assert.equal(item(response.citations, 0, 'citation').quote, 'LOWER the  dose to 600 mg in patients with reduced\nkidney function.');
  assert.equal(item(response.citations, 1, 'citation').passage, `${EXAMPLAMAB.setId}/3/sec-1/body/1`);
  assertNoMoreRequests(r.model, 5);
});

test('E04. numbers: one not in the cited passage is told; 1,200 against 1200 is accepted; one only in an uncited passage is told', async (t) => {
  const dose = chunk(EXAMPLAMAB, 1, 'Examplamab is given at 1200 mg once a day. Take each dose with food.');
  const r = await rig(
    t,
    [
      toolCalls(find('Examplamab')),
      toolCalls(search(EXAMPLAMAB.setId, 'dose')),
      toolCalls(answer(statement('Examplamab is given at 1,300 mg once a day.', ['P1'], 'given at 1200 mg once a day'))),
      toolCalls(answer(statement('The dose is 600 mg once a day.', ['P1'], 'given at 1200 mg once a day'))),
      toolCalls(answer(statement('Examplamab is given at 1,200 mg once a day.', ['P1'], 'given at 1200 mg once a day'))),
    ],
    { searches: [[dose, KIDNEY]] },
  );

  const response = await runExpert(r.options, QUESTION);

  const first = lastTold(r.model, 3);
  assert.ok(first.includes('Statement 1: 1300 is not written in P1.'), first);
  // 600 is in P2, which the statement does not cite.
  const second = lastTold(r.model, 4);
  assert.ok(second.includes('Statement 1: 600 is not written in P1.'), second);
  assert.ok(first.endsWith(ANSWER_CORRECTION_CLOSING), first);
  assert.ok(second.endsWith(ANSWER_CORRECTION_CLOSING), second);
  assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
  assert.equal(response.reply, 'Examplamab is given at 1,200 mg once a day. [1]');
  assertNoMoreRequests(r.model, 5);
});

test('E05. units: mcg where the passage has only mg is told; % against percent is accepted', async (t) => {
  const dose = chunk(EXAMPLAMAB, 1, 'Examplamab is given at 1200 mg once a day. About 12 percent of patients had a headache.');
  const r = await rig(
    t,
    [
      toolCalls(find('Examplamab')),
      toolCalls(search(EXAMPLAMAB.setId, 'dose')),
      toolCalls(answer(statement('Examplamab is given at 1200 mcg once a day.', ['P1'], 'given at 1200 mg once a day'))),
      toolCalls(answer(statement('About 12% of patients had a headache.', ['P1'], 'About 12 percent of patients had a headache'))),
    ],
    { searches: [[dose]] },
  );

  const response = await runExpert(r.options, QUESTION);

  const first = lastTold(r.model, 3);
  assert.ok(first.includes('Statement 1: the unit mcg is not written in P1.'), first);
  assert.ok(first.endsWith(ANSWER_CORRECTION_CLOSING), first);
  assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
  assert.equal(response.reply, 'About 12% of patients had a headache. [1]');
  assertNoMoreRequests(r.model, 4);
});

test('E06. three answers that do not pass: stopped, its reason, nothing returned, and exactly two corrections told', async (t) => {
  const wrong = answer(statement('Examplamab is given at 1,300 mg once a day.', ['P1'], 'given at 1,200 mg once a day'));
  const r = await rig(t, [toolCalls(find('Examplamab')), toolCalls(search(EXAMPLAMAB.setId, 'dose')), toolCalls(wrong), toolCalls(wrong), toolCalls(wrong)], {
    searches: [[DOSE]],
  });

  const response = await runExpert(r.options, QUESTION);

  assert.equal(response.outcome, 'stopped');
  assert.equal(response.stop_reason, answerNotPassed(2));
  assert.equal(response.stop_reason, 'The answer did not pass the checks after 2 corrections, and was not returned.');
  assert.equal(response.reply, '');
  assert.deepEqual(response.citations, []);
  assert.equal(response.label_answer, undefined);
  // The last request carries everything the model was told in the run.
  const told = modelRequest(r.model, 4).results.filter((result) => result.told.includes('Not accepted:'));
  assert.equal(told.length, 2);
  assert.equal(toolSteps(response).filter((step) => step.tool === 'answer').length, 3);
  assertNoMoreRequests(r.model, 5);
});

test('E07. no_label is accepted after find_labels returned nothing, and the reply does not repeat the name searched; not when a label was found', async (t) => {
  await t.test('accepted', async (t) => {
    const r = await rig(t, [toolCalls(find('Nosuchamab')), toolCalls(cannot('no_label'))]);
    const response = await runExpert(r.options, message('msg-1', 'What is the dose of Nosuchamab?'));
    assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
    assert.equal(response.label_answer, 'no_label');
    assert.equal(response.reply, 'No approved label was found for the drug named in the message, so the question cannot be answered from a label.');
    // The name the model searched for is in the tool step, never in the reply.
    assert.equal(response.reply.includes('Nosuchamab'), false);
    assert.deepEqual(onlyItem(toolSteps(response), 'tool step').arguments, { drug: 'Nosuchamab' });
    assert.deepEqual(response.citations, []);
    assertNoMoreRequests(r.model, 2);
  });

  await t.test('told when a label was found', async (t) => {
    const r = await rig(t, [toolCalls(find('Examplamab')), toolCalls(cannot('no_label')), toolCalls(cannot('not_a_label_question'))]);
    const response = await runExpert(r.options, QUESTION);
    const told = lastTold(r.model, 2);
    assert.ok(told.includes('Reason "no_label" is not accepted: find_labels returned a label in this run.'), told);
    assert.equal(prop(item(toolSteps(response), 1, 'tool step').result, 'error'), 'answer_not_accepted');
    assert.equal(response.label_answer, 'not_a_label_question');
  });
});

test('E08. label_does_not_answer after a search names the label, version and date; without a search it is told', async (t) => {
  await t.test('accepted', async (t) => {
    const r = await rig(t, [toolCalls(find('Examplamab')), toolCalls(search(EXAMPLAMAB.setId, 'pregnancy')), toolCalls(cannot('label_does_not_answer'))], {
      searches: [[DOSE]],
    });
    const response = await runExpert(r.options, QUESTION);
    assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
    assert.equal(response.label_answer, 'label_does_not_answer');
    assert.equal(response.reply, 'The label searched, Examplamab (version 3, dated 2024-01-02), does not answer this question.');
    assert.deepEqual(response.citations, []);
  });

  await t.test('told without a search', async (t) => {
    const r = await rig(
      t,
      [toolCalls(find('Examplamab')), toolCalls(cannot('label_does_not_answer')), toolCalls(search(EXAMPLAMAB.setId, 'pregnancy')), toolCalls(cannot('label_does_not_answer'))],
      { searches: [[DOSE]] },
    );
    const response = await runExpert(r.options, QUESTION);
    const told = lastTold(r.model, 2);
    assert.ok(told.includes('Reason "label_does_not_answer" needs at least one search of a label in this run.'), told);
    assert.equal(response.label_answer, 'label_does_not_answer');
  });
});

test('E09. not_a_label_question as the first and only call: completed, its sentence, no tool or retrieval step', async (t) => {
  const r = await rig(t, [toolCalls(cannot('not_a_label_question'))]);

  const response = await runExpert(r.options, message('msg-1', 'My patient had a rash after taking Examplamab.'));

  assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
  assert.equal(response.label_answer, 'not_a_label_question');
  assert.equal(response.reply, 'The message does not ask what a drug label says, so it was not answered from the labels.');
  assert.deepEqual(kinds(response), ['model']);
  assert.equal(r.retrieval.standIn.received.length, 0);
  assertNoMoreRequests(r.model, 1);
});

test('E10. a search on a set id find_labels did not return is not made and is told; so is a fifth search', async (t) => {
  const again = search(EXAMPLAMAB.setId, 'dose');
  const r = await rig(
    t,
    [
      toolCalls(find('Examplamab')),
      toolCalls(search(INVENTORIN.setId, 'dose')),
      toolCalls(again, again, again, again),
      toolCalls(again),
      toolCalls(cannot('label_does_not_answer')),
    ],
    { searches: [[DOSE], [DOSE], [DOSE], [DOSE]] },
  );

  const response = await runExpert(r.options, QUESTION);

  assert.ok(lastTold(r.model, 2).includes('"error":"label_not_returned"'));
  assert.ok(lastTold(r.model, 4).includes('"error":"search_limit_reached"'));
  assert.equal(r.retrieval.searchRequests().length, 4);
  const refused = toolSteps(response).filter((step) => step.tool === 'search_label');
  assert.deepEqual(
    refused.map((step) => [prop(step.result, 'error'), step.is_error]),
    [
      ['label_not_returned', true],
      ['search_limit_reached', true],
    ],
  );
  assert.equal(retrievalSteps(response).length, 4);
  assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
});

test('E11. the reading allowance: shown best first while they fit, one that does not fit is named and cannot be cited, one shown before costs nothing', async (t) => {
  const p1 = chunk(EXAMPLAMAB, 1, sized('Examplamab is given at 1200 mg once a day.', 60));
  const p2 = chunk(EXAMPLAMAB, 2, sized('Lower the dose in kidney disease.', 80));
  const p3 = chunk(EXAMPLAMAB, 3, sized('Take with food.', 30));
  const p4 = chunk(EXAMPLAMAB, 4, sized('Store cold.', 10));
  const r = await rig(
    t,
    [
      toolCalls(find('Examplamab')),
      toolCalls(search(EXAMPLAMAB.setId, 'dose')),
      toolCalls(search(EXAMPLAMAB.setId, 'dose again')),
      toolCalls(answer(statement('Lower the dose in kidney disease.', ['P2'], 'Lower the dose in kidney disease'))),
      toolCalls(answer(statement('Examplamab is given at 1200 mg once a day.', ['P1'], 'given at 1200 mg once a day'))),
    ],
    { searches: [[p1, p2, p3], [p1, p4]] },
  );

  const response = await runExpert({ ...r.options, settings: { search: { readingAllowance: 100 } } }, QUESTION);

  const [firstSearch, secondSearch] = retrievalSteps(response);
  assert.deepEqual(firstSearch?.hits.map((hit) => [hit.handle, hit.shown]), [
    ['P1', true],
    ['P2', false],
    ['P3', true],
  ]);
  // P1 was shown before and cost nothing, so P4 fits in the 10 characters left.
  assert.deepEqual(secondSearch?.hits.map((hit) => [hit.handle, hit.shown]), [
    ['P1', true],
    ['P4', true],
  ]);
  const firstTold = lastTold(r.model, 2);
  assert.ok(firstTold.includes('Not shown: a passage from 2 DOSAGE AND ADMINISTRATION > 2.2 Invented section 2 (body, text), 80 characters, does not fit in the 40 characters left'), firstTold);
  assert.equal(firstTold.includes(String(prop(p2, 'text'))), false);
  const secondTold = lastTold(r.model, 3);
  assert.ok(secondTold.includes('P1 is shown above.'), secondTold);
  assert.equal(secondTold.includes(String(prop(p1, 'text'))), false);
  assert.ok(secondTold.includes(String(prop(p4, 'text'))));
  assert.ok(lastTold(r.model, 4).includes('Statement 1: it cites P2, which is not a passage shown to you.'));
  assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
});

test('E12. a find or search that could not be made, or an answer the agent cannot read, ends the run failed with its own sentence; the model is told nothing and not asked again', async (t) => {
  const cases: Array<{ name: string; reply: EngineScript['searches']; expire?: boolean; sentence: string }> = [
    { name: 'index not built', reply: [indexNotFound], sentence: SEARCH_FAILURES['index_not_built'] ?? '' },
    { name: 'engine unreachable', reply: ['drop'], sentence: SEARCH_FAILURES['search_unreachable'] ?? '' },
    { name: 'engine timed out', reply: ['hold'], expire: true, sentence: SEARCH_FAILURES['search_timed_out'] ?? '' },
    { name: 'unexpected answer', reply: [{ status: 200, body: { nothing: 'expected' } }], sentence: SEARCH_FAILURES['search_unexpected_answer'] ?? '' },
    { name: 'no answer within the tool limit', reply: ['hold'], sentence: retrievalDidNotAnswerWithin(EXPERT_TEST_LIMITS.toolMs) },
  ];
  for (const row of cases) {
    await t.test(row.name, async (t) => {
      const r = await rig(t, [toolCalls(find('Examplamab')), toolCalls(search(EXAMPLAMAB.setId, 'dose'))], { searches: row.reply });
      if (row.expire === true) r.retrieval.standIn.onHold(() => r.retrieval.expire());
      const response = await runExpert(r.options, QUESTION);
      assert.equal(response.outcome, 'failed');
      assert.equal(response.stop_reason, row.sentence);
      assert.notEqual(row.sentence, '');
      assert.equal(response.reply, '');
      assert.equal(response.label_answer, undefined);
      assert.equal(r.retrieval.searchRequests().length, 1, 'the search was not repeated');
      assertNoMoreRequests(r.model, 2);
    });
  }

  // find_labels failing ends the run the same way, before any search.
  await t.test('find_labels: index not built', async (t) => {
    const r = await rig(t, [toolCalls(find('Examplamab'))], { find: indexNotFound });
    const response = await runExpert(r.options, QUESTION);
    assert.equal(response.outcome, 'failed');
    assert.equal(response.stop_reason, SEARCH_FAILURES['index_not_built']);
    assert.equal(r.retrieval.searchRequests().length, 0);
    assertNoMoreRequests(r.model, 1);
  });

  // The real retrieval service cannot give these answers, so a labelled stand-in gives them (expert-helpers.ts).
  const odd: Array<{ name: string; answers: OddAnswers; turns: ScriptedAnswer[]; sentence: string }> = [
    {
      name: 'an error code in neither list',
      answers: { search: { content: [{ type: 'text', text: JSON.stringify({ error: 'reranker_unavailable', detail: 'Invented.' }) }], isError: true } },
      turns: [toolCalls(find('Examplamab')), toolCalls(search(EXAMPLAMAB.setId, 'dose'))],
      sentence: unknownError('reranker_unavailable'),
    },
    {
      name: 'an error of an unexpected shape',
      answers: { search: { content: [{ type: 'text', text: 'Something went wrong.' }], isError: true } },
      turns: [toolCalls(find('Examplamab')), toolCalls(search(EXAMPLAMAB.setId, 'dose'))],
      sentence: UNREADABLE_ERROR,
    },
    {
      name: 'find_labels: a success of an unexpected shape',
      answers: { find: { content: [{ type: 'text', text: JSON.stringify({ labels: 'none' }) }], isError: false } },
      turns: [toolCalls(find('Examplamab'))],
      sentence: unexpectedAnswer('find_labels'),
    },
    {
      name: 'search_label: a success of an unexpected shape',
      answers: { search: { content: [{ type: 'text', text: JSON.stringify({ set_id: EXAMPLAMAB.setId, passages: [{ chunk_id: 1 }] }) }], isError: false } },
      turns: [toolCalls(find('Examplamab')), toolCalls(search(EXAMPLAMAB.setId, 'dose'))],
      sentence: unexpectedAnswer('search_label'),
    },
  ];
  for (const row of odd) {
    await t.test(row.name, async (t) => {
      const tokens = await startExpertTokens(t);
      const mcpUrl = await startOddRetrieval(t, row.answers);
      const model = await startScriptedModel(t, row.turns);
      const response = await runExpert({ model, mcpUrl, caller: await tokens.caller() }, QUESTION);
      assert.equal(response.outcome, 'failed');
      assert.equal(response.stop_reason, row.sentence);
      assert.equal(response.reply, '');
      assertNoMoreRequests(model, row.turns.length);
    });
  }
  assert.equal(unknownError('reranker_unavailable'), 'The label search answered with an error this agent does not know: reranker_unavailable.');
  assert.equal(unexpectedAnswer('find_labels'), 'The retrieval service answered find_labels in a form this agent does not expect.');
});

test('E13. label_not_found and invalid_input from the service are told to the model, and the run goes on to an accepted answer', async (t) => {
  const r = await rig(
    t,
    [
      toolCalls(find('Examplamab')),
      toolCalls(search(EXAMPLAMAB.setId, 'dose')),
      toolCalls(search(EXAMPLAMAB.setId, 'dose '.repeat(201))),
      toolCalls(search(EXAMPLAMAB.setId, 'dose')),
      toolCalls(answer(statement('Examplamab is given at 1,200 mg once a day.', ['P1'], 'given at 1,200 mg once a day'))),
    ],
    // The first search finds no passage and the label is not in the index; the second is refused by the service
    // before it reaches the engine; the third finds the passage.
    { searches: [[], [DOSE]], count: { status: 200, body: { count: 0 } } },
  );

  const response = await runExpert(r.options, QUESTION);

  assert.ok(lastTold(r.model, 2).includes('"error":"label_not_found"'));
  assert.ok(lastTold(r.model, 3).includes('"error":"invalid_input"'));
  // Both searches the service refused count towards the run's four.
  assert.ok(lastTold(r.model, 4).includes('Searches left in this run: 1.'));
  const told = toolSteps(response).filter((step) => step.tool === 'search_label');
  assert.deepEqual(
    told.map((step) => [prop(step.result, 'error'), step.is_error]),
    [
      ['label_not_found', true],
      ['invalid_input', true],
    ],
  );
  assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
  assert.equal(response.label_answer, 'answered');
});

test('E14. the retrieval service refusing the token, unable to check it, without both tools, or not reachable: each failed with its sentence before the model is asked', async (t) => {
  await t.test('a token without the retrieval service in its audience', async (t) => {
    const r = await rig(t, [text('never sent')]);
    const caller = await r.tokens.caller({ claims: { aud: ['lab-agents'] } });
    const response = await runExpert({ ...r.options, caller }, QUESTION);
    assert.equal(response.outcome, 'failed');
    assert.equal(response.stop_reason, RETRIEVAL_REFUSED_TOKEN);
    assert.deepEqual(kinds(response), ['error']);
    assert.equal(r.model.requests.length, 0);
  });

  await t.test('a token the retrieval service cannot check', async (t) => {
    const tokens = await startExpertTokens(t);
    const retrieval = await startRetrieval(t, tokens, {}, await unreachableIdentityCheck(t));
    const model = await startScriptedModel(t, [text('never sent')]);
    const response = await runExpert({ model, mcpUrl: retrieval.mcpUrl, caller: await tokens.caller() }, QUESTION);
    assert.equal(response.outcome, 'failed');
    assert.equal(response.stop_reason, RETRIEVAL_COULD_NOT_CHECK);
    assert.equal(response.stop_reason, "The retrieval service could not check the caller's token.");
    assert.equal(model.requests.length, 0);
  });

  // The real retrieval service always offers both tools, so a labelled stand-in offers one (expert-helpers.ts).
  await t.test('a service that does not offer both tools', async (t) => {
    const tokens = await startExpertTokens(t);
    const mcpUrl = await startOddRetrieval(t, { offer: ['find_labels'] });
    const model = await startScriptedModel(t, [text('never sent')]);
    const response = await runExpert({ model, mcpUrl, caller: await tokens.caller() }, QUESTION);
    assert.equal(response.outcome, 'failed');
    assert.equal(response.stop_reason, RETRIEVAL_LACKS_TOOLS);
    assert.deepEqual(kinds(response), ['error']);
    assert.equal(model.requests.length, 0);
  });

  await t.test('not reachable', async (t) => {
    const r = await rig(t, [text('never sent')]);
    const response = await runExpert({ ...r.options, mcpUrl: `${await deadUrl(t)}/mcp` }, QUESTION);
    assert.equal(response.outcome, 'failed');
    assert.equal(response.stop_reason, RETRIEVAL_UNREACHABLE);
    assert.equal(r.model.requests.length, 0);
    assert.equal(JSON.stringify(response).includes('127.0.0.1'), false);
  });
});

test("E15. the caller's token reaches the retrieval service on every request of the run", async (t) => {
  const r = await rig(
    t,
    [
      toolCalls(find('Examplamab')),
      toolCalls(search(EXAMPLAMAB.setId, 'dose')),
      toolCalls(answer(statement('Examplamab is given at 1,200 mg once a day.', ['P1'], 'given at 1,200 mg once a day'))),
    ],
    { searches: [[DOSE]] },
  );

  const response = await runExpert(r.options, QUESTION);

  assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
  // Connecting, listing the tools, and the two calls, at the least.
  assert.ok(r.retrieval.authorizations.length >= 4, `${r.retrieval.authorizations.length} requests`);
  for (const header of r.retrieval.authorizations) assert.equal(header, `Bearer ${r.caller.token}`);
});

test('E16. text and no final tool: stopped; the text is in the model step and not in the reply', async (t) => {
  const r = await rig(t, [toolCalls(find('Examplamab')), text('Examplamab is usually taken once a day.')]);

  const response = await runExpert(r.options, QUESTION);

  assert.equal(response.outcome, 'stopped');
  assert.equal(response.stop_reason, endedWithoutFinalTool('endTurn'));
  assert.equal(response.reply, '');
  assert.equal(response.label_answer, undefined);
  assert.equal(item(modelSteps(response), 1, 'model step').text, 'Examplamab is usually taken once a day.');
  assertNoMoreRequests(r.model, 2);
});

test('E17. the turn limit and the time limit stop the run with the same sentences as intake', async (t) => {
  await t.test('turn limit', async (t) => {
    const r = await rig(t, [toolCalls(find('Examplamab')), toolCalls(find('Examplamab')), toolCalls(find('Examplamab'))]);
    const response = await runExpert({ ...r.options, limits: { maxTurns: 2 } }, QUESTION);
    assert.equal(response.outcome, 'stopped');
    assert.equal(response.stop_reason, 'The run reached its limit of 2 turns with the model.');
    assert.equal(r.model.requests.length, 2);
  });

  await t.test('time limit', async (t) => {
    const clock = agentClock(AGENT_START);
    const tokens = await startExpertTokens(t);
    const retrieval = await startRetrieval(t, tokens);
    const model = await startScriptedModel(t, [toolCalls(find('Examplamab')), text('never sent')], {
      onRequest: () => {
        clock.advance(EXPERT_TEST_LIMITS.runMs + 1);
      },
    });
    const response = await runExpert({ model, mcpUrl: retrieval.mcpUrl, caller: await tokens.caller(), clock }, QUESTION);
    assert.equal(response.outcome, 'stopped');
    assert.equal(response.stop_reason, 'The run reached its time limit of 5 s.');
    assert.equal(model.requests.length, 1);
    // No call was made with no time left.
    assert.equal(retrieval.standIn.received.length, 0);
  });
});

test('E18. a turn cut off at the output allowance is asked again once with thinking off; cut off again is stopped', async (t) => {
  await t.test('asked again with thinking off, then completed', async (t) => {
    const r = await rig(t, [text('The question is about', 'length'), toolCalls(cannot('not_a_label_question'))]);
    const response = await runExpert(r.options, QUESTION);
    assert.equal(prop(r.model.requests[0], 'reasoning'), undefined);
    assert.deepEqual(prop(r.model.requests[1], 'reasoning'), { effort: 'none' });
    assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
    assert.equal(item(modelSteps(response), 0, 'model step').finish_reason, 'maxTokens');
  });

  await t.test('cut off again, in text', async (t) => {
    const r = await rig(t, [text('', 'length'), text('Examplamab is', 'length')]);
    const response = await runExpert(r.options, QUESTION);
    assert.equal(response.outcome, 'stopped');
    assert.equal(response.stop_reason, CUT_OFF_AGAIN);
    assert.equal(response.reply, '');
    assertNoMoreRequests(r.model, 2);
  });

  await t.test('cut off part way through a call, then again', async (t) => {
    const cut: ScriptedAnswer = { kind: 'tools', calls: [{ name: 'answer', arguments: '{"statements":[{"te' }], finishReason: 'length' };
    const r = await rig(t, [cut, cut]);
    const response = await runExpert(r.options, QUESTION);
    assert.equal(response.outcome, 'stopped');
    assert.equal(response.stop_reason, CUT_OFF_AGAIN);
    assert.deepEqual(prop(r.model.requests[1], 'reasoning'), { effort: 'none' });
    assertNoMoreRequests(r.model, 2);
  });
});

test('E19. the model answering 500 until the client gives up, and the model unreachable: failed with the same sentences as intake', async (t) => {
  await t.test('500', async (t) => {
    const r = await rig(t, [
      { kind: 'status', status: 500 },
      { kind: 'status', status: 500 },
      { kind: 'status', status: 500 },
    ]);
    const response = await runExpert(r.options, QUESTION);
    assert.equal(response.outcome, 'failed');
    assert.equal(response.stop_reason, 'The model answered with status 500.');
    assertNoMoreRequests(r.model, 3);
  });

  await t.test('unreachable', async (t) => {
    const r = await rig(t, []);
    const dead = await deadUrl(t);
    const response = await runExpert({ ...r.options, model: { ...r.model, settings: { ...r.model.settings, baseUrl: `${dead}/v1` } } }, QUESTION);
    assert.equal(response.outcome, 'failed');
    assert.equal(response.stop_reason, 'The model could not be reached.');
    assert.equal(JSON.stringify(response).includes('127.0.0.1'), false);
  });
});

test('E20. over HTTP through the shared contract server: 401 without a token and 200 with one; KNOWLEDGE_MCP_URL is required', async (t) => {
  const r = await rig(t, [toolCalls(cannot('not_a_label_question'))]);
  const server = createContractServer(
    EXPERT_IDENTITY,
    (inbound, caller) =>
      handleQuestion(
        {
          identity: EXPERT_IDENTITY,
          model: r.model.settings,
          knowledgeMcpUrl: r.retrieval.mcpUrl,
          now: agentClock(AGENT_START).now,
          limits: EXPERT_TEST_LIMITS,
          settings: EXPERT_SETTINGS,
        },
        inbound,
        caller,
      ),
    r.tokens.agentCheck,
  );
  const url = await listen(server);
  t.after(() => {
    stop(server);
  });
  const body = JSON.stringify({ message: QUESTION });

  const refused = await fetch(`${url}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(refused.status, 401);
  assert.equal(r.model.requests.length, 0);

  const accepted = await fetch(`${url}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${r.caller.token}` },
    body,
  });
  assert.equal(accepted.status, 200);
  const response: InvocationResponse = invocationResponseSchema.parse(await accepted.json());
  assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
  assert.equal(response.label_answer, 'not_a_label_question');

  const env = {
    MODEL_BASE_URL: 'http://model.invalid/v1',
    MODEL_API_KEY: 'test-key',
    AGENT_ID: 'expert',
    AUTH_DISCOVERY_URL: 'http://identity.invalid/.well-known/openid-configuration',
    AUTH_ISSUER: 'http://identity.invalid/realms/lab',
    AUTH_ALLOWED_AUDIENCE: 'lab-agents',
    AUTH_ALLOWED_CLIENTS: 'desk',
    AUTH_ROLES_CLAIM: 'roles',
    KNOWLEDGE_MCP_URL: 'http://knowledge:8000/mcp',
  };
  assert.equal(expertSettingsFrom(env).own, 'http://knowledge:8000/mcp');
  assert.equal(expertSettingsFrom(env).auth.minRemainingSeconds, 150);
  const { KNOWLEDGE_MCP_URL: _left, ...missing } = env;
  assert.throws(() => expertSettingsFrom(missing), /^Error: KNOWLEDGE_MCP_URL is not set/);
  assert.throws(() => expertSettingsFrom({ ...env, KNOWLEDGE_MCP_URL: ' ' }), /^Error: KNOWLEDGE_MCP_URL is not set/);
});

test('E21. statements citing passages of two labels: each citation names its own label', async (t) => {
  const other = chunk(INVENTORIN, 1, 'Inventorin is given at 50 mg twice a day.');
  const r = await rig(
    t,
    [
      toolCalls(find('Examplamab'), find('Inventorin')),
      toolCalls(search(EXAMPLAMAB.setId, 'dose'), search(INVENTORIN.setId, 'dose')),
      toolCalls(
        answer(
          statement('Examplamab is given at 1,200 mg once a day.', ['P1'], 'given at 1,200 mg once a day'),
          statement('Inventorin is given at 50 mg twice a day.', ['P2'], 'given at 50 mg twice a day'),
        ),
      ),
    ],
    { searches: [[DOSE], [other]] },
  );

  const response = await runExpert(r.options, message('msg-1', 'What are the doses of Examplamab and Inventorin?'));

  assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
  assert.deepEqual(
    response.citations.map((citation) => [citation.drug, citation.set_id, citation.version, citation.effective_date]),
    [
      ['Examplamab', EXAMPLAMAB.setId, 3, '20240102'],
      ['Inventorin, inventorin hydrochloride', INVENTORIN.setId, 7, '20231115'],
    ],
  );
});

test('E22. the pure functions: numbers in a text, units, and the quote comparison', () => {
  assert.equal(withoutFootnoteMarks('function[^1] and[^a b].'), 'function and.');
  assert.equal(numberForm('1,200 mg[^2] and 1,000,000 cells, x^{2} y_{1}'), '1200 mg and 1000000 cells, x2 y1');
  assert.deepEqual(numbersIn('Take 1,200 mg[^3] or 2.5 mL; 10^{6} cells; C_{max} at 3 h.'), ['1200', '2.5', '106', '3']);
  assert.deepEqual(numbersIn('No numbers here.'), []);
  // A thousands separator only between groups of three digits; a list is left as it is.
  assert.deepEqual(numbersIn('1, 2 and 3,45'), ['1', '2', '3', '45']);
  assert.deepEqual(numbersWithUnits('Give 5 mg, then 2.5mL, 10 % and 3 units; 4 µg or 4 μg; 7 days.'), [
    { number: '5', unit: 'mg' },
    { number: '2.5', unit: 'ml' },
    { number: '10', unit: '%' },
    { number: '3', unit: 'units' },
    { number: '4', unit: 'μg' },
    { number: '4', unit: 'μg' },
  ]);
  // One space between a number and its unit is allowed; two are not read as a unit of that number.
  assert.deepEqual(numbersWithUnits('5mg, 6 mg and 7  mg'), [
    { number: '5', unit: 'mg' },
    { number: '6', unit: 'mg' },
  ]);
  assert.equal(unitIn('mg', 'at 1200 mg daily'), true);
  assert.equal(unitIn('mcg', 'at 1200 mg daily'), false);
  assert.equal(unitIn('g', 'given daily'), false);
  assert.equal(unitIn('%', 'about 12 percent'), true);
  assert.equal(unitIn('unit', '3 Units'), true);
  assert.equal(unitIn('μg', '4 µg'), true);
  // A unit inside another unit is not found: g in µg, L in µL. mcg and µg do not find each other.
  assert.equal(unitIn('g', '4 µg'), false);
  assert.equal(unitIn('l', '5 µL'), false);
  assert.equal(unitIn('mcg', '4 µg'), false);
  assert.equal(unitIn('μg', '4 mcg'), false);
  assert.equal(quoteForm('  Lower THE\n dose[^1]  '), 'lower the dose');
  assert.equal(quoteFoundIn('lower the  DOSE to 600 mg', 'Lower the dose[^1] to 600 mg in patients.'), true);
  assert.equal(quoteFoundIn('Lower the dose ... 600 mg', 'Lower the dose to 600 mg in patients.'), false);
  assert.equal(quoteFoundIn('Lower the dose to 60 mg in', 'Lower the dose to 600 mg in patients.'), false);
  assert.equal(quoteFoundIn('', 'Lower the dose.'), false);
});

test('E23. the model asking for two calls in one turn: they run one at a time, in order', async (t) => {
  const r = await rig(
    t,
    [
      // The search is on the label the find in the same turn returns, so it can only be made after the find.
      toolCalls(find('Examplamab'), search(EXAMPLAMAB.setId, 'dose')),
      toolCalls(answer(statement('Examplamab is given at 1,200 mg once a day.', ['P1'], 'given at 1,200 mg once a day'))),
    ],
    { searches: [[DOSE]] },
  );

  const response = await runExpert(r.options, QUESTION);

  assert.deepEqual(kinds(response), ['model', 'tool', 'retrieval', 'model']);
  const order = r.retrieval.standIn.received.map((request) => (prop(request.body, 'collapse') === undefined ? 'search' : 'find'));
  assert.deepEqual(order, ['find', 'search']);
  assert.equal(response.outcome, 'completed', response.stop_reason ?? '');
});
