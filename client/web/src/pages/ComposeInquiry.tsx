import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { failureText, useAgents, useSamples, useSendInquiry } from '../api.ts';
import { Loading, Problem } from '../components.tsx';

export function ComposeInquiry() {
  const agents = useAgents();
  const samples = useSamples();
  const send = useSendInquiry();
  const navigate = useNavigate();

  const [sender, setSender] = useState('');
  const [text, setText] = useState('');
  const [chosenAgent, setChosenAgent] = useState('');
  const [sampleId, setSampleId] = useState<string | null>(null);

  const available = agents.data?.agents ?? [];
  const agentId = chosenAgent !== '' ? chosenAgent : (available[0]?.id ?? '');
  const sample = samples.data?.samples.find((candidate) => candidate.id === sampleId);
  const ready = sender.trim() !== '' && text.trim() !== '' && agentId !== '' && !send.isPending;

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!ready) {
      return;
    }
    send.mutate(
      { sender: sender.trim(), text: text.trim(), agent_id: agentId },
      { onSuccess: (inquiry) => void navigate(`/inquiries/${inquiry.id}`) },
    );
  }

  return (
    <div className="compose">
      <header className="pagehead">
        <h2 className="pagehead__title">Receive an inquiry</h2>
        <p className="pagehead__lead">
          Write a message as a clinician would send it, or start from a prepared one. It is stamped with the time
          it arrives and handed to an agent.
        </p>
      </header>

      {agents.isPending ? <Loading what="the agents" /> : null}
      {agents.isError ? <Problem>{failureText(agents.error)}</Problem> : null}
      {agents.data !== undefined && available.length === 0 ? (
        <div className="notice">
          <p className="notice__title">No agent is running yet</p>
          <p>
            An inquiry needs an agent to handle it, and none is set up. You can still read the prepared inquiries
            below. <Link to="/system">See what is running</Link>.
          </p>
        </div>
      ) : null}

      <form className="form" onSubmit={submit}>
        <fieldset className="samples">
          <legend>Prepared inquiries</legend>
          {samples.isError ? <Problem>{failureText(samples.error)}</Problem> : null}
          <ul>
            {samples.data?.samples.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  aria-pressed={candidate.id === sampleId}
                  onClick={() => {
                    setSampleId(candidate.id);
                    setSender(candidate.sender);
                    setText(candidate.text);
                  }}
                >
                  {candidate.title}
                </button>
              </li>
            ))}
          </ul>
          {sample === undefined ? null : (
            <p className="samples__shows">
              <strong>What it should show.</strong> {sample.shows}
            </p>
          )}
        </fieldset>

        <label htmlFor="inquiry-sender">From</label>
        <input
          id="inquiry-sender"
          value={sender}
          onChange={(event) => setSender(event.target.value)}
          placeholder="Name, role and how to reach them"
        />

        <label htmlFor="inquiry-text">Message</label>
        <textarea
          id="inquiry-text"
          className="document"
          rows={8}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="The inquiry, in the sender’s words"
        />

        <label htmlFor="inquiry-agent">Handled by</label>
        <select
          id="inquiry-agent"
          value={agentId}
          onChange={(event) => setChosenAgent(event.target.value)}
          disabled={available.length === 0}
        >
          {available.length === 0 ? <option value="">No agent available</option> : null}
          {available.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        {available.find((agent) => agent.id === agentId) === undefined ? null : (
          <p className="form__hint">{available.find((agent) => agent.id === agentId)?.description}</p>
        )}

        <div className="actions">
          <button type="submit" className="button button--primary" disabled={!ready}>
            {send.isPending ? 'Sending…' : 'Send inquiry'}
          </button>
        </div>
        {send.isError ? <Problem>{failureText(send.error)}</Problem> : null}
      </form>
    </div>
  );
}
