import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import type { AuditView, CaseRecord, ElementName, ReviewDecision, VersionView } from '../../../shared/api.ts';
import { ApiFailure, failureText, useCase, useCases, useInquiry, useReview } from '../api.ts';
import { Boxed, CaseStatusTag, Loading, Paragraphs, Problem } from '../components.tsx';
import {
  ELEMENT_LABEL,
  STATUS_LABEL,
  actorWords,
  arrivalWords,
  daysAfter,
  firstLine,
  formatDate,
  formatDateTime,
  historyWords,
  pretty,
} from '../format.ts';
import { useMay, useSignedInUser } from '../session.tsx';

const FIELD_ORDER: readonly ElementName[] = ['patient', 'reporter', 'suspect_drug', 'event'];

function changedIn(version: VersionView, previous: VersionView | undefined): ElementName[] {
  if (previous === undefined) {
    return FIELD_ORDER.filter((name) => version.elements[name] !== undefined);
  }
  return FIELD_ORDER.filter((name) => version.elements[name] !== previous.elements[name]);
}

function Decision({ record }: { record: CaseRecord }) {
  const user = useSignedInUser();
  const may = useMay();
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
      <section className="card side__card">
        <h2 className="side__title">Decision</h2>
        <p>
          This case is{' '}
          {status === 'needs_information' ? 'waiting for more information' : STATUS_LABEL[status].toLowerCase()}. It
          comes back for a decision if a follow-up is added.
        </p>
      </section>
    );
  }

  if (!may.decide_cases) {
    return (
      <section className="card side__card">
        <h2 className="side__title">Decision</h2>
        <p>Your account can read cases but not decide them.</p>
      </section>
    );
  }

  return (
    <Boxed title={canDecide ? 'This case needs your decision' : 'This case is incomplete'}>
      {canDecide ? null : (
        <p>It cannot be approved until it has all four parts. You can record what is still needed.</p>
      )}
      <div className="field">
        <label htmlFor="review-note">Note</label>
        <textarea
          id="review-note"
          rows={4}
          value={note}
          aria-describedby="review-note-hint"
          onChange={(event) => setNote(event.target.value)}
        />
        <p id="review-note-hint" className="field__hint">
          {canDecide ? 'Optional, unless you ask for information.' : 'What is needed, and from whom.'} Recorded as{' '}
          {user.name}.
        </p>
      </div>
      <div className="actions actions--decision">
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
            <button type="button" className="button" disabled={review.isPending} onClick={() => decide('reject')}>
              Reject case
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="button button--full"
          disabled={note.trim() === '' || review.isPending}
          onClick={() => decide('request_information')}
        >
          Ask for information
        </button>
      </div>
      {review.isError ? (
        <Problem>
          <p>{failureText(review.error)}</p>
          <p>Nothing was recorded. Try again.</p>
        </Problem>
      ) : null}
    </Boxed>
  );
}

// Up to two other cases awaiting review, for someone who may decide them.
function NextInQueue({ caseId }: { caseId: string }) {
  const awaiting = useCases('awaiting_review');
  const next = (awaiting.data?.cases ?? []).filter((found) => found.case_id !== caseId).slice(0, 2);
  return (
    <section className="card side__card">
      <h2 className="side__title">Next in your queue</h2>
      {awaiting.isPending ? <Loading what="your queue" /> : null}
      {awaiting.isError ? (
        <Problem>
          <p>{failureText(awaiting.error)}</p>
        </Problem>
      ) : null}
      {awaiting.data !== undefined && next.length === 0 ? <p>No other case is awaiting review.</p> : null}
      {next.map((found) => (
        <p key={found.case_id} className="queue__item">
          <Link to={`/cases/${found.case_id}`} className="caseno">
            {found.case_id}
          </Link>
          {found.elements.suspect_drug === undefined ? '' : `, ${found.elements.suspect_drug}`}
          {found.elements.event === undefined ? '' : `, ${firstLine(found.elements.event, 60)}`}
        </p>
      ))}
    </section>
  );
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function who(entry: AuditView): string {
  const actor = actorWords(entry.actor_kind, entry.actor);
  return entry.acting_for === null ? actor : `${actor}, for ${entry.acting_for.name}`;
}

function VersionChanges({ version, previous }: { version: VersionView; previous: VersionView | undefined }) {
  const changed = changedIn(version, previous);
  return (
    <div className="history__version">
      <p>
        Version {version.version}
        {version.sender === '' ? '' : `, from a message sent by ${version.sender}`}.
        {changed.length === 0 ? ' No change to the four parts.' : ''}
      </p>
      {changed.length === 0 ? null : (
        <dl className="history__changes">
          {changed.map((name) => (
            <div key={name}>
              <dt>{ELEMENT_LABEL[name]}</dt>
              <dd className="writing">{version.elements[name] ?? 'Removed'}</dd>
            </div>
          ))}
        </dl>
      )}
      {version.note === null ? null : <p className="writing">{version.note}</p>}
    </div>
  );
}

// The message the case was opened from: the one its first version was recorded from, read from the desk's inbox.
function OriginalMessage({ versions }: { versions: readonly VersionView[] }) {
  const first = versions.reduce<VersionView | undefined>(
    (earliest, version) => (earliest === undefined || version.version < earliest.version ? version : earliest),
    undefined,
  );
  const inquiry = useInquiry(first?.message_id);

  let body: ReactNode;
  if (first === undefined) {
    body = <p className="absent">The case has no recorded version, so the message it came from is not known.</p>;
  } else if (inquiry.isPending) {
    body = <Loading what="the message" />;
  } else if (inquiry.isError) {
    const missing = inquiry.error instanceof ApiFailure && inquiry.error.status === 404;
    body = (
      <Problem>
        <p>{missing ? 'The message this case came from is not in this desk’s inbox.' : failureText(inquiry.error)}</p>
      </Problem>
    );
  } else {
    const message = inquiry.data;
    const arrival = arrivalWords(message.entered_by);
    body = (
      <article className="card origin" aria-label="The message">
        <p className="origin__how">
          From {message.sender}. Received {formatDateTime(message.received_at)}
          {arrival === null ? '' : `, ${arrival}`}.
        </p>
        <div className="writing">
          <Paragraphs text={message.text} />
        </div>
      </article>
    );
  }

  return (
    <section className="stack" aria-labelledby="origin-title">
      <h2 id="origin-title">Original message</h2>
      {body}
    </section>
  );
}

type HistoryItem =
  | { kind: 'audit'; at: string; entry: AuditView; version: VersionView | undefined }
  | { kind: 'version'; at: string; version: VersionView };

// Every audit entry in order, each version shown with the entry that recorded it, and any version no entry
// recorded at the time it was recorded.
function historyOf(record: CaseRecord): HistoryItem[] {
  const byNumber = new Map(record.versions.map((version) => [version.version, version]));
  const shown = new Set<number>();
  const items: HistoryItem[] = record.audit.map((entry) => {
    const version =
      entry.version !== null && !shown.has(entry.version) && (entry.action === 'case_created' || entry.action === 'follow_up_added')
        ? byNumber.get(entry.version)
        : undefined;
    if (version !== undefined) {
      shown.add(version.version);
    }
    return { kind: 'audit', at: entry.at, entry, version };
  });
  for (const version of record.versions) {
    if (!shown.has(version.version)) {
      items.push({ kind: 'version', at: version.recorded_at, version });
    }
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

function History({ record }: { record: CaseRecord }) {
  const byNumber = new Map(record.versions.map((version) => [version.version, version]));
  return (
    <section className="stack" aria-labelledby="history-title">
      <h2 id="history-title">History</h2>
      <ol className="card history">
        {historyOf(record).map((item) => {
          const previous = byNumber.get(item.version === undefined ? 0 : item.version.version - 1);
          if (item.kind === 'version') {
            return (
              <li key={`version-${item.version.version}`} className="history__item">
                <div className="history__line">
                  <p>
                    <strong>Version {item.version.version} recorded</strong> by{' '}
                    {actorWords('agent', item.version.recorded_by)}
                  </p>
                  <span className="history__when">{formatDateTime(item.at)}</span>
                </div>
                <VersionChanges version={item.version} previous={previous} />
              </li>
            );
          }
          return (
            <li key={`audit-${item.entry.seq}`} className="history__item">
              <div className="history__line">
                <p>
                  <strong>{historyWords(item.entry.action)}</strong> by {who(item.entry)}
                </p>
                <span className="history__when">{formatDateTime(item.at)}</span>
              </div>
              {item.version === undefined ? null : <VersionChanges version={item.version} previous={previous} />}
              <details className="history__detail">
                <summary>Recorded detail</summary>
                <pre>{pretty(item.entry.detail)}</pre>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function CasePage() {
  const { caseId } = useParams();
  const record = useCase(caseId);
  const may = useMay();

  const crumbs = (
    <nav aria-label="Where you are" className="crumbs">
      <Link to="/cases">Cases</Link> <span aria-hidden="true">/</span> <span>{caseId}</span>
    </nav>
  );

  if (record.isPending) {
    return (
      <div className="page page--wide">
        {crumbs}
        <Loading what="the case" />
      </div>
    );
  }
  if (record.isError) {
    const missing = record.error instanceof ApiFailure && record.error.status === 404;
    return (
      <div className="page page--wide stack">
        {crumbs}
        <Problem>
          <p>{missing ? `There is no case ${caseId ?? ''}.` : failureText(record.error)}</p>
        </Problem>
      </div>
    );
  }

  const { case: found, audit } = record.data;
  const opened = audit.find((entry) => entry.action === 'case_created');

  return (
    <div className="page page--wide">
      {crumbs}
      <div className="casehead">
        <h1>{found.case_id}</h1>
        <CaseStatusTag status={found.status} />
      </div>
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
        {opened === undefined ? null : (
          <div>
            <dt>Opened by</dt>
            <dd>{sentenceCase(who(opened))}</dd>
          </div>
        )}
      </dl>

      <div className="caselayout">
        <div className="caselayout__main stack stack--large">
          <section aria-label="The four parts of the case" className="stack">
            <dl className="ruled">
              {FIELD_ORDER.map((name) => {
                const value = found.elements[name];
                return (
                  <div key={name} className="ruled__cell">
                    <dt>{ELEMENT_LABEL[name]}</dt>
                    <dd className={value === undefined ? 'absent' : 'writing'}>{value ?? 'Not given'}</dd>
                  </div>
                );
              })}
            </dl>
            {found.note === null ? null : (
              <p className="casenote">
                <strong>Note with version {found.version}:</strong> <span className="writing">{found.note}</span>
              </p>
            )}
          </section>
          <OriginalMessage versions={record.data.versions} />
          <History record={record.data} />
        </div>
        <aside className="caselayout__side stack stack--large" aria-label="Decision">
          <Decision record={record.data} />
          {may.decide_cases ? <NextInQueue caseId={found.case_id} /> : null}
        </aside>
      </div>
    </div>
  );
}
