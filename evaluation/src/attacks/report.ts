// The table an attack run prints, and its exit code, from the judged cases. Counts, never rates; ids and kinds only.
//
// A case is counted once for each decider of its expectations, so cases decided by code and by a model are counted
// apart; a `work` case is counted once for its reply scope and once for its record scope. Such a part is held when
// the case's precondition was met and every expectation of the part holds; a case that was inconclusive or not run
// is so in each of its parts.

import type { ExpectationResult, Judgment, Verdict } from './judge.ts';
import { deciderOf } from './set.ts';
import type { AttackCase, Decider } from './set.ts';

export type Judged = { attack: AttackCase; judgment: Judgment };
type Part = { decided_by: Decider; scope: '' | 'reply' | 'record'; verdict: Verdict };

function partsOf({ attack, judgment }: Judged): Part[] {
  const keys = new Map<string, Part>();
  // A case that was not judged on its expectations (inconclusive, not run) still has its parts.
  const results: ExpectationResult[] =
    judgment.expectations.length > 0
      ? judgment.expectations
      : attack.expectations.map((x) => ({ kind: x.kind, ...(x.kind === 'absent' ? { scope: x.scope } : {}), decided_by: deciderOf(attack, x), holds: true }));
  for (const e of results) {
    const scope = attack.class === 'work' && e.scope !== undefined ? e.scope : '';
    const key = `${e.decided_by} ${scope}`;
    const verdict: Verdict =
      judgment.verdict === 'held' || judgment.verdict === 'failed' ? (keys.get(key)?.verdict === 'failed' || !e.holds ? 'failed' : 'held') : judgment.verdict;
    keys.set(key, { decided_by: e.decided_by, scope, verdict });
  }
  return [...keys.values()];
}

/** The lines of the table, then the ids of the code-decided cases and the controls that did not hold, then the claim findings. */
export function formatTable(judged: readonly Judged[]): string[] {
  const rows = new Map<string, Record<Verdict, number>>();
  const notHeld: string[] = [];
  for (const item of judged) {
    for (const part of partsOf(item)) {
      const name = `${item.attack.class} ${item.attack.target}${part.scope === '' ? '' : ` (${part.scope})`}, decided by ${part.decided_by}`;
      const row = rows.get(name) ?? { held: 0, failed: 0, inconclusive: 0, not_run: 0 };
      row[part.verdict] += 1;
      rows.set(name, row);
      if (part.verdict !== 'held' && (part.decided_by === 'code' || item.attack.class === 'control')) {
        notHeld.push(`${item.attack.id}${part.scope === '' ? '' : ` (${part.scope})`}: ${part.verdict}`);
      }
    }
  }
  const lines = ['class target, decider: held, failed, inconclusive, not run'];
  for (const [name, row] of [...rows].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`${name}: ${row.held}, ${row.failed}, ${row.inconclusive}, ${row.not_run}`);
  }
  lines.push(`decided by code, or a control, and not held: ${notHeld.length}`, ...[...new Set(notHeld)].map((line) => `  ${line}`));
  const findings = judged.flatMap(({ attack, judgment }) =>
    judgment.findings.map((f) => `  ${attack.id}: ${f.kind}${'case_id' in f ? ` ${f.case_id}` : ''}${'action' in f ? ` (${f.action}, run ${f.run})` : ''}`),
  );
  lines.push(`claims against the truth, findings: ${findings.length}`, ...findings);
  return lines;
}

/** 0 when every part decided by code held and every control held; 1 otherwise. */
export const exitCodeOf = (judged: readonly Judged[]): 0 | 1 =>
  judged.every((item) => partsOf(item).every((part) => part.verdict === 'held' || (part.decided_by === 'model' && item.attack.class !== 'control'))) ? 0 : 1;
