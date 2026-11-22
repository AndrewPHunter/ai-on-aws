// Two runs on the same set of questions, question by question: for each yes-or-no measure, both right, only A, only
// B, neither, and the exact two-sided sign test on the two middle counts. Optionally restricted to a set of qids (the
// questions actually reworded), and split into the thirds of wording overlap of run A's scores.

import { THIRD_NAMES } from './overlap.ts';
import type { Third } from './overlap.ts';
import { MEASURES, SPLIT_MEASURES } from './score.ts';
import type { Measure, Scores } from './score.ts';
import { signTest } from './stats.ts';

export type Paired = { measure: Measure; questions: number; both: number; onlyA: number; onlyB: number; neither: number; signTestP: number };

function pair(measure: Measure, a: Pick<Scores, 'perQuestion'>, b: Pick<Scores, 'perQuestion'>, keep: (qid: string) => boolean): Paired {
  let both = 0;
  let onlyA = 0;
  let onlyB = 0;
  let neither = 0;
  for (const [qid, marks] of Object.entries(a.perQuestion)) {
    if (!keep(qid)) continue;
    const x = marks[measure];
    const y = b.perQuestion[qid]?.[measure];
    if (x === undefined || y === undefined) continue;
    if (x && y) both++;
    else if (x) onlyA++;
    else if (y) onlyB++;
    else neither++;
  }
  return { measure, questions: both + onlyA + onlyB + neither, both, onlyA, onlyB, neither, signTestP: signTest(onlyA, onlyB) };
}

export function compareScores(a: Pick<Scores, 'perQuestion'>, b: Pick<Scores, 'perQuestion'>, only: ReadonlySet<string> | null = null): Paired[] {
  return MEASURES.map((measure) => pair(measure, a, b, (qid) => only === null || only.has(qid)));
}

export type ThirdPaired = { third: Third; name: string; questions: number; rows: Paired[] };

// The split measures' paired counts within each third of run A's wording overlap.
export function compareByThird(a: Pick<Scores, 'perQuestion' | 'overlap'>, b: Pick<Scores, 'perQuestion'>, only: ReadonlySet<string> | null = null): ThirdPaired[] | null {
  const overlap = a.overlap;
  if (overlap === null) return null;
  return ([1, 2, 3] as const).map((third) => {
    const keep = (qid: string): boolean => overlap.byQid[qid]?.third === third && (only === null || only.has(qid));
    return { third, name: THIRD_NAMES[third], questions: Object.keys(overlap.byQid).filter(keep).length, rows: SPLIT_MEASURES.map((measure) => pair(measure, a, b, keep)) };
  });
}

export function formatComparison(nameA: string, nameB: string, rows: readonly Paired[]): string[] {
  const lines = [`${'measure'.padEnd(22)} ${'n'.padStart(4)} ${'both'.padStart(5)} ${`only ${nameA}`.padStart(12)} ${`only ${nameB}`.padStart(12)} ${'neither'.padStart(8)}  sign test p`];
  for (const row of rows) {
    lines.push(
      `${row.measure.padEnd(22)} ${String(row.questions).padStart(4)} ${String(row.both).padStart(5)} ${String(row.onlyA).padStart(12)} ${String(row.onlyB).padStart(12)} ${String(row.neither).padStart(8)}  ${row.questions === 0 ? '-' : row.signTestP.toFixed(4)}`,
    );
  }
  return lines;
}
