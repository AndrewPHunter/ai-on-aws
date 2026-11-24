// What code decides in an orchestrator run, as pure functions over plain values: whether a question is put, what
// the model is told about it, which questions the reply shows, how the run ends, and the reply with its
// citations. Nothing here calls anything or reads a clock.

import type { Citation, DelegatedResponse, InvocationResponse } from '../../../shared/agent-contract.ts';
import { numbersIn, withCitationsMovedBy } from '../expert/checks.ts';

// A label question as the model asked it, once its arguments are read.
export type Asked = { drug: string; question: string; replaces: string | null };

// What came back from a call to a sub-agent: its whole response, or why there is none.
export type CallResult = { failure: string | null; response: DelegatedResponse | null };

// A question as code decided it. A question put carries the text sent to the expert, and what came back once the
// call has ended.
export type Question =
  | { id: string; put: true; asked: Asked; text: string; call?: CallResult }
  | { id: string; put: false; reason: string };

// The rules a question is put under: the questions of one round, the rounds, the time one call may take, and the
// time the run must have left beyond that.
export type QuestionRules = { questionsPerRound: number; rounds: number; callMs: number; callMarginMs: number };

// Where the question stands when it is taken up. nthInRound counts the model's calls in its turn, from 1;
// round counts the model's turns that asked a question, from 1.
export type TakenUp = { messageText: string; putIds: readonly string[]; nthInRound: number; round: number; remainingMs: number };

export type PutDecision = { put: true; asked: Asked; text: string } | { put: false; reason: string };

// How the model's loop ended: by the model saying it was done, or otherwise, with a sentence of code's own.
export type LoopEnd = { finished: true } | { finished: false; reason: string };

export type RunResult = { screening: CallResult; questions: readonly Question[]; loop: LoopEnd };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function words(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

// Whether a question is put, checked in this order. A reason names nothing the model wrote, because the reply
// repeats it.
export function whetherPut(input: unknown, at: TakenUp, rules: QuestionRules): PutDecision {
  const drug = isRecord(input) ? words(input['drug']) : undefined;
  const question = isRecord(input) ? words(input['question']) : undefined;
  const given = isRecord(input) ? input['replaces'] : undefined;
  const replaces = given === undefined || given === null || given === '' ? null : given;
  if (drug === undefined || question === undefined || (replaces !== null && typeof replaces !== 'string')) {
    return { put: false, reason: 'Its arguments are not a medicine and a question in words, with any question it replaces named by its id.' };
  }
  if (replaces !== null && !at.putIds.includes(replaces)) {
    return { put: false, reason: 'The question it names as the one it replaces was never asked.' };
  }
  const inMessage = new Set(numbersIn(at.messageText));
  if (numbersIn(`${drug} ${question}`).some((number) => !inMessage.has(number))) {
    return { put: false, reason: 'It holds a number that is not in the message.' };
  }
  if (at.nthInRound > rules.questionsPerRound) {
    return { put: false, reason: `It is more than ${rules.questionsPerRound} questions in one round.` };
  }
  if (at.round > rules.rounds) {
    return { put: false, reason: `It is in round ${at.round}; questions are put from ${rules.rounds} rounds only.` };
  }
  if (at.remainingMs < rules.callMs + rules.callMarginMs) {
    const needed = Math.round((rules.callMs + rules.callMarginMs) / 1000);
    return { put: false, reason: `The run has less than ${needed} s left: the time a call to the label expert may take, and a margin.` };
  }
  return { put: true, asked: { drug, question, replaces }, text: `${drug}: ${question}` };
}

// What the model reads back about a question: for one put, the expert's label answer or that it did not complete,
// its stop reason and its reply; for one not put, why. Nothing else of the run.
export function toldToModel(question: Question): Record<string, unknown> {
  if (!question.put) {
    return { id: question.id, not_put: question.reason };
  }
  const response = question.call?.response ?? null;
  const stopReason = question.call?.failure ?? response?.stop_reason ?? null;
  const reply = response?.reply ?? '';
  if (response?.outcome === 'completed') {
    return { id: question.id, label_answer: response.label_answer ?? null, stop_reason: stopReason, reply };
  }
  return { id: question.id, did_not_complete: true, stop_reason: stopReason ?? 'The call was not made before the run ended.', reply };
}

function answered(question: Question): boolean {
  return question.put && question.call?.response?.outcome === 'completed';
}

// The questions the reply shows, in the order taken up: every question but one a question put replaces.
export function shownQuestions(questions: readonly Question[]): Question[] {
  const replaced = new Set(questions.flatMap((question) => (question.put && question.asked.replaces !== null ? [question.asked.replaces] : [])));
  return questions.filter((question) => !replaced.has(question.id));
}

// A question is settled when it was answered, or replaced by one that is settled.
function settled(question: Question, questions: readonly Question[]): boolean {
  if (!question.put) return false;
  if (answered(question)) return true;
  return questions.some((later) => later.put && later.asked.replaces === question.id && settled(later, questions));
}

export const LABEL_QUESTION_UNANSWERED = 'label_question_unanswered';
export const SCREENING_INCOMPLETE = 'adverse_event_screening_incomplete';

function screeningCompleted(screening: CallResult): boolean {
  return screening.response?.outcome === 'completed';
}

// Why screening did not complete, as a sentence.
export function screeningReason(screening: CallResult): string {
  if (screening.failure !== null) return screening.failure;
  const response = screening.response;
  if (response === null) return 'The intake agent was not called.';
  return `The intake agent's run ended ${response.outcome}${response.stop_reason === null ? '.' : `: ${response.stop_reason}`}`;
}

// How the run ends: the rows of "How it ends" in docs/architecture/orchestrator.md.
export function howItEnds(run: RunResult): Pick<InvocationResponse, 'outcome' | 'stop_reason'> {
  if (screeningCompleted(run.screening)) {
    const allSettled = run.loop.finished && run.questions.every((question) => settled(question, run.questions));
    return allSettled ? { outcome: 'completed', stop_reason: null } : { outcome: 'stopped', stop_reason: LABEL_QUESTION_UNANSWERED };
  }
  // A label answer obtained is one the reply shows.
  if (shownQuestions(run.questions).some(answered)) {
    return { outcome: 'stopped', stop_reason: SCREENING_INCOMPLETE };
  }
  return { outcome: 'failed', stop_reason: screeningReason(run.screening) };
}

// A sentence to the sender for each case action, naming the case by its id and never by its status value.
function caseActionSentences(run: RunResult): string[] {
  return (run.screening.response?.case_actions ?? []).map((action) => {
    if (action.kind === 'case_opened') {
      const recorded = `We have recorded the side effect you describe as an adverse event report, reference ${action.case_id}.`;
      return action.status === 'incomplete'
        ? `${recorded} Some details the report needs are missing, so our safety team will contact you for them.`
        : `${recorded} Our safety team will review it and may contact you for more detail.`;
    }
    if (action.kind === 'case_already_open') return `Your report is already recorded under reference ${action.case_id}.`;
    return `We have added what you told us to report ${action.case_id}.`;
  });
}

// The reply, written by code, and its citations: the section "The reply" in docs/architecture/orchestrator.md. When
// screening completed it is written to the sender: "Thank you for your message.", then the ending's sentence for
// label_question_unanswered; a sentence for each case action; each question shown, headed "On your question:" when it
// is the only one shown and "On your question 2:" (for q2) otherwise; and "Medical Information" when the run
// completed. Otherwise it begins as the ending's row says, with the same case-action sentences and each question
// headed "Label question 2". Under each heading, the expert's reply word for word with its citation numbers moved by
// the number of citations before it, or a plain sentence when it was not put or not answered. Nothing the
// orchestrator's model wrote is in it: a question as it was put is in the run's steps only.
export function replyWithCitations(run: RunResult): { reply: string; citations: Citation[] } {
  const ending = howItEnds(run);
  const toSender = screeningCompleted(run.screening);
  const parts: string[] = [];
  if (toSender) parts.push('Thank you for your message.');
  if (ending.outcome === 'failed') {
    parts.push(screeningReason(run.screening));
  } else if (ending.stop_reason === SCREENING_INCOMPLETE) {
    // Sending it again can help only when the intake agent did not run to an end of its own. A stopped intake run
    // ended where its own rules stopped it, and says why: for one, that a person must read the message.
    const intake = run.screening.response;
    const again = intake === null || intake.outcome === 'failed' ? ' Send it again.' : '';
    parts.push(`The screening of this message for an adverse event did not complete. ${screeningReason(run.screening)}${again}`);
  } else if (ending.stop_reason === LABEL_QUESTION_UNANSWERED) {
    const loop = run.loop.finished ? '' : ` Not every question in it could be asked: ${run.loop.reason}`;
    parts.push(`A question in this message was not answered.${loop}`);
  }
  parts.push(...caseActionSentences(run));

  const citations: Citation[] = [];
  const shown = shownQuestions(run.questions);
  for (const question of shown) {
    const number = question.id.slice(1);
    const heading = !toSender ? `Label question ${number}` : shown.length === 1 ? 'On your question:' : `On your question ${number}:`;
    if (!question.put) {
      parts.push(`${heading} ${toSender ? 'it was' : 'was'} not put to the label expert. ${question.reason}`);
      continue;
    }
    const response = question.call?.response;
    if (response !== undefined && response !== null && response.outcome === 'completed') {
      parts.push(`${heading}\n\n${withCitationsMovedBy(response.reply, citations.length)}`);
      citations.push(...response.citations);
      continue;
    }
    const why = toldToModel(question)['stop_reason'];
    parts.push(`${heading}\n\nThe label expert did not answer this question. ${typeof why === 'string' ? why : ''}`.trimEnd());
  }
  if (ending.outcome === 'completed') parts.push('Medical Information');
  return { reply: parts.join('\n\n'), citations };
}
