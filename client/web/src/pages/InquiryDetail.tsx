import { useState } from 'react';
import { Link } from 'react-router';

import type { AgentInfo, Inquiry, Run } from '../../../shared/api.ts';
import { ApiFailure, failureText, useAgents, useInquiry, useSendAgain } from '../api.ts';
import { Boxed, Loading, Problem, RunBadge } from '../components.tsx';
import { formatDateTime, formatDuration } from '../format.ts';
import { RunLedger } from './RunLedger.tsx';

const ACTION_TEXT = {
  case_opened: 'opened',
  case_already_open: 'was already open for this message',
  follow_up_recorded: 'had a follow-up added',
} as const;

function agentName(agents: readonly AgentInfo[], id: string): string {
  return agents.find((agent) => agent.id === id)?.name ?? id;
}

function toolCalls(run: Run): number {
  return run.response?.steps.filter((step) => step.kind === 'tool').length ?? 0;
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
              <th scope="col" className="num">
                Steps
              </th>
              <th scope="col" className="num">
                Tool calls
              </th>
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
                <td className="num">{run.response?.steps.length ?? '—'}</td>
                <td className="num">{run.response === null ? '—' : toolCalls(run)}</td>
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

function RunResult({ run }: { run: Run }) {
  if (run.state === 'running') {
    return (
      <p className="working">
        <span className="pulse" aria-hidden="true" /> The agent is working on this. Started{' '}
        {formatDateTime(run.started_at)}.
      </p>
    );
  }
  if (run.state === 'failed' || run.response === null) {
    return <Problem>{run.error ?? 'The run did not finish, and no reason was recorded.'}</Problem>;
  }

  const { response } = run;
  return (
    <>
      {response.outcome === 'completed' ? null : (
        <Problem>
          {response.outcome === 'stopped' ? 'The agent stopped before finishing' : 'The agent could not handle this'}
          {response.stop_reason === null ? '.' : `: ${response.stop_reason}`}
        </Problem>
      )}

      {response.case_actions.length === 0 ? null : (
        <Boxed title="An adverse event was reported in this message">
          <ul className="caseactions">
            {response.case_actions.map((action) => (
              <li key={`${action.kind}-${action.case_id}`}>
                Case <Link to={`/cases/${action.case_id}`}>{action.case_id}</Link> {ACTION_TEXT[action.kind]}. Its
                status was {action.status.replace(/_/g, ' ')}.
              </li>
            ))}
          </ul>
        </Boxed>
      )}

      <article className="reply" aria-label="Reply to the sender">
        <h3>Reply</h3>
        {response.reply.trim() === '' ? (
          <p className="absent">The agent wrote no reply.</p>
        ) : (
          response.reply.split(/\n{2,}/).map((paragraph, index) => (
            <p key={index} className="document">
              {paragraph}
            </p>
          ))
        )}
      </article>

      {response.citations.length === 0 ? null : (
        <section className="citations" aria-label="Passages of the label the reply relies on">
          <h3>From the approved label</h3>
          <ul>
            {response.citations.map((citation, index) => (
              <li key={index}>
                <p className="citations__where">
                  <span className="citations__drug">{citation.drug}</span>
                  <span className="citations__section">{citation.section}</span>
                </p>
                <blockquote className="document">{citation.quote}</blockquote>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
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
    <div className="reading">
      <div className="reading__thread">
        <article className="message" aria-label="The inquiry">
          <header className="message__head">
            <p className="message__from">{found.sender}</p>
            <p className="message__when">Received {formatDateTime(found.received_at)}</p>
          </header>
          {found.text.split(/\n{2,}/).map((paragraph, index) => (
            <p key={index} className="document">
              {paragraph}
            </p>
          ))}
        </article>

        {run === undefined ? (
          <Problem>This inquiry was received but never handed to an agent.</Problem>
        ) : (
          <>
            <header className="runhead">
              <h2>{agentName(known, run.agent_id)}</h2>
              <RunBadge state={run.state} />
            </header>
            <RunResult run={run} />
          </>
        )}

        {found.runs.length > 1 && run !== undefined ? (
          <Comparison inquiry={found} agents={known} selected={run.id} onSelect={setChosenRun} />
        ) : null}

        <SendAgain inquiry={found} agents={known} />
      </div>

      <aside className="reading__ledger" aria-label="What the agent did">
        {run === undefined ? null : <RunLedger run={run} />}
      </aside>
    </div>
  );
}
