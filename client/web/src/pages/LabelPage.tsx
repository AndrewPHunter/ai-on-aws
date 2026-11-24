import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';

import { RunAnswer } from '../Answer.tsx';
import { ApiFailure, failureText, useInquiries, useInquiry, useSendInquiry } from '../api.ts';
import { Loading, Paragraphs, Problem } from '../components.tsx';
import { firstLine, formatDateTime, formatWhen } from '../format.ts';
import { LABEL_AGENT, isLabelLookup, latestRun } from '../inbox.ts';
import { useSignedInUser } from '../session.tsx';

// The question chosen, by the inquiry that carries it, is kept in the address so it survives a reload.
const QUESTION_PARAM = 'question';

function Answered({ inquiryId }: { inquiryId: string }) {
  const inquiry = useInquiry(inquiryId);
  if (inquiry.isPending) {
    return <Loading what="the answer" />;
  }
  if (inquiry.isError) {
    const missing = inquiry.error instanceof ApiFailure && inquiry.error.status === 404;
    return (
      <Problem>
        <p>{missing ? 'That question is not among yours.' : failureText(inquiry.error)}</p>
      </Problem>
    );
  }
  const run = latestRun(inquiry.data);
  return (
    <div className="stack stack--large">
      <article className="card card--reading" aria-label="Your question">
        <div className="message__head">
          <span className="message__from">Your question</span>
          <span className="message__when">Asked {formatDateTime(inquiry.data.received_at)}.</span>
        </div>
        <div className="writing">
          <Paragraphs text={inquiry.data.text} />
        </div>
      </article>
      {run === undefined ? (
        <Problem>
          <p>This question was never sent to be answered. Ask it again.</p>
        </Problem>
      ) : (
        <RunAnswer run={run} working="Being answered." replyTitle="Answer" />
      )}
    </div>
  );
}

function Earlier({ chosen }: { chosen: string | null }) {
  const inquiries = useInquiries();
  const [now] = useState(() => new Date());
  const questions = (inquiries.data?.inquiries ?? []).filter(isLabelLookup);

  return (
    <aside className="page__side" aria-labelledby="earlier-title">
      <section className="card side__card">
        <h2 id="earlier-title" className="side__title">
          Earlier questions
        </h2>
        {inquiries.isPending ? <Loading what="your questions" /> : null}
        {inquiries.isError ? (
          <Problem>
            <p>{failureText(inquiries.error)}</p>
          </Problem>
        ) : null}
        {inquiries.data !== undefined && questions.length === 0 ? (
          <p>Questions you ask appear here, newest first.</p>
        ) : null}
        <ul className="earlier">
          {questions.map((question) => (
            <li key={question.id}>
              <Link
                to={`/label?${QUESTION_PARAM}=${encodeURIComponent(question.id)}`}
                aria-current={question.id === chosen ? 'true' : undefined}
                className="earlier__item"
              >
                <span className="earlier__text">{firstLine(question.text, 90)}</span>
                <span className="earlier__when">
                  {formatWhen(question.received_at, now)}
                  {question.runs.some((run) => run.state === 'running') ? ', being answered' : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

export function LabelPage() {
  const user = useSignedInUser();
  const send = useSendInquiry();
  const [params, setParams] = useSearchParams();
  const chosen = params.get(QUESTION_PARAM);
  const [question, setQuestion] = useState('');
  const ready = question.trim() !== '' && !send.isPending;

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!ready) {
      return;
    }
    send.mutate(
      { sender: `${user.name}, medical information`, text: question.trim(), agent_id: LABEL_AGENT },
      {
        onSuccess: (inquiry) => {
          setQuestion('');
          setParams({ [QUESTION_PARAM]: inquiry.id });
        },
      },
    );
  }

  return (
    <div className="page page--split">
      <div className="page__primary stack stack--large">
        <div>
          <h1>Ask the label</h1>
          <p className="lead">Ask what the approved drug labels say. The answer quotes the passages it relies on.</p>
        </div>
        <form className="card form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="label-question">Your question</label>
            <textarea
              id="label-question"
              className="writing"
              rows={3}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </div>
          <div className="actions">
            <button type="submit" className="button button--primary" disabled={!ready}>
              {send.isPending ? 'Asking…' : 'Ask'}
            </button>
          </div>
          {send.isError ? (
            <Problem>
              <p>{failureText(send.error)}</p>
              <p>The question was not sent. Try again.</p>
            </Problem>
          ) : null}
        </form>
        {chosen === null ? null : <Answered key={chosen} inquiryId={chosen} />}
      </div>
      <Earlier chosen={chosen} />
    </div>
  );
}
