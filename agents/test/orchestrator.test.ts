// The orchestrator's invariants ("Always true" in docs/architecture/orchestrator.md), one test each. The decisions
// are called as pure functions; the rest at the handler, through the real Strands loop, against one scripted model
// server on loopback, with a scripted token exchange and a scripted call to a sub-agent passed in. Every medicine
// and answer here is invented.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { Citation, DelegatedResponse, DelegationStep, InvocationResponse } from '../../shared/agent-contract.ts';
import type { TokenExchange, TokenExchangeRequest } from '../../shared/token-exchange.ts';
import { howItEnds, replyWithCitations, whetherPut } from '../src/orchestrator/decisions.ts';
import type { CallResult, Question, RunResult } from '../src/orchestrator/decisions.ts';
import { ORCHESTRATOR_SETTINGS } from '../src/orchestrator/settings.ts';
import { handleInquiry } from '../src/orchestrator/strands.ts';
import type { CallSubAgent, SubAgentAnswer, SubAgentCall } from '../src/orchestrator/sub-agents.ts';
import type { Limits } from '../src/run/limits.ts';
import { CALLER, ask, clock, cutOff, message, say, startModel } from './support.ts';
import type { ModelAnswer, ModelRequest, ScriptedModel } from './support.ts';

// Limits no busy machine reaches, except where a row passes its own: the calls' limits are kept in real time.
const LIMITS: Limits = { maxTurns: 3, runMs: 60_000, modelMs: 30_000, toolMs: 20_000 };
const RULES = { ...ORCHESTRATOR_SETTINGS, callMs: LIMITS.toolMs };

const citation = (quote: string): Citation => ({
  drug: 'An invented medicine', section: '2 DOSAGE', quote, set_id: 'set-x', version: 1, effective_date: '20240102', source: 'https://labels.example/set-x', passage: `p-${quote}`,
});
const response = (id: string, fields: Partial<DelegatedResponse>): DelegatedResponse => ({
  agent: { id, implementation: 'Strands' }, outcome: 'completed', stop_reason: null, reply: '', citations: [], case_actions: [], steps: [], ...fields,
});
// The expert's reply as replyFor writes it: each paragraph ends with its citation's number.
const expertSaid = (...quotes: string[]): DelegatedResponse =>
  response('expert', { reply: quotes.map((quote, n) => `${quote} [${n + 1}]`).join('\n\n'), citations: quotes.map(citation), label_answer: 'answered' });
const intakeSaid = (messageId: string): DelegatedResponse =>
  response('intake-strands', { reply: 'INTAKE-REPLY', case_actions: [{ kind: 'case_opened', case_id: `C-${messageId}`, status: 'incomplete' }] });

// What each sub-agent answers unless a test says otherwise.
const answerOf = (call: SubAgentCall): { ok: true; response: DelegatedResponse } =>
  ({ ok: true, response: call.to.id === 'expert' ? expertSaid(`Said of ${call.request.message.text}.`) : intakeSaid(call.request.message.id) });

// STAND-IN for the two sub-agents: answers each call as `answer` says, and records it.
function subAgents(answer: (call: SubAgentCall) => SubAgentAnswer | Promise<SubAgentAnswer> = answerOf) {
  const calls: SubAgentCall[] = [];
  const call: CallSubAgent = (made) => {
    calls.push(made);
    return Promise.resolve(answer(made));
  };
  return { calls, call };
}

// STAND-IN for the token exchange: a token naming the audience and scopes asked for.
function exchanges() {
  const asked: TokenExchangeRequest[] = [];
  const exchange: TokenExchange = (request) => {
    asked.push(request);
    return Promise.resolve({ kind: 'token', token: `exchanged:${request.audience}:${request.scopes.join(' ')}`, expiresAt: new Date('2026-03-01T11:00:00.000Z'), scopes: [...request.scopes] });
  };
  return { asked, exchange };
}
const refused: TokenExchange = () => Promise.resolve({ kind: 'refused', reason: 'provider_refused', detail: 'The identity provider refused the token exchange with status 400.' });

const q = (drug: string, question: string, replaces?: string): [string, unknown] => ['ask_label_expert', { drug, question, ...(replaces ? { replaces } : {}) }];

// What the model does with each message, by its text inside <message>. Any other message: one question, then done.
const SCRIPTS: Record<string, (nth: number) => ModelAnswer> = {
  'Patient JD had a rash after Examplamab.': () => say('Nothing to ask.'),
  'How should Examplamab be dosed, and how is Inventorin stored?': (nth) =>
    [
      ask(q('Examplamab', 'How is it dosed?'), q('Inventorin', 'How is it stored?')),
      ask(q('Examplamab', 'What is the adult dose?', 'q1'), q('Examplamab', 'Is 40 mg the adult dose?')),
      say('Nothing left to ask. MODEL-WROTE-THIS'),
    ][nth] ?? say('Done.'),
  'The model server fails on this one.': () => ({ kind: 'status', status: 400 }),
  'How is Examplamab stored? A turn is cut off once.': (nth) => [ask(q('Examplamab', 'How is it stored?')), cutOff][nth] ?? say('Done.'),
  'How is Examplamab stored? A turn is cut off twice.': (nth) => [ask(q('Examplamab', 'How is it stored?'))][nth] ?? cutOff,
  'How is Examplamab stored? The model keeps asking.': (nth) => ask(q('Examplamab', `How is it stored, asked again ${'once '.repeat(nth)}`)),
  'How is Inventorin stored?': (nth) => (nth === 0 ? ask(q('Inventorin', 'How is it stored?')) : say('Done.')),
};
const script = (request: ModelRequest, nth: number): ModelAnswer =>
  SCRIPTS[request.user.slice('<message>\n'.length, -'\n</message>'.length)]?.(nth) ?? (nth === 0 ? ask(q('Examplamab', 'How is it stored?')) : say('Done.'));

let messages = 0;

async function runOne(model: ScriptedModel, text: string, options: { call?: CallSubAgent; exchange?: TokenExchange; limits?: Partial<Limits>; now?: () => Date } = {}) {
  const inbound = message(`msg-${++messages}`, text);
  const answered = await handleInquiry(
    {
      identity: { id: 'orchestrator-test', implementation: 'Strands' },
      model: model.settings,
      exchange: options.exchange ?? exchanges().exchange,
      callSubAgent: options.call ?? subAgents().call,
      now: options.now ?? clock().now,
      limits: { ...LIMITS, ...options.limits },
      settings: ORCHESTRATOR_SETTINGS,
    },
    inbound,
    CALLER,
  );
  return { inbound, response: invocationResponseSchema.parse(answered) };
}

const delegations = (response: InvocationResponse): DelegationStep[] => response.steps.filter((step): step is DelegationStep => step.kind === 'delegation');
const requestsFor = (model: ScriptedModel, text: string): ModelRequest[] => model.requests.filter((request) => request.user.includes(text));

// Plain values for the pure functions.
const CLEAN: CallResult = { failure: null, response: intakeSaid('m') };
const put = (id: string, said: DelegatedResponse | null, replaces: string | null = null): Question => ({
  id, put: true, asked: { drug: 'Model-named-medicine', question: `Model-written question ${id}?`, replaces }, text: `Model-named-medicine: Model-written question ${id}?`, call: { failure: said ? null : 'The label expert could not be reached.', response: said },
});
const result = (questions: Question[], screening: CallResult = CLEAN, finished = true): RunResult => ({ screening, questions, loop: finished ? { finished } : { finished, reason: 'The model answered with status 400.' } });

test('orchestrator', async (t) => {
  const model = await startModel(t, script);
  const TWO_ROUNDS = 'How should Examplamab be dosed, and how is Inventorin stored?';
  const shared = { ...subAgents(), ...exchanges() };
  const twoRounds = await runOne(model, TWO_ROUNDS, shared);
  // Every call to a sub-agent goes unanswered, within a call limit small enough to wait for.
  const silent = await runOne(model, 'How is Examplamab stored? Nothing answers.', { call: subAgents(() => new Promise<never>(() => undefined)).call, limits: { toolMs: 300 } });

  await t.test('orchestrator 1. every message is sent to the intake agent once, unchanged and under its own id, by code, whatever the model does', async () => {
    for (const text of ['Patient JD had a rash after Examplamab.', TWO_ROUNDS, 'The model server fails on this one.']) {
      const agents = text === TWO_ROUNDS ? shared : subAgents();
      const { inbound, response } = text === TWO_ROUNDS ? twoRounds : await runOne(model, text, { call: agents.call });
      const screenings = agents.calls.filter((call) => call.to.id === 'intake-strands');
      assert.deepEqual(screenings.map((call) => call.request.message), [inbound], text);
      assert.deepEqual([response.steps[0]?.kind, delegations(response)[0]?.id, delegations(response)[0]?.requested_by], ['delegation', 'screening', 'agent'], text);
    }
  });

  await t.test('orchestrator 2. a question is put only within the rules; one not put is told to the model and named in the reply; each put is one call', async () => {
    const at = { messageText: 'Is the 20 mg dose right?', putIds: ['q1'], nthInRound: 1, round: 1, remainingMs: 60_000 };
    const rows: Array<[string, unknown, Partial<typeof at>, boolean]> = [
      ['arguments not words', { drug: 'Examplamab' }, {}, false],
      ['replaces a question never asked', { drug: 'Examplamab', question: 'Dose?', replaces: 'q9' }, {}, false],
      ['a number not in the message', { drug: 'Examplamab', question: 'Is 40 mg right?' }, {}, false],
      ['a third question in the round', { drug: 'Examplamab', question: 'Dose?' }, { nthInRound: 3 }, false],
      ['a third round', { drug: 'Examplamab', question: 'Dose?' }, { round: 3 }, false],
      ['less than a call\'s time and the margin left', { drug: 'Examplamab', question: 'Dose?' }, { remainingMs: RULES.callMs + RULES.callMarginMs - 1 }, false],
      ['within every rule', { drug: 'Examplamab', question: 'Is 20 mg right?', replaces: 'q1' }, {}, true],
    ];
    for (const [name, input, change, expected] of rows) assert.equal(whetherPut(input, { ...at, ...change }, RULES).put, expected, name);

    assert.equal(shared.calls.some((call) => call.request.message.text.includes('40 mg')), false, 'a refused question reached the label expert');
    assert.ok(requestsFor(model, TWO_ROUNDS)[2]?.outputs.some((output) => output.output.includes('not_put')), 'the model was not told');
    assert.ok(twoRounds.response.reply.includes('Label question 4 was not put'), 'the reply does not name it');
    const askedTwice = shared.calls.filter((call) => call.to.id === 'expert').map((call) => call.request.message.id);
    assert.deepEqual(askedTwice, [...new Set(askedTwice)], 'a question was sent again');
  });

  await t.test('orchestrator 3. the model is shown each answer\'s label answer, stop reason and reply, and nothing of the intake agent\'s result', () => {
    const told = requestsFor(model, TWO_ROUNDS)[1]?.outputs.map((output) => output.output).join('\n') ?? '';
    const shown = ['"label_answer":"answered"', '"stop_reason":null', 'Said of Examplamab: How is it dosed?. [1]', 'Said of Inventorin: How is it stored?. [1]'];
    assert.deepEqual(shown.filter((expected) => !told.includes(expected)), [], 'the model was not shown each answer');
    const all = requestsFor(model, TWO_ROUNDS).map((request) => request.body).join('\n');
    assert.deepEqual(['INTAKE-REPLY', `C-${twoRounds.inbound.id}`].filter((value) => all.includes(value)), [], 'the model was shown the intake agent\'s result');
  });

  await t.test('orchestrator 4. the reply is code\'s: no model text, each expert reply word for word with its numbers moved, a replaced question not shown', () => {
    assert.equal(twoRounds.response.reply.includes('MODEL-WROTE-THIS'), false, 'the model\'s text is in the reply');
    const { reply } = replyWithCitations(result([put('q1', expertSaid('Alpha.', 'Beta.')), put('q2', expertSaid('Gamma.')), put('q3', expertSaid('Delta.')), put('q4', expertSaid('Epsilon.'), 'q3')]));
    assert.ok(reply.includes('Label question 2\n\nGamma. [3]'), 'a reply after another is not word for word with its number moved');
    assert.equal(reply.includes('Label question 3') || reply.includes('Delta.'), false, 'a replaced question is shown');
    assert.deepEqual(['Model-named-medicine', 'Model-written question'].filter((text) => reply.includes(text)), [], 'text the model wrote for a question is in the reply');
  });

  await t.test('orchestrator 5. citations are the shown replies\', each number naming its own; case actions are the intake agent\'s; no label_answer', () => {
    const { reply, citations } = replyWithCitations(result([put('q1', expertSaid('Alpha.', 'Beta.')), put('q2', expertSaid('Gamma.'))]));
    const named = [...reply.matchAll(/^(.*) \[(\d+)\]$/gm)].map((match) => [match[1], citations[Number(match[2]) - 1]?.quote]);
    assert.deepEqual(named, [['Alpha.', 'Alpha.'], ['Beta.', 'Beta.'], ['Gamma.', 'Gamma.']]);
    assert.equal(citations.length, 3);
    assert.deepEqual(twoRounds.response.case_actions, intakeSaid(twoRounds.inbound.id).case_actions);
    assert.equal('label_answer' in twoRounds.response, false);
  });

  await t.test('orchestrator 6. a run ends completed only when screened and every question settled; otherwise the row that describes it', () => {
    const unscreened: CallResult = { failure: 'The intake agent could not be reached.', response: null };
    const rows: Array<[string, RunResult, string, string | null]> = [
      ['none asked', result([]), 'completed', null],
      ['answered, and one replaced by an answered one', result([put('q1', expertSaid('A.')), put('q2', null), put('q3', expertSaid('B.'), 'q2')]), 'completed', null],
      ['one not put', result([put('q1', expertSaid('A.')), { id: 'q2', put: false, reason: 'It is in round 3.' }]), 'stopped', 'label_question_unanswered'],
      ['one neither answered nor replaced', result([put('q1', null)]), 'stopped', 'label_question_unanswered'],
      ['the model\'s loop failed', result([], CLEAN, false), 'stopped', 'label_question_unanswered'],
      ['not screened, a label answer obtained', result([put('q1', expertSaid('A.'))], unscreened), 'stopped', 'adverse_event_screening_incomplete'],
      ['not screened, nothing obtained', result([put('q1', null)], unscreened), 'failed', unscreened.failure],
      ['not screened, the only label answer replaced', result([put('q1', expertSaid('A.')), put('q2', null, 'q1')], unscreened), 'failed', unscreened.failure],
    ];
    for (const [name, run, outcome, stopReason] of rows) assert.deepEqual(howItEnds(run), { outcome, stop_reason: stopReason }, name);
  });

  await t.test('orchestrator 7. each sub-agent is sent a token exchanged for it, never the caller\'s; a refused exchange is that call\'s failure', async () => {
    const tokens = new Set(shared.calls.map((call) => `${call.to.id} ${call.token}`));
    assert.deepEqual([...tokens].sort(), ['expert exchanged:expert:agents:expert:delegated', 'intake-strands exchanged:intake-strands:agents:intake']);
    assert.ok(shared.asked.every((request) => request.subjectToken === CALLER.token));
    assert.equal(shared.asked.length, shared.calls.length, 'not one exchange per call');

    const agents = subAgents();
    const { response } = await runOne(model, 'How is Examplamab stored? The exchange is refused.', { call: agents.call, exchange: refused });
    assert.equal(agents.calls.length, 0, 'a call was made with no token for it');
    assert.deepEqual(delegations(response).map((step) => [step.id, typeof step.failure, step.response]), [['screening', 'string', null], ['q1', 'string', null]]);
  });

  await t.test('orchestrator 8. every call to a sub-agent is a delegation step with what was sent and the whole response, or why there is none', async () => {
    // Each response was parsed with the contract's schema, the delegated response's included, by runOne.
    const steps = delegations(twoRounds.response);
    assert.equal(steps.length, shared.calls.length, 'not one step per call');
    for (const step of steps) {
      const call = shared.calls.find((made) => made.request.message.id === step.message.id);
      assert.deepEqual([step.message.text, step.response], [call?.request.message.text, call && answerOf(call).response], step.id);
    }
    assert.deepEqual(delegations(silent.response).map((step) => [step.id, typeof step.failure, step.response]), [['screening', 'string', null], ['q1', 'string', null]]);
  });

  await t.test('orchestrator 9. whatever goes wrong, the run ends inside the contract, within its time and at most three model turns', async () => {
    assert.equal(silent.response.outcome, 'failed', 'calls that never answered were not ended');

    const asker = await runOne(model, 'How is Examplamab stored? The model keeps asking.');
    assert.deepEqual([asker.response.outcome, asker.response.stop_reason, requestsFor(model, 'The model keeps asking.').length], ['stopped', 'label_question_unanswered', 3]);

    const once = await runOne(model, 'How is Examplamab stored? A turn is cut off once.');
    const askedAgain = requestsFor(model, 'A turn is cut off once.');
    assert.deepEqual([once.response.outcome, askedAgain.length], ['completed', 3], 'a cut-off turn was not asked again');
    const twice = await runOne(model, 'How is Examplamab stored? A turn is cut off twice.');
    assert.deepEqual([twice.response.outcome, twice.response.stop_reason, requestsFor(model, 'A turn is cut off twice.').length], ['stopped', 'label_question_unanswered', 3]);

    const time = clock();
    const late = subAgents((call) => {
      if (call.to.id === 'expert') time.advance(LIMITS.runMs);
      return answerOf(call);
    });
    const outOfTime = await runOne(model, 'How is Examplamab stored? The run runs out of time.', { call: late.call, now: time.now });
    assert.deepEqual([outOfTime.response.outcome, requestsFor(model, 'The run runs out of time.').length], ['stopped', 1]);
  });

  await t.test('orchestrator 10. runs share no state', async () => {
    const [one, two] = await Promise.all([runOne(model, 'How is Examplamab stored?'), runOne(model, 'How is Inventorin stored?')]);
    const holds = (run: { response: InvocationResponse }, value: string): boolean => JSON.stringify(run.response).includes(value);
    assert.deepEqual([holds(one, 'Said of Examplamab'), holds(one, 'Inventorin'), holds(one, `C-${two.inbound.id}`)], [true, false, false]);
    assert.deepEqual([holds(two, 'Said of Inventorin'), holds(two, 'Examplamab'), holds(two, `C-${one.inbound.id}`)], [true, false, false]);
  });
});
