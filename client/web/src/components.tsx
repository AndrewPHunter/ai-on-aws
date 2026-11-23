// Small pieces used on more than one screen.

import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';

import type { CaseStatus, PieceState, RunState, TraceInquiry } from '../../shared/api.ts';
import { RUN_STATE_LABEL, STATUS_LABEL, formatDateTime } from './format.ts';

export function StatusBadge({ status }: { status: CaseStatus }) {
  return <span className={`badge badge--${status}`}>{STATUS_LABEL[status]}</span>;
}

export function RunBadge({ state }: { state: RunState }) {
  return (
    <span className={`badge badge--run-${state}`}>
      {state === 'running' ? <span className="pulse" aria-hidden="true" /> : null}
      {RUN_STATE_LABEL[state]}
    </span>
  );
}

const PIECE_LABEL: Record<PieceState, string> = { up: 'Running', down: 'Not reachable', not_configured: 'Not configured' };

export function PieceBadge({ state }: { state: PieceState }) {
  return <span className={`badge badge--piece-${state}`}>{PIECE_LABEL[state]}</span>;
}

// An inquiry's message as it was received.
export function Message({ inquiry }: { inquiry: TraceInquiry }) {
  return (
    <article className="message" aria-label="The inquiry">
      <header className="message__head">
        <p className="message__from">{inquiry.sender}</p>
        <p className="message__when">
          Received {formatDateTime(inquiry.received_at)}
          {inquiry.entered_by === null ? '' : `, entered by ${inquiry.entered_by.name}`}
        </p>
      </header>
      {inquiry.text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index} className="document">
          {paragraph}
        </p>
      ))}
    </article>
  );
}

// The heavy frame is used for one thing only: something a person has to look at or decide.
export function Boxed({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="boxed">
      <h3 className="boxed__title">{title}</h3>
      {children}
    </section>
  );
}

export function Problem({ children }: { children: ReactNode }) {
  return (
    <p className="problem" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children === undefined ? null : <div className="empty__body">{children}</div>}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="loading">Loading {what}…</p>;
}
