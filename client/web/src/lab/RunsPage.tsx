// Every run by anyone, newest first.

import { Link } from 'react-router';

import { formatDateTime, formatDuration } from '../format.ts';
import { useLabAgents, useLabRuns } from './api.ts';
import { Empty, Failed, Loading, ResultTag } from './parts.tsx';

export function RunsPage() {
  const runs = useLabRuns();
  const agents = useLabAgents();
  const agentName = new Map((agents.data?.agents ?? []).map((agent) => [agent.id, agent.name]));

  return (
    <>
      <div className="lab-intro">
        <div>
          <h1>Runs</h1>
          <p className="lab-lede">
            Every run by every person, newest first. Open one by its agent to see each step on a time axis.
          </p>
        </div>
      </div>

      {runs.isPending ? <Loading what="the runs" /> : null}
      {runs.isError ? <Failed what="the runs" error={runs.error} /> : null}
      {runs.data === undefined ? null : runs.data.traces.length === 0 ? (
        <Empty>No run is recorded yet. Send an inquiry from the desk, and its run appears here.</Empty>
      ) : (
        <div className="lab-panel">
          <div className="lab-scroll">
            <table className="lab-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Started by</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Result</th>
                  <th scope="col" className="lab-table__num">
                    Time taken
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.data.traces.map((trace) => (
                  <tr key={trace.run_id}>
                    <td className="lab-mono">{formatDateTime(trace.started_at)}</td>
                    <td>{trace.started_by?.name ?? 'Not recorded'}</td>
                    <th scope="row">
                      <Link to={`/lab/runs/${encodeURIComponent(trace.run_id)}`}>
                        {agentName.get(trace.agent_id) ?? trace.agent_id}
                      </Link>
                      <span className="lab-mono lab-table__sub">{trace.agent_id}</span>
                    </th>
                    <td>
                      <ResultTag state={trace.state} outcome={trace.outcome} />
                    </td>
                    <td className="lab-mono lab-table__num">
                      {trace.duration_ms === null ? '—' : formatDuration(trace.duration_ms)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {runs.data.truncated ? (
            <p className="lab-note">Only the newest runs the server gives are listed; older ones are left out.</p>
          ) : null}
        </div>
      )}
    </>
  );
}
