// Small pieces used on more than one screen.

import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';

import type { CaseStatus, PieceState, RunState } from '../../shared/api.ts';
import { RUN_STATE_LABEL, STATUS_LABEL } from './format.ts';

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

const PIECE_LABEL: Record<PieceState, string> = { up: 'Running', down: 'Not reachable', not_built: 'Not built yet' };

export function PieceBadge({ state }: { state: PieceState }) {
  return <span className={`badge badge--piece-${state}`}>{PIECE_LABEL[state]}</span>;
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
