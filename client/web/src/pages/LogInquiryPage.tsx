import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { failureText, useSendInquiry } from '../api.ts';
import { Problem } from '../components.tsx';
import { INBOX_AGENT } from '../inbox.ts';

export function LogInquiryPage() {
  const send = useSendInquiry();
  const navigate = useNavigate();
  const [sender, setSender] = useState('');
  const [text, setText] = useState('');
  const ready = sender.trim() !== '' && text.trim() !== '' && !send.isPending;

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!ready) {
      return;
    }
    send.mutate(
      { sender: sender.trim(), text: text.trim(), agent_id: INBOX_AGENT },
      { onSuccess: (inquiry) => void navigate(`/inquiries/${inquiry.id}`) },
    );
  }

  return (
    <div className="page page--form">
      <div className="page__primary">
        <nav aria-label="Where you are" className="crumbs">
          <Link to="/inquiries">Inbox</Link> <span aria-hidden="true">/</span> <span>Log an inquiry</span>
        </nav>
        <h1>Log an inquiry</h1>
        <p className="lead">For a question or a report that reached you by phone, by email or in person. Write it as the sender said it.</p>

        <form className="card form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="log-from">From</label>
            <input
              id="log-from"
              type="text"
              autoComplete="off"
              value={sender}
              aria-describedby="log-from-hint"
              onChange={(event) => setSender(event.target.value)}
            />
            <p id="log-from-hint" className="field__hint">
              Name, role and how to reach them.
            </p>
          </div>
          <div className="field">
            <label htmlFor="log-message">What they said</label>
            <textarea
              id="log-message"
              className="writing"
              rows={8}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          <div className="actions">
            <button type="submit" className="button button--primary" disabled={!ready}>
              {send.isPending ? 'Logging…' : 'Log inquiry'}
            </button>
            <Link to="/inquiries" className="button">
              Cancel
            </Link>
          </div>
          {send.isError ? (
            <Problem>
              <p>{failureText(send.error)}</p>
              <p>Nothing was logged. Try again.</p>
            </Problem>
          ) : null}
        </form>
      </div>

      <aside className="page__side" aria-label="What happens when you log it">
        <section className="card side__card">
          <h2 className="side__title">When you log it</h2>
          <p>
            It joins the desk’s inbox and is handled straight away. You get a draft reply with the label passages it relies
            on, and an adverse event case is opened if the message reports a side effect.
          </p>
        </section>
      </aside>
    </div>
  );
}
