// The contact form: where a clinician writes in to medical information. Anyone can reach it, nobody signs in,
// and it asks nothing of the desk. The server answers a message with when it was received and nothing else,
// so that is all the page tells the sender.

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiFailure, useSendContactMessage } from '../api.ts';
import { Mark, Problem } from '../components.tsx';
import { formatDateTime } from '../format.ts';

type FieldName = 'name' | 'role' | 'contact' | 'text';
type Fields = Record<FieldName, string>;

const EMPTY: Fields = { name: '', role: '', contact: '', text: '' };

const FIELD_LABEL: Record<FieldName, string> = {
  name: 'Your name',
  role: 'Your role',
  contact: 'Where we can reach you',
  text: 'Your message',
};

const FIELD_ORDER: readonly FieldName[] = ['name', 'role', 'contact', 'text'];

// What went wrong, for the person who wrote the message. A refusal carries the server's own sentence.
function failureWords(error: unknown): string {
  if (error instanceof ApiFailure) {
    if (error.status === 0) {
      return 'Your message was not sent: we could not be reached. Check your connection, then send it again.';
    }
    if (error.status === 400) {
      return `Your message was not sent. ${error.message}`;
    }
    return `Your message was not sent: our service answered with an error (status ${error.status}). Send it again in a moment.`;
  }
  return 'Your message was not sent. Send it again in a moment.';
}

function listWords(words: readonly string[]): string {
  if (words.length <= 1) {
    return words.join('');
  }
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
}

function Received({ receivedAt, contact, onAnother }: { receivedAt: string; contact: string; onAnother: () => void }) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  return (
    <section className="card contact__received" aria-labelledby="contact-received-title">
      <h2 id="contact-received-title" ref={title} tabIndex={-1}>
        Your message was received
      </h2>
      <p>
        We received it on {formatDateTime(receivedAt)}. We reply to the contact you gave:{' '}
        <span className="contact__given">{contact}</span>.
      </p>
      <div className="actions">
        <button type="button" className="button" onClick={onAnother}>
          Send another message
        </button>
      </div>
    </section>
  );
}

function MessageForm({ onReceived }: { onReceived: (receivedAt: string, contact: string) => void }) {
  const send = useSendContactMessage();
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [missing, setMissing] = useState<readonly FieldName[]>([]);

  function change(name: FieldName, value: string): void {
    setFields((was) => ({ ...was, [name]: value }));
    if (value.trim() !== '') {
      setMissing((was) => was.filter((field) => field !== name));
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (send.isPending) {
      return;
    }
    const empty = FIELD_ORDER.filter((name) => fields[name].trim() === '');
    setMissing(empty);
    if (empty.length > 0) {
      return;
    }
    const message = {
      name: fields.name.trim(),
      role: fields.role.trim(),
      contact: fields.contact.trim(),
      text: fields.text.trim(),
    };
    send.mutate(message, { onSuccess: (answer) => onReceived(answer.received_at, message.contact) });
  }

  function invalid(name: FieldName): true | undefined {
    return missing.includes(name) ? true : undefined;
  }

  return (
    <form className="card form" onSubmit={submit} noValidate>
      <div className="fieldrow">
        <div className="field">
          <label htmlFor="contact-name">{FIELD_LABEL.name}</label>
          <input
            id="contact-name"
            type="text"
            autoComplete="name"
            value={fields.name}
            aria-invalid={invalid('name')}
            onChange={(event) => change('name', event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="contact-role">{FIELD_LABEL.role}</label>
          <input
            id="contact-role"
            type="text"
            autoComplete="organization-title"
            value={fields.role}
            aria-invalid={invalid('role')}
            onChange={(event) => change('role', event.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="contact-reach">{FIELD_LABEL.contact}</label>
        <input
          id="contact-reach"
          type="text"
          autoComplete="email"
          value={fields.contact}
          aria-describedby="contact-reach-hint"
          aria-invalid={invalid('contact')}
          onChange={(event) => change('contact', event.target.value)}
        />
        <p id="contact-reach-hint" className="field__hint">
          An email address or a phone number.
        </p>
      </div>
      <div className="field">
        <label htmlFor="contact-message">{FIELD_LABEL.text}</label>
        <textarea
          id="contact-message"
          className="writing"
          rows={7}
          value={fields.text}
          aria-describedby="contact-message-hint"
          aria-invalid={invalid('text')}
          onChange={(event) => change('text', event.target.value)}
        />
        <p id="contact-message-hint" className="field__hint">
          Reporting a side effect? Tell us who the patient is (initials or age), which medicine, and what happened.
        </p>
      </div>
      <div className="actions">
        <button type="submit" className="button button--primary button--send" disabled={send.isPending}>
          {send.isPending ? 'Sending…' : 'Send to medical information'}
        </button>
        <span className="field__hint">We reply to the contact you gave above.</span>
      </div>
      {missing.length > 0 ? (
        <Problem>
          <p>Fill in {listWords(missing.map((name) => FIELD_LABEL[name].toLowerCase()))} before sending.</p>
        </Problem>
      ) : null}
      {send.isError && missing.length === 0 ? (
        <Problem>
          <p>{failureWords(send.error)}</p>
          <p>What you wrote is still here.</p>
        </Problem>
      ) : null}
    </form>
  );
}

export function ContactPage() {
  const [received, setReceived] = useState<{ receivedAt: string; contact: string } | null>(null);
  // Counts the forms shown, so "Send another message" brings back a new, empty one.
  const [formNumber, setFormNumber] = useState(0);
  const lastFormNumber = useRef(0);

  // The tab's title says which page it is, so the form and the desk are not confused in a tab bar.
  useEffect(() => {
    const before = document.title;
    document.title = 'Contact medical information';
    return () => {
      document.title = before;
    };
  }, []);

  // After "Send another message", the new form's first field takes the focus the confirmation had.
  useEffect(() => {
    if (received === null && formNumber !== lastFormNumber.current) {
      lastFormNumber.current = formNumber;
      document.getElementById('contact-name')?.focus();
    }
  }, [received, formNumber]);

  return (
    <div className="contact">
      <header className="topbar contact__top">
        <Mark name="Medical Information" />
        <a className="lablink" href="/">
          Desk staff sign in
        </a>
      </header>
      <main className="page page--form contact__page">
        <div className="page__primary">
          <h1 className="contact__title">Ask a question or report a side effect</h1>
          <p className="lead">For healthcare professionals. Write to us in your own words; one message can do both.</p>
          {received === null ? (
            <MessageForm
              key={formNumber}
              onReceived={(receivedAt, contact) => setReceived({ receivedAt, contact })}
            />
          ) : (
            <Received
              receivedAt={received.receivedAt}
              contact={received.contact}
              onAnother={() => {
                setReceived(null);
                setFormNumber((was) => was + 1);
              }}
            />
          )}
        </div>

        <aside className="page__side contact__side" aria-labelledby="contact-next-title">
          <h2 id="contact-next-title">What happens next</h2>
          <ol className="contact__steps">
            <li>
              <span className="contact__number" aria-hidden="true">
                1
              </span>
              <span>
                <strong>Your message is read at once.</strong>
                <br />
                <span className="contact__quiet">It reaches our desk within a minute.</span>
              </span>
            </li>
            <li>
              <span className="contact__number" aria-hidden="true">
                2
              </span>
              <span>
                <strong>A side effect is recorded as a report.</strong>
                <br />
                <span className="contact__quiet">
                  A safety reviewer decides every report. We may contact you for more detail.
                </span>
              </span>
            </li>
            <li>
              <span className="contact__number" aria-hidden="true">
                3
              </span>
              <span>
                <strong>A question is answered from the approved label.</strong>
                <br />
                <span className="contact__quiet">Every answer names the label passage it relies on.</span>
              </span>
            </li>
          </ol>
          <p className="contact__demo">This is a demonstration. Every name, medicine and message in it is invented.</p>
        </aside>
      </main>
    </div>
  );
}
