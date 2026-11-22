// Two runs on the same sample, question by question: for each yes-or-no measure, both right, only A, only B,
// neither, and the exact two-sided sign test on the two middle counts.

import { MEASURES } from './score.ts';
import type { Measure, Scores } from './score.ts';
import { signTest } from './stats.ts';

export type Paired = { measure: Measure; questions: number; both: number; onlyA: number; onlyB: number; neither: number; signTestP: number };

export function compareScores(a: Pick<Scores, 'perQuestion'>, b: Pick<Scores, 'perQuestion'>): Paired[] {
  return MEASURES.map((measure) => {
    let both = 0;
    let onlyA = 0;
    let onlyB = 0;
    let neither = 0;
    for (const [qid, marks] of Object.entries(a.perQuestion)) {
      const x = marks[measure];
      const y = b.perQuestion[qid]?.[measure];
      if (x === undefined || y === undefined) continue;
      if (x && y) both++;
      else if (x) onlyA++;
      else if (y) onlyB++;
      else neither++;
    }
    return { measure, questions: both + onlyA + onlyB + neither, both, onlyA, onlyB, neither, signTestP: signTest(onlyA, onlyB) };
  });
}

export function formatComparison(nameA: string, nameB: string, rows: readonly Paired[]): string[] {
  const lines = [`${'measure'.padEnd(18)} ${'n'.padStart(4)} ${'both'.padStart(5)} ${`only ${nameA}`.padStart(12)} ${`only ${nameB}`.padStart(12)} ${'neither'.padStart(8)}  sign test p`];
  for (const row of rows) {
    lines.push(
      `${row.measure.padEnd(18)} ${String(row.questions).padStart(4)} ${String(row.both).padStart(5)} ${String(row.onlyA).padStart(12)} ${String(row.onlyB).padStart(12)} ${String(row.neither).padStart(8)}  ${row.questions === 0 ? '-' : row.signTestP.toFixed(4)}`,
    );
  }
  return lines;
}
