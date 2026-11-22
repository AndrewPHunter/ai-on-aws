// The scores of one run, all in code: outcomes, declining, the right label, citations against the benchmark's
// references by section, retrieval, numbers, effort, and (when judgments exist) answer correctness and the judge's
// agreement with a person. Pure functions over the sample, the run's records, the passages' sections, and the
// judgments. Every share carries its numerator, denominator and 95% Wilson interval.
//
// The per-question results (identifiers and yes-or-no values only) are kept, so two runs can be compared question by
// question.

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { InvocationResponse } from '../../shared/agent-contract.ts';
import { numbersIn } from '../../agents/src/expert/checks.ts';
import { sectionMatches } from '../../knowledge/src/references.ts';
import type { Question, QuestionType } from './benchmark.ts';
import { QUESTION_TYPES } from './benchmark.ts';
import { THIRD_NAMES, thirdCuts, thirdOf } from './overlap.ts';
import type { Cuts, Third } from './overlap.ts';
import { answersUncontradicted } from './rubric.ts';
import type { AnswersJudgment, Coverage, Judgment, Verdict } from './rubric.ts';
import type { CallRecord } from './run.ts';
import { latestByQid } from './run.ts';
import { percentile, wilson } from './stats.ts';
import type { Share } from './stats.ts';
import type { Variant } from './variant.ts';

export { VERDICTS } from './rubric.ts';
export type { Judgment, Verdict } from './rubric.ts';

export type Section = { number: string | null; title: string | null };

// The yes-or-no measures, per question, that compare.sh pairs between two runs. Absent where a measure does not apply.
// judged_correct is the completeness rubric's "correct"; answers_uncontradicted the answers-question rubric's
// "answers the question, uncontradicted".
export const MEASURES = ['declined_rightly', 'right_label', 'retrieved_any', 'retrieved_first', 'numbers', 'judged_correct', 'answers_uncontradicted'] as const;
export type Measure = (typeof MEASURES)[number];

// The measures split into thirds of wording overlap, in score.sh and compare.sh.
export const SPLIT_MEASURES = ['retrieved_first', 'retrieved_any', 'answers_uncontradicted'] as const satisfies readonly Measure[];

export type AnswersShares = { answersUncontradicted: Share; contradicts: Share; coverage: Record<Coverage, Share> };

export type OverlapScores = {
  // Answerable sampled questions with an overlap, and those with no content words (no overlap, in no third).
  questions: number;
  withoutContentWords: number;
  median: number | null;
  cuts: Cuts | null;
  thirds: { third: Third; name: string; questions: number; measures: Record<(typeof SPLIT_MEASURES)[number], Share> }[];
  // Each answerable question's overlap and third (numbers only).
  byQid: Record<string, { overlap: number | null; third: Third | null }>;
};

export type Effort = { count: number; median: number | null; p95: number | null };

export type Scores = {
  questions: number;
  outcomes: { completed: number; stopped: number; failed: number; callFailures: number };
  // Each distinct stop reason of a stopped or failed run (the agent's own sentence, written by its code), with how
  // many runs ended with it.
  stopReasons: { outcome: 'stopped' | 'failed'; reason: string; count: number }[];
  labelAnswers: Record<string, number>;
  declining: { refusalDeclined: Share; answerableAnswered: Share; declinedThatWereRefusal: Share };
  rightLabel: Share;
  // citedPassages: the cited passages the two measures read (each distinct passage of each answered question with
  // references), the precision's denominator. citedWithoutSection: those whose chunk has neither a section number nor
  // a title to match on, or is in no chunk at all; each counts as not matching in precision and can cite no
  // reference in recall.
  citations: { precision: Share; recall: Share; citedPassages: number; citedWithoutSection: number };
  retrieval: { anySearch: Share; firstSearch: Share };
  numbers: Share;
  effort: { searches: Effort; corrections: Effort; seconds: Effort; inputTokens: Effort; outputTokens: Effort };
  // Null when the run has not been judged.
  correctness: null | {
    judged: number;
    failures: number;
    // Questions left out of judging because their reference answer holds no letter (only section numbers and
    // punctuation): there is no fact in it to grade a reply against. Judgments stored for them are not counted.
    leftOut: number;
    byType: Record<string, { correct: Share; partlyCorrect: Share; incorrect: Share }>;
    all: { correct: Share; partlyCorrect: Share; incorrect: Share };
  };
  // Null when no person has filled in the check file.
  agreement: null | { judgeAndPersonAgree: Share };
  // The answers-question rubric; null when the run has not been judged under it.
  answersQuestion: null | {
    judged: number;
    failures: number;
    leftOut: number;
    byType: Record<string, AnswersShares>;
    all: AnswersShares;
  };
  // The judge and a person agree on "answers the question, uncontradicted"; null when no person has graded.
  answersAgreement: null | { judgeAndPersonAgree: Share };
  // The variant the run was made on, and the qids actually reworded (empty for the original variant).
  variant: Variant;
  rewordedQids: string[];
  // Null when no wording overlap was given.
  overlap: null | OverlapScores;
  perQuestion: Record<string, Partial<Record<Measure, boolean>>>;
};

export type ScoreInput = {
  questions: readonly Question[];
  records: readonly CallRecord[];
  // The section of each passage id, from the chunks the index was built from.
  sections: ReadonlyMap<string, Section>;
  judgments: readonly Judgment[] | null;
  // A person's verdicts, by qid, from the filled check file; null when there is none.
  personVerdicts: ReadonlyMap<string, Verdict> | null;
  // The answers-question rubric's judgments; absent or null when the run has not been judged under it.
  answersJudgments?: readonly AnswersJudgment[] | null;
  // A person's answers-question grading, as "answers the question, uncontradicted" by qid; absent or null when none.
  answersPersonChecks?: ReadonlyMap<string, boolean> | null;
  // Each answerable question's wording overlap (overlap.ts), null for one with no content words; absent or null when
  // not computed.
  overlap?: ReadonlyMap<string, number | null> | null;
  // The run's variant and the qids actually reworded; absent for the original sample.
  variant?: Variant;
  reworded?: ReadonlySet<string> | null;
};

const effortOf = (values: readonly number[]): Effort => ({ count: values.length, median: percentile(values, 50), p95: percentile(values, 95) });

const share = (pairs: readonly boolean[]): Share => wilson(pairs.filter(Boolean).length, pairs.length);

// The response of a question whose call succeeded, or null.
function responseOf(record: CallRecord | undefined): InvocationResponse | null {
  if (record === undefined || !record.ok) return null;
  const parsed = invocationResponseSchema.safeParse(record.response);
  return parsed.success ? parsed.data : null;
}

export const isRefusal = (question: Question): boolean => question.question_type === 'refusal';

// A reference answer with no letter in it (for example only "8.1, 8.2, 8.3") gives a judge no fact to grade against:
// such a question is not judged, and not counted in the correctness shares.
export const judgeable = (question: Question): boolean => /\p{L}/u.test(question.answer);

export function scoreRun(input: ScoreInput): Scores {
  const latest = latestByQid(input.records);
  const perQuestion: Scores['perQuestion'] = {};
  const outcomes = { completed: 0, stopped: 0, failed: 0, callFailures: 0 };
  const labelAnswers: Record<string, number> = {};
  const refusalDeclined: boolean[] = [];
  const answerableAnswered: boolean[] = [];
  let declinedTotal = 0;
  let declinedRefusal = 0;
  const rightLabel: boolean[] = [];
  const precision: boolean[] = [];
  const recall: boolean[] = [];
  let citedWithoutSection = 0;
  let leftOut = 0;
  const stopReasons = new Map<string, { outcome: 'stopped' | 'failed'; reason: string; count: number }>();
  const anySearch: boolean[] = [];
  const firstSearch: boolean[] = [];
  const numbers: boolean[] = [];
  const effort = { searches: [] as number[], corrections: [] as number[], seconds: [] as number[], inputTokens: [] as number[], outputTokens: [] as number[] };

  // A passage's section, or null when its chunk is unknown or has neither a number nor a title to match on.
  const sectionOf = (passage: string): Section | null => {
    const found = input.sections.get(passage);
    return found === undefined || (found.number === null && found.title === null) ? null : found;
  };

  for (const question of input.questions) {
    const record = latest.get(question.qid);
    const response = responseOf(record);
    const marks: Partial<Record<Measure, boolean>> = {};
    perQuestion[question.qid] = marks;
    if (response === null) outcomes.callFailures++;
    else outcomes[response.outcome]++;
    if (response !== null && response.outcome !== 'completed') {
      const reason = response.stop_reason ?? '(no reason given)';
      const key = `${response.outcome}\u0000${reason}`;
      const known = stopReasons.get(key);
      if (known === undefined) stopReasons.set(key, { outcome: response.outcome, reason, count: 1 });
      else known.count++;
    }
    const labelAnswer = response?.label_answer ?? 'none';
    labelAnswers[labelAnswer] = (labelAnswers[labelAnswer] ?? 0) + 1;

    const answered = response?.label_answer === 'answered';
    if (!isRefusal(question) && answered && !judgeable(question)) leftOut++;
    const declined = response?.label_answer !== undefined && response.label_answer !== 'answered';
    if (declined) {
      declinedTotal++;
      if (isRefusal(question)) declinedRefusal++;
    }
    if (isRefusal(question)) {
      refusalDeclined.push(declined);
      marks.declined_rightly = declined;
    } else {
      answerableAnswered.push(answered);
      marks.declined_rightly = answered;
    }

    if (answered && response !== null) {
      const right = response.citations.length > 0 && response.citations.every((citation) => citation.set_id === question.set_id);
      rightLabel.push(right);
      marks.right_label = right;
      if (!isRefusal(question) && question.references.length > 0) {
        const cited = new Map<string, Section | null>();
        for (const citation of response.citations) cited.set(citation.passage, sectionOf(citation.passage));
        const sections = [...cited.values()];
        citedWithoutSection += sections.filter((section) => section === null).length;
        for (const section of sections) precision.push(section !== null && sectionMatches(section, question.references));
        for (const reference of question.references) recall.push(sections.some((section) => section !== null && sectionMatches(section, [reference])));
      }
    }

    if (!isRefusal(question) && question.references.length > 0) {
      const searches = response === null ? [] : response.steps.filter((step) => step.kind === 'retrieval');
      const shownMatches = (search: (typeof searches)[number]): boolean =>
        search.kind === 'retrieval' &&
        search.hits.some((hit) => {
          if (!hit.shown) return false;
          const section = sectionOf(hit.passage);
          return section !== null && sectionMatches(section, question.references);
        });
      const any = searches.some(shownMatches);
      const first = searches[0] !== undefined && shownMatches(searches[0]);
      anySearch.push(any);
      firstSearch.push(first);
      marks.retrieved_any = any;
      marks.retrieved_first = first;
    }

    if (question.question_type === 'numeric' && answered && response !== null) {
      const wanted = numbersIn(question.answer);
      if (wanted.length > 0) {
        const written = new Set(numbersIn(response.reply));
        const all = wanted.every((number) => written.has(number));
        numbers.push(all);
        marks.numbers = all;
      }
    }

    if (response !== null) {
      effort.searches.push(response.steps.filter((step) => step.kind === 'retrieval').length);
      effort.corrections.push(response.steps.filter((step) => step.kind === 'tool' && (step.tool === 'answer' || step.tool === 'cannot_answer') && step.is_error).length);
      if (record !== undefined) effort.seconds.push(record.duration_ms / 1000);
      let inputTokens = 0;
      let outputTokens = 0;
      for (const step of response.steps) {
        if (step.kind !== 'model') continue;
        inputTokens += step.input_tokens ?? 0;
        outputTokens += step.output_tokens ?? 0;
      }
      effort.inputTokens.push(inputTokens);
      effort.outputTokens.push(outputTokens);
    }
  }

  let correctness: Scores['correctness'] = null;
  if (input.judgments !== null) {
    const byQid = new Map(input.judgments.map((judgment) => [judgment.qid, judgment]));
    // A question whose reference holds no letter is not graded: a judgment stored for it is not counted.
    const types = new Map(input.questions.filter(judgeable).map((question) => [question.qid, question.question_type]));
    const verdicts: { type: QuestionType; verdict: Verdict }[] = [];
    let failures = 0;
    for (const judgment of byQid.values()) {
      const type = types.get(judgment.qid);
      if (type === undefined) continue;
      if (!judgment.ok) {
        failures++;
        continue;
      }
      verdicts.push({ type, verdict: judgment.verdict });
      const marks = perQuestion[judgment.qid];
      if (marks !== undefined) marks.judged_correct = judgment.verdict === 'correct';
    }
    const shares = (list: readonly { verdict: Verdict }[]) => ({
      correct: share(list.map((item) => item.verdict === 'correct')),
      partlyCorrect: share(list.map((item) => item.verdict === 'partly_correct')),
      incorrect: share(list.map((item) => item.verdict === 'incorrect')),
    });
    const byType: Record<string, ReturnType<typeof shares>> = {};
    for (const type of QUESTION_TYPES) {
      if (type === 'refusal') continue;
      byType[type] = shares(verdicts.filter((item) => item.type === type));
    }
    correctness = { judged: verdicts.length, failures, leftOut, byType, all: shares(verdicts) };
  }

  let agreement: Scores['agreement'] = null;
  if (input.personVerdicts !== null && input.judgments !== null) {
    const graded = new Set(input.questions.filter(judgeable).map((question) => question.qid));
    const judged = new Map(input.judgments.flatMap((judgment) => (judgment.ok && graded.has(judgment.qid) ? [[judgment.qid, judgment.verdict] as const] : [])));
    const pairs: boolean[] = [];
    for (const [qid, person] of input.personVerdicts) {
      const judge = judged.get(qid);
      if (judge !== undefined) pairs.push(judge === person);
    }
    agreement = { judgeAndPersonAgree: share(pairs) };
  }

  // The answers-question rubric: the same questions are graded and left out as under completeness.
  let answersQuestion: Scores['answersQuestion'] = null;
  const answersJudgments = input.answersJudgments ?? null;
  if (answersJudgments !== null) {
    const byQid = new Map(answersJudgments.map((judgment) => [judgment.qid, judgment]));
    const types = new Map(input.questions.filter(judgeable).map((question) => [question.qid, question.question_type]));
    const graded: { type: QuestionType; uncontradicted: boolean; contradicts: boolean; coverage: Coverage }[] = [];
    let failures = 0;
    for (const judgment of byQid.values()) {
      const type = types.get(judgment.qid);
      if (type === undefined) continue;
      if (!judgment.ok) {
        failures++;
        continue;
      }
      const uncontradicted = answersUncontradicted(judgment);
      graded.push({ type, uncontradicted, contradicts: judgment.contradicts, coverage: judgment.coverage });
      const marks = perQuestion[judgment.qid];
      if (marks !== undefined) marks.answers_uncontradicted = uncontradicted;
    }
    const shares = (list: readonly (typeof graded)[number][]): AnswersShares => ({
      answersUncontradicted: share(list.map((item) => item.uncontradicted)),
      contradicts: share(list.map((item) => item.contradicts)),
      coverage: { all: share(list.map((item) => item.coverage === 'all')), some: share(list.map((item) => item.coverage === 'some')), none: share(list.map((item) => item.coverage === 'none')) },
    });
    const byType: Record<string, AnswersShares> = {};
    for (const type of QUESTION_TYPES) {
      if (type === 'refusal') continue;
      byType[type] = shares(graded.filter((item) => item.type === type));
    }
    answersQuestion = { judged: graded.length, failures, leftOut, byType, all: shares(graded) };
  }

  let answersAgreement: Scores['answersAgreement'] = null;
  const answersPerson = input.answersPersonChecks ?? null;
  if (answersPerson !== null && answersJudgments !== null) {
    const graded = new Set(input.questions.filter(judgeable).map((question) => question.qid));
    const judged = new Map(answersJudgments.flatMap((judgment) => (judgment.ok && graded.has(judgment.qid) ? [[judgment.qid, answersUncontradicted(judgment)] as const] : [])));
    const pairs: boolean[] = [];
    for (const [qid, person] of answersPerson) {
      const judge = judged.get(qid);
      if (judge !== undefined) pairs.push(judge === person);
    }
    answersAgreement = { judgeAndPersonAgree: share(pairs) };
  }

  let overlap: Scores['overlap'] = null;
  if (input.overlap !== undefined && input.overlap !== null) {
    const given = input.overlap;
    const answerable = input.questions.filter((question) => !isRefusal(question));
    const values = answerable.flatMap((question) => {
      const value = given.get(question.qid);
      return value === undefined || value === null ? [] : [value];
    });
    const cuts = thirdCuts(values);
    const byQid: OverlapScores['byQid'] = {};
    for (const question of answerable) {
      const value = given.get(question.qid) ?? null;
      byQid[question.qid] = { overlap: value, third: value === null || cuts === null ? null : thirdOf(value, cuts) };
    }
    const thirds = ([1, 2, 3] as const).map((third) => {
      const members = answerable.filter((question) => byQid[question.qid]?.third === third);
      const measureShare = (measure: (typeof SPLIT_MEASURES)[number]): Share =>
        share(members.flatMap((question) => {
          const mark = perQuestion[question.qid]?.[measure];
          return mark === undefined ? [] : [mark];
        }));
      return {
        third,
        name: THIRD_NAMES[third],
        questions: members.length,
        measures: { retrieved_first: measureShare('retrieved_first'), retrieved_any: measureShare('retrieved_any'), answers_uncontradicted: measureShare('answers_uncontradicted') },
      };
    });
    overlap = { questions: values.length, withoutContentWords: answerable.length - values.length, median: percentile(values, 50), cuts, thirds, byQid };
  }

  return {
    questions: input.questions.length,
    outcomes,
    stopReasons: [...stopReasons.values()].sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)),
    labelAnswers,
    declining: {
      refusalDeclined: share(refusalDeclined),
      answerableAnswered: share(answerableAnswered),
      declinedThatWereRefusal: wilson(declinedRefusal, declinedTotal),
    },
    rightLabel: share(rightLabel),
    citations: { precision: share(precision), recall: share(recall), citedPassages: precision.length, citedWithoutSection },
    retrieval: { anySearch: share(anySearch), firstSearch: share(firstSearch) },
    numbers: share(numbers),
    effort: {
      searches: effortOf(effort.searches),
      corrections: effortOf(effort.corrections),
      seconds: effortOf(effort.seconds),
      inputTokens: effortOf(effort.inputTokens),
      outputTokens: effortOf(effort.outputTokens),
    },
    correctness,
    agreement,
    answersQuestion,
    answersAgreement,
    variant: input.variant ?? 'original',
    rewordedQids: [...(input.reworded ?? [])].sort(),
    overlap,
    perQuestion,
  };
}
