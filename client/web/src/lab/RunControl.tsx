// A choice of agent and a "Run" button: runs a message through the agent chosen, as the lab explorer, then
// opens the run. With `withAll`, the first choice runs it through every agent, one after another, and opens the
// first of those runs.

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import type { AgentInfo } from '../../../shared/api.ts';
import { PartlyStarted, failureText, useLabAgents, useRunThrough } from './api.ts';
import type { LabMessage } from './api.ts';

const ALL = '';

function runPath(runId: string): string {
  return `/lab/runs/${encodeURIComponent(runId)}`;
}

export function RunControl({
  id,
  label,
  message,
  withAll,
  preferred,
}: {
  id: string;
  label: string;
  message: LabMessage;
  withAll: boolean;
  // The agent chosen at first when there is no "All agents" choice, if it is one of the agents.
  preferred?: string;
}) {
  const agents = useLabAgents();
  const run = useRunThrough();
  const navigate = useNavigate();
  const [picked, setPicked] = useState<string | null>(null);

  const list: readonly AgentInfo[] = agents.data?.agents ?? [];
  const fallback = withAll ? ALL : (list.find((agent) => agent.id === preferred) ?? list[0])?.id ?? ALL;
  const chosen = picked ?? fallback;
  const ready = list.length > 0 && !run.isPending;

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!ready) {
      return;
    }
    const agentIds = chosen === ALL ? list.map((agent) => agent.id) : [chosen];
    run.mutate({ agentIds, message }, { onSuccess: (first) => void navigate(runPath(first.run_id)) });
  }

  return (
    <form className="lab-run" onSubmit={submit}>
      <label htmlFor={id} className="lab-run__label">
        {label}
      </label>
      <div className="lab-run__controls">
        <select
          id={id}
          className="lab-select"
          value={chosen}
          disabled={list.length === 0}
          onChange={(event) => setPicked(event.target.value)}
        >
          {withAll ? <option value={ALL}>All agents</option> : null}
          {list.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name} ({agent.id})
            </option>
          ))}
        </select>
        <button type="submit" className="lab-button" disabled={!ready}>
          {run.isPending ? 'Sending…' : 'Run'}
        </button>
      </div>
      {agents.isPending ? (
        <p className="lab-note" role="status">
          Reading the agents…
        </p>
      ) : null}
      {agents.isError ? (
        <div className="lab-failed" role="alert">
          <p className="lab-failed__title">Could not read the agents, so nothing can be run.</p>
          <p>{failureText(agents.error)}</p>
        </div>
      ) : null}
      {agents.data !== undefined && list.length === 0 ? (
        <p className="lab-note">No agent is configured, so nothing can be run.</p>
      ) : null}
      {run.isError ? (
        <div className="lab-failed" role="alert">
          <p className="lab-failed__title">
            {run.error instanceof PartlyStarted ? 'Not every run was started.' : 'The run was not started.'}
          </p>
          <p>{failureText(run.error)}</p>
          {run.error instanceof PartlyStarted ? (
            <p>
              <Link to={runPath(run.error.first.run_id)}>Open the first run</Link>
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
