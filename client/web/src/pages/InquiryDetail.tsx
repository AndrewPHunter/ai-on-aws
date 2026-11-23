import { useState } from 'react';

import type { AgentInfo, Inquiry } from '../../../shared/api.ts';
import { ApiFailure, failureText, useAgents, useInquiry, useSendAgain } from '../api.ts';
import { Loading, Message, Problem, RunBadge } from '../components.tsx';
import { formatDuration } from '../format.ts';
import { RunResult } from '../RunResult.tsx';

function agentName(agents: readonly AgentInfo[], id: string): string {
  return agents.find((agent) => agent.id === id)?.name ?? id;
}

function Comparison({
  inquiry,
  agents,
  selected,
  onSelect,
}: {
  inquiry: Inquiry;
  agents: readonly AgentInfo[];
  selected: string;
  onSelect: (runId: string) => void;
}) {
  return (
    <section className="runs" aria-label="Every time this inquiry was handled">
      <h3>Every run of this inquiry</h3>
      <div className="tablewrap">
        <table className="table table--runs">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Result</th>
              <th scope="col">Cases</th>
              <th scope="col" className="num">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {inquiry.runs.map((run) => (
              <tr key={run.id} className={run.id === selected ? 'is-selected' : undefined}>
                <th scope="row">
                  <button type="button" className="linkbutton" onClick={() => onSelect(run.id)}>
                    {agentName(agents, run.agent_id)}
                  </button>
                </th>
                <td>
                  <RunBadge state={run.state} />
                </td>
                <td>{run.response?.case_actions.map((action) => action.case_id).join(', ') || '—'}</td>
                <td className="num">{run.duration_ms === null ? '—' : formatDuration(run.duration_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SendAgain({ inquiry, agents }: { inquiry: Inquiry; agents: readonly AgentInfo[] }) {
  const sendAgain = useSendAgain(inquiry.id);
  const [chosen, setChosen] = useState('');
  const agentId = chosen !== '' ? chosen : (agents[0]?.id ?? '');

  if (agents.length === 0) {
    return null;
  }
  return (
    <form
      className="again"
      onSubmit={(event) => {
        event.preventDefault();
        sendAgain.mutate({ agent_id: agentId });
      }}
    >
      <label htmlFor="again-agent">Send the same message again to</label>
      <select id="again-agent" value={agentId} onChange={(event) => setChosen(event.target.value)}>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      <button type="submit" className="button" disabled={sendAgain.isPending}>
        Send again
      </button>
      <p className="form__hint">
        It keeps the same identifier and receipt time, so a case already opened for it must not be opened twice.
      </p>
      {sendAgain.isError ? <Problem>{failureText(sendAgain.error)}</Problem> : null}
    </form>
  );
}

export function InquiryDetail({ inquiryId }: { inquiryId: string }) {
  const inquiry = useInquiry(inquiryId);
  const agents = useAgents();
  const [chosenRun, setChosenRun] = useState<string | null>(null);

  if (inquiry.isPending) {
    return <Loading what="the inquiry" />;
  }
  if (inquiry.isError) {
    const missing = inquiry.error instanceof ApiFailure && inquiry.error.status === 404;
    return <Problem>{missing ? 'There is no such inquiry.' : failureText(inquiry.error)}</Problem>;
  }

  const found = inquiry.data;
  const known = agents.data?.agents ?? [];
  const latest = found.runs[found.runs.length - 1];
  const run = found.runs.find((candidate) => candidate.id === chosenRun) ?? latest;

  return (
    <div className="reading__thread">
      <Message inquiry={found} />

      {run === undefined ? (
        <Problem>This inquiry was received but never handed to an agent.</Problem>
      ) : (
        <>
          <header className="runhead">
            <h2>{agentName(known, run.agent_id)}</h2>
            <RunBadge state={run.state} />
          </header>
          {run.started_by === null ? null : <p className="message__when">Started by {run.started_by.name}</p>}
          <RunResult run={run} />
        </>
      )}

      {found.runs.length > 1 && run !== undefined ? (
        <Comparison inquiry={found} agents={known} selected={run.id} onSelect={setChosenRun} />
      ) : null}

      <SendAgain inquiry={found} agents={known} />
    </div>
  );
}
