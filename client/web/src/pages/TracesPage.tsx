// Every person's runs, and one run's message and steps. Shown only to a session that may read traces.

import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';

import { ApiFailure, failureText, useTrace, useTraces } from '../api.ts';
import { Empty, Loading, Message, Problem, RunBadge } from '../components.tsx';
import { formatDateTime, formatDuration } from '../format.ts';
import { RunResult } from '../RunResult.tsx';
import { RunLedger } from './RunLedger.tsx';

function TraceList() {
  const traces = useTraces();

  return (
    <div className="column column--wide">
      <header className="pagehead">
        <h1>Traces</h1>
        <p className="pagehead__lead">
          Every run of an agent, by anyone, newest first. Open one to read the message it was given and every step
          the agent took.
        </p>
      </header>

      {traces.isPending ? <Loading what="traces" /> : null}
      {traces.isError ? <Problem>{failureText(traces.error)}</Problem> : null}

      {traces.data === undefined ? null : traces.data.traces.length === 0 ? (
        <Empty title="No runs yet">
          <p>A run appears here when someone sends an inquiry to an agent.</p>
        </Empty>
      ) : (
        <>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Result</th>
                  <th scope="col">Outcome</th>
                  <th scope="col" className="num">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {traces.data.traces.map((trace) => (
                  <tr key={trace.run_id}>
                    <th scope="row" className="nowrap">
                      <Link to={`/traces/${encodeURIComponent(trace.run_id)}`}>{formatDateTime(trace.started_at)}</Link>
                    </th>
                    <td>{trace.started_by?.name ?? <span className="absent">Not recorded</span>}</td>
                    <td>{trace.agent_id}</td>
                    <td>
                      <RunBadge state={trace.state} />
                    </td>
                    <td>{trace.outcome ?? '—'}</td>
                    <td className="num">{trace.duration_ms === null ? '—' : formatDuration(trace.duration_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {traces.data.truncated ? <p className="footnote">Showing the 100 newest runs.</p> : null}
        </>
      )}
    </div>
  );
}

function TraceDetail({ runId }: { runId: string }) {
  const trace = useTrace(runId);
  const back = (
    <Link to="/traces" className="back">
      <ArrowLeft size={16} aria-hidden="true" /> All traces
    </Link>
  );

  if (trace.isPending) {
    return (
      <div className="column column--wide">
        {back}
        <Loading what="the trace" />
      </div>
    );
  }
  if (trace.isError) {
    const missing = trace.error instanceof ApiFailure && trace.error.status === 404;
    return (
      <div className="column column--wide">
        {back}
        <Problem>{missing ? 'There is no such run.' : failureText(trace.error)}</Problem>
      </div>
    );
  }

  const { inquiry, run } = trace.data;
  return (
    <div className="column column--wide">
      {back}
      <div className="reading">
        <div className="reading__thread">
          <Message inquiry={inquiry} />
          <header className="runhead">
            <h2>{run.agent_id}</h2>
            <RunBadge state={run.state} />
          </header>
          <p className="message__when">
            Started {formatDateTime(run.started_at)}
            {run.started_by === null ? '' : ` by ${run.started_by.name}`}
            {run.response === null ? '' : `. Outcome: ${run.response.outcome}`}.
          </p>
          <RunResult run={run} />
        </div>
        <aside className="reading__ledger" aria-label="What the agent did">
          <RunLedger run={run} />
        </aside>
      </div>
    </div>
  );
}

export function TracesPage() {
  const { runId } = useParams();
  return runId === undefined ? <TraceList /> : <TraceDetail key={runId} runId={runId} />;
}
