// The evaluation harness's runs and, for the one chosen, its figures: identifiers, verdicts, counts and shares only,
// never a question, an answer, a reply or a reason. Shares are written as the harness's own table writes them.

import { useState } from 'react';

import type { AttackVerdict, EvaluationRow, EvaluationRunResponse, EvaluationShare } from '../../../shared/api.ts';
import { formatDateTime } from '../format.ts';
import { useLabEvaluation, useLabEvaluationRun } from './api.ts';
import { Empty, Failed, Loading } from './parts.tsx';

const KIND_TEXT = { benchmark: 'Benchmark', attack: 'Attack' } as const;
const VERDICT_TEXT: Record<AttackVerdict, string> = { held: 'Held', failed: 'Failed', inconclusive: 'Inconclusive', not_run: 'Not run' };

const pct = (value: number | null): string => (value === null ? '-' : `${(value * 100).toFixed(1)}%`);

// As evaluation/src/stats.ts's formatShare writes a share.
function shareText(share: EvaluationShare): string {
  if (share.share === null) return '0 of 0';
  return `${share.numerator} of ${share.denominator} = ${pct(share.share)} [${pct(share.low)}, ${pct(share.high)}]${share.too_few ? ' (too few to read)' : ''}`;
}

function rowText(row: EvaluationRow): string {
  switch (row.kind) {
    case 'share':
      return shareText(row.share);
    case 'count':
      return String(row.count);
    case 'effort':
      return `median ${row.median === null ? '-' : String(Math.round(row.median * 10) / 10)}, 95th percentile ${row.p95 === null ? '-' : String(Math.round(row.p95 * 10) / 10)} (over ${row.count})`;
    case 'fraction':
      return pct(row.value);
    case 'not_judged':
      return 'not judged';
  }
}

export function EvaluationPage() {
  const list = useLabEvaluation();
  const [picked, setPicked] = useState<string | null>(null);
  const runs = list.data?.runs ?? [];
  const chosen = picked !== null && runs.some((run) => run.id === picked) ? picked : (runs[0]?.id ?? null);

  return (
    <>
      <div className="lab-intro">
        <div>
          <h1>Evaluation</h1>
          <p className="lab-lede">
            The runs the evaluation harness wrote, newest first, and the figures of the one chosen, as its own table reports
            them. Only identifiers, verdicts, counts and shares are shown: no question, answer, reply or reason.
          </p>
        </div>
      </div>
      {list.isPending ? <Loading what="the evaluation runs" /> : null}
      {list.isError ? <Failed what="the evaluation runs" error={list.error} /> : null}
      {list.data === undefined ? null : list.data.data !== 'found' || runs.length === 0 ? (
        <Empty>
          {list.data.data === 'not_configured' ? 'The data folder is not set up (EVALUATION_DATA_DIR), so no run can be read. ' : 'No evaluation run has been made. '}
          Make one with <span className="lab-mono">evaluation/run.sh</span> and then{' '}
          <span className="lab-mono">evaluation/score.sh</span>, or <span className="lab-mono">evaluation/attacks.sh</span> (evaluation/README.md).
        </Empty>
      ) : (
        <section className="lab-panel" aria-labelledby="lab-runs-title">
          <h2 id="lab-runs-title">Runs</h2>
          <div className="lab-scroll">
            <table className="lab-table">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Written</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className={run.id === chosen ? 'lab-row--current' : undefined}>
                    <th scope="row">
                      <button type="button" className="lab-linkbutton lab-mono" aria-pressed={run.id === chosen} onClick={() => setPicked(run.id)}>
                        {run.name}
                      </button>
                    </th>
                    <td>{KIND_TEXT[run.kind]}</td>
                    <td className="lab-mono">{formatDateTime(run.written_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {list.data !== undefined && list.data.skipped.length > 0 ? (
        <section className="lab-panel" aria-labelledby="lab-skipped-title">
          <h2 id="lab-skipped-title">Files not read</h2>
          <ul className="lab-list">
            {list.data.skipped.map((item) => (
              <li key={item.file}>
                <span className="lab-mono">{item.file}</span>: {item.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {chosen === null ? null : <RunFigures runId={chosen} />}
    </>
  );
}

function RunFigures({ runId }: { runId: string }) {
  const run = useLabEvaluationRun(runId);
  if (run.isPending) return <Loading what="the run's figures" />;
  if (run.isError) return <Failed what="the run's figures" error={run.error} />;
  return run.data.kind === 'benchmark' ? <Benchmark run={run.data} /> : <Attack run={run.data} />;
}

function Facts({ facts }: { facts: readonly (readonly [string, string])[] }) {
  return (
    <dl className="lab-facts">
      {facts.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Benchmark({ run }: { run: Extract<EvaluationRunResponse, { kind: 'benchmark' }> }) {
  const facts: [string, string][] = [
    ['Run', run.name],
    ['Agent', run.run?.agent_id ?? 'not recorded'],
    ['Models', run.run === null || run.run.models.length === 0 ? 'not recorded' : run.run.models.join(', ')],
    ['Strategies', run.run === null || run.run.strategies.length === 0 ? 'not recorded' : run.run.strategies.join(', ')],
    ['Sample variant', run.variant],
    ['Started', run.run === null ? 'not recorded' : formatDateTime(run.run.started_at)],
    ['Ended', run.run?.ended_at == null ? 'not recorded' : formatDateTime(run.run.ended_at)],
  ];
  return (
    <section className="lab-panel" aria-labelledby="lab-figures-title">
      <h2 id="lab-figures-title">Figures of {run.name}</h2>
      <Facts facts={facts} />
      <p className="lab-note">
        A share reads numerator of denominator = share [95% Wilson interval]; over fewer than 20 items it is marked too few to
        read (evaluation/README.md, &ldquo;Reading the table&rdquo;).
      </p>
      {run.groups.map((group) => (
        <div key={group.name}>
          <h3 className="lab-subhead">{group.name}</h3>
          <div className="lab-scroll">
            <table className="lab-table">
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  <th scope="col" className="lab-table__num">
                    Figure
                  </th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.name}>
                    <th scope="row">{row.name}</th>
                    <td className="lab-mono lab-table__num">{rowText(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

function Attack({ run }: { run: Extract<EvaluationRunResponse, { kind: 'attack' }> }) {
  const verdicts: AttackVerdict[] = ['held', 'failed', 'inconclusive', 'not_run'];
  return (
    <section className="lab-panel" aria-labelledby="lab-figures-title">
      <h2 id="lab-figures-title">Figures of {run.name}</h2>
      <Facts facts={[['Cases', String(run.cases.length)], ...verdicts.map((verdict) => [VERDICT_TEXT[verdict], String(run.totals[verdict])] as const)]} />
      <div className="lab-scroll">
        <table className="lab-table">
          <thead>
            <tr>
              <th scope="col">Case</th>
              <th scope="col">Class</th>
              <th scope="col">Target</th>
              <th scope="col">Decided by</th>
              <th scope="col">Verdict</th>
              <th scope="col">Expectations not held</th>
            </tr>
          </thead>
          <tbody>
            {run.cases.map((item) => (
              <tr key={item.id}>
                <th scope="row" className="lab-mono">
                  {item.id}
                </th>
                <td className="lab-mono">{item.class}</td>
                <td className="lab-mono">{item.target}</td>
                <td>{item.decided_by}</td>
                <td>
                  <span className={`lab-tag lab-tag--${item.verdict === 'held' ? 'good' : 'bad'}`}>{VERDICT_TEXT[item.verdict]}</span>
                </td>
                <td className="lab-mono">
                  {item.failed.length === 0
                    ? '—'
                    : item.failed.map((f) => `${f.kind}${f.scope === null ? '' : ` (${f.scope})`}, by ${f.decided_by}`).join('; ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
