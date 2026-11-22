// The score table as printed: counts and shares only, never a question, an answer or a reply.

import type { Third } from './overlap.ts';
import type { Effort, Scores } from './score.ts';
import { formatShare } from './stats.ts';
import type { Share } from './stats.ts';

const row = (name: string, share: Share): string => `  ${name.padEnd(46)} ${formatShare(share)}`;
const effortRow = (name: string, effort: Effort): string =>
  `  ${name.padEnd(46)} median ${effort.median === null ? '-' : String(Math.round(effort.median * 10) / 10)}, 95th percentile ${effort.p95 === null ? '-' : String(Math.round(effort.p95 * 10) / 10)} (over ${effort.count})`;

export function formatScores(scores: Scores): string[] {
  const lines = [`questions: ${scores.questions}`];
  const o = scores.outcomes;
  lines.push(`outcomes: completed ${o.completed}, stopped ${o.stopped}, failed ${o.failed}, call failures ${o.callFailures}`);
  // The agent's own stop reasons: sentences its code writes, holding no label text.
  for (const { outcome, reason, count } of scores.stopReasons) lines.push(`  ${outcome} ${count}: ${reason}`);
  lines.push(`label answers: ${Object.entries(scores.labelAnswers).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, count]) => `${name} ${count}`).join(', ')}`);
  lines.push('declining:');
  lines.push(row('refusal questions declined', scores.declining.refusalDeclined));
  lines.push(row('answerable questions answered', scores.declining.answerableAnswered));
  lines.push(row('declined questions that were refusal questions', scores.declining.declinedThatWereRefusal));
  lines.push('answers:');
  lines.push(row('answered, every citation from the right label', scores.rightLabel));
  lines.push(row('cited sections that match a reference', scores.citations.precision));
  lines.push(row('references cited', scores.citations.recall));
  lines.push(
    `  of the ${scores.citations.citedPassages} cited passages above, ${scores.citations.citedWithoutSection} have neither a section number nor a title to match on (or are in no chunk): each counts as not matching, and cites no reference`,
  );
  lines.push(row('numeric answered, every reference number given', scores.numbers));
  lines.push('retrieval:');
  lines.push(row('a referenced section shown, in any search', scores.retrieval.anySearch));
  lines.push(row('a referenced section shown, in the first search', scores.retrieval.firstSearch));
  lines.push('effort, per question with a response:');
  lines.push(effortRow('searches', scores.effort.searches));
  lines.push(effortRow('corrections', scores.effort.corrections));
  lines.push(effortRow('seconds', scores.effort.seconds));
  lines.push(effortRow('tokens in', scores.effort.inputTokens));
  lines.push(effortRow('tokens out', scores.effort.outputTokens));
  // Every rubric that has judgments is reported; with none, one line says so.
  if (scores.correctness === null && (scores.answersQuestion ?? null) === null) lines.push('correctness: not judged');
  if (scores.answersQuestion !== null && scores.answersQuestion !== undefined) {
    const answers = scores.answersQuestion;
    lines.push(`rubric answers-question (judged ${answers.judged}, judge failures ${answers.failures}):`);
    if (answers.leftOut > 0) {
      lines.push(`  left out of judging: ${answers.leftOut} answered questions whose reference answer holds no letter (only section numbers), so gives no fact to grade against`);
    }
    for (const [name, shares] of [['all', answers.all], ...Object.entries(answers.byType)] as const) {
      lines.push(row(`${name}: answers the question, uncontradicted`, shares.answersUncontradicted));
      lines.push(row(`${name}: contradicts the reference`, shares.contradicts));
      lines.push(row(`${name}: covers all of the reference`, shares.coverage.all));
      lines.push(row(`${name}: covers some of the reference`, shares.coverage.some));
      lines.push(row(`${name}: covers none of the reference`, shares.coverage.none));
    }
    if (scores.answersAgreement !== null) lines.push(row('the judge agrees with the person (answers, uncontradicted)', scores.answersAgreement.judgeAndPersonAgree));
  }
  if (scores.correctness !== null) {
    lines.push(`correctness, rubric completeness (judged ${scores.correctness.judged}, judge failures ${scores.correctness.failures}):`);
    if (scores.correctness.leftOut > 0) {
      lines.push(`  left out of judging: ${scores.correctness.leftOut} answered questions whose reference answer holds no letter (only section numbers), so gives no fact to grade against`);
    }
    const all = scores.correctness.all;
    lines.push(row('all: correct', all.correct));
    lines.push(row('all: partly correct', all.partlyCorrect));
    lines.push(row('all: incorrect', all.incorrect));
    for (const [type, shares] of Object.entries(scores.correctness.byType)) {
      lines.push(row(`${type}: correct`, shares.correct));
      lines.push(row(`${type}: partly correct`, shares.partlyCorrect));
      lines.push(row(`${type}: incorrect`, shares.incorrect));
    }
  }
  if (scores.agreement !== null) lines.push(row('the judge agrees with the person', scores.agreement.judgeAndPersonAgree));
  lines.push(...formatOverlap(scores));
  return lines;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

// The run's variant, and the measures split into thirds by wording overlap, with the cut points and each third's size.
export function formatOverlap(scores: Pick<Scores, 'variant' | 'rewordedQids' | 'overlap' | 'answersQuestion'>): string[] {
  const lines = [`sample variant: ${scores.variant}${scores.variant === 'reworded' ? ` (${scores.rewordedQids.length} questions reworded)` : ''}`];
  const overlap = scores.overlap;
  if (overlap === null) return lines;
  lines.push(
    `wording overlap (the share of an answerable question's content words found in its benchmark context): ${overlap.questions} questions, median ${overlap.median === null ? '-' : pct(overlap.median)}; ${overlap.withoutContentWords} with no content words, in no third`,
  );
  if (overlap.cuts === null) return lines;
  const { low, high } = overlap.cuts;
  const ranges: Record<Third, string> = { 1: `0% to ${pct(low)}`, 2: `above ${pct(low)} to ${pct(high)}`, 3: `above ${pct(high)}` };
  lines.push(`  thirds cut at ${pct(low)} and ${pct(high)} (the sample's own values; a tie at a cut falls to the lower third)`);
  for (const third of overlap.thirds) {
    lines.push(`  ${third.name} (${ranges[third.third]}, ${third.questions} questions):`);
    lines.push(row(`  a referenced section shown, first search`, third.measures.retrieved_first));
    lines.push(row(`  a referenced section shown, any search`, third.measures.retrieved_any));
    lines.push(scores.answersQuestion === null ? `    answers the question, uncontradicted: not judged` : row(`  answers the question, uncontradicted`, third.measures.answers_uncontradicted));
  }
  return lines;
}
