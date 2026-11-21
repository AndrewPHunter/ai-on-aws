import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import type { CaseRecord, ElementName, ReviewDecision, VersionView } from '../../../shared/api.ts';
import { ApiFailure, failureText, useCase, useReview } from '../api.ts';
import { Boxed, Loading, Problem, StatusBadge } from '../components.tsx';
import { ELEMENT_LABEL, auditLabel, daysAfter, formatDate, formatDateTime, pretty } from '../format.ts';
import { useSignedInUser } from '../session.tsx';

const FIELD_ORDER: readonly ElementName[] = ['patient', 'reporter', 'suspect_drug', 'event'];

function changedIn(version: VersionView, previous: VersionView | undefined): ElementName[] {
  if (previous === undefined) {
    return FIELD_ORDER.filter((name) => version.elements[name] !== undefined);
  }
  return FIELD_ORDER.filter((name) => version.elements[name] !== previous.elements[name]);
}

function Decision({ record }: { record: CaseRecord }) {
  const user = useSignedInUser();
  const review = useReview(record.case.case_id);
  const [note, setNote] = useState('');
  const status = record.case.status;

  const canDecide = status === 'awaiting_review';
  const canAsk = status === 'awaiting_review' || status === 'incomplete';

  function decide(decision: ReviewDecision): void {
    review.mutate({ decision, ...(note.trim() === '' ? {} : { note: note.trim() }) }, { onSuccess: () => setNote('') });
  }

  if (!canDecide && !canAsk) {
    return (
      <section className="settled">
        <h3>Decision</h3>
        <p>
          This case is {status === 'needs_information' ? 'waiting for more information' : status}. It comes back
          for a decision if a follow-up is added.
        </p>
      </section>
    );
  }

  if (!user.is_reviewer) {
    return (
      <section className="settled">
        <h3>Decision</h3>
        <p>Only a reviewer can decide a case.</p>
      </section>
    );
  }

  return (
    <Boxed title={canDecide ? 'This case needs your decision' : 'This case is incomplete'}>
      {canDecide ? null : (
        <p className="boxed__lead">
          It cannot be approved until it has all four parts. You can record what is still needed.
        </p>
      )}
      <label htmlFor="review-note">Note</label>
      <textarea
        id="review-note"
        rows={3}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder={canDecide ? 'Optional, unless you ask for information' : 'What is needed, and from whom'}
      />
      <p className="boxed__hint">Recorded as {user.name}.</p>
      <div className="actions">
        {canDecide ? (
          <>
            <button
              type="button"
              className="button button--primary"
              disabled={review.isPending}
              onClick={() => decide('approve')}
            >
              Approve case
            </button>
            <button
              type="button"
              className="button"
              disabled={review.isPending}
              onClick={() => decide('reject')}
            >
              Reject case
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="button"
          disabled={note.trim() === '' || review.isPending}
          onClick={() => decide('request_information')}
        >
          Ask for information
        </button>
      </div>
      {review.isError ? <Problem>{failureText(review.error)}</Problem> : null}
    </Boxed>
  );
}

export function CasePage() {
  const { caseId } = useParams();
  const record = useCase(caseId);

  if (record.isPending) {
    return (
      <div className="column column--wide">
        <Loading what="the case" />
      </div>
    );
  }
  if (record.isError) {
    const missing = record.error instanceof ApiFailure && record.error.status === 404;
    return (
      <div className="column column--wide">
        <Link to="/cases" className="back">
          <ArrowLeft size={16} aria-hidden="true" /> All cases
        </Link>
        <Problem>{missing ? `There is no case ${caseId ?? ''}.` : failureText(record.error)}</Problem>
      </div>
    );
  }

  const { case: found, versions, audit } = record.data;
  const newestFirst = [...versions].reverse();

  return (
    <div className="column column--wide">
      <Link to="/cases" className="back">
        <ArrowLeft size={16} aria-hidden="true" /> All cases
      </Link>

      <header className="casehead">
        <h1 className="caseid caseid--large">{found.case_id}</h1>
        <StatusBadge status={found.status} />
      </header>

      <dl className="facts">
        <div>
          <dt>Received</dt>
          <dd>{formatDateTime(found.received_at)}</dd>
        </div>
        <div>
          <dt>15 calendar days from receipt</dt>
          <dd>{formatDate(daysAfter(found.received_at, 15))}</dd>
          <dd className="facts__note">The reporting limit if the event is serious and unexpected</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{found.version}</dd>
        </div>
      </dl>

      <div className="caselayout">
        <section className="report" aria-label="The report">
          {FIELD_ORDER.map((name) => {
            const value = found.elements[name];
            return (
              <div key={name} className={value === undefined ? 'field field--missing' : 'field'}>
                <h3 className="field__label">{ELEMENT_LABEL[name]}</h3>
                {value === undefined ? (
                  <p className="field__absent">Not given</p>
                ) : (
                  <p className="field__value">{value}</p>
                )}
              </div>
            );
          })}
          {found.note === null ? null : (
            <div className="field field--note">
              <h3 className="field__label">Note with this version</h3>
              <p className="field__value">{found.note}</p>
            </div>
          )}
        </section>

        <Decision record={record.data} />
      </div>

      <div className="history">
        <section>
          <h2>Versions</h2>
          <ol className="versions" reversed>
            {newestFirst.map((version, index) => {
              const previous = newestFirst[index + 1];
              const changed = changedIn(version, previous);
              return (
                <li key={version.version}>
                  <p className="versions__head">
                    <strong>Version {version.version}</strong>
                    <span>{formatDateTime(version.recorded_at)}</span>
                  </p>
                  <p className="versions__meta">
                    Recorded by {version.recorded_by} from message {version.message_id}
                    {version.sender === '' ? '' : `, sent by ${version.sender}`}
                  </p>
                  {changed.length === 0 ? (
                    <p className="versions__meta">No change to the four parts.</p>
                  ) : (
                    <dl className="versions__changes">
                      {changed.map((name) => (
                        <div key={name}>
                          <dt>{ELEMENT_LABEL[name]}</dt>
                          <dd>{version.elements[name] ?? 'Removed'}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {version.note === null ? null : <p className="versions__note">{version.note}</p>}
                </li>
              );
            })}
          </ol>
        </section>

        <section>
          <h2>Audit trail</h2>
          <ol className="audit">
            {audit.map((entry) => (
              <li key={entry.seq} className={`audit__entry audit__entry--${entry.actor_kind}`}>
                <p className="audit__what">{auditLabel(entry.action)}</p>
                <p className="audit__who">
                  {entry.actor_kind === 'reviewer' ? 'Reviewer' : 'Agent'} {entry.actor}, {formatDateTime(entry.at)}
                </p>
                <details>
                  <summary>Recorded detail</summary>
                  <pre>{pretty(entry.detail)}</pre>
                </details>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
