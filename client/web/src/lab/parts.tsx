// Small pieces every page of the lab explorer uses: the loading, failed and empty states, a piece's state as
// a shape and words, and a run's result in words.

import type { ReactNode } from 'react';

import type { PieceState, RunState, TraceSummary } from '../../../shared/api.ts';
import { failureText } from './api.ts';

export function Loading({ what }: { what: string }) {
  return (
    <p className="lab-note" role="status">
      Reading {what}…
    </p>
  );
}

export function Failed({ what, error }: { what: string; error: unknown }) {
  return (
    <div className="lab-failed" role="alert">
      <p className="lab-failed__title">Could not read {what}.</p>
      <p>{failureText(error)}</p>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="lab-empty">{children}</p>;
}

export const PIECE_STATE_TEXT: Record<PieceState, string> = {
  up: 'Answering',
  down: 'Not answering',
  not_configured: 'Not set up',
};

// A filled circle for answering, a hollow square for not answering, a dashed circle for not set up: the shape
// carries the state as well as the colour does.
export function StateMark({ state }: { state: PieceState }) {
  return (
    <p className={`lab-state lab-state--${state}`}>
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" focusable="false">
        {state === 'up' ? <circle cx="6" cy="6" r="5.5" fill="currentColor" /> : null}
        {state === 'down' ? (
          <rect x="1.25" y="1.25" width="9.5" height="9.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        ) : null}
        {state === 'not_configured' ? (
          <circle cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.75" strokeDasharray="2.5 2" />
        ) : null}
      </svg>
      {PIECE_STATE_TEXT[state]}
    </p>
  );
}

type Outcome = TraceSummary['outcome'];

// A run's result in words, from its state and, once it answered, the agent's outcome.
export function runResultText(state: RunState, outcome: Outcome): string {
  if (state === 'running') {
    return 'Still running';
  }
  if (state === 'failed') {
    return 'Did not finish';
  }
  switch (outcome) {
    case 'completed':
      return 'Finished';
    case 'stopped':
      return 'Stopped before the end';
    case 'failed':
      return 'The agent could not handle it';
    case null:
      return 'Finished, with no answer';
  }
}

// Whether that result is one a reader should look at: anything but a finished run.
export function runResultTone(state: RunState, outcome: Outcome): 'good' | 'bad' | 'running' {
  if (state === 'running') {
    return 'running';
  }
  return state === 'completed' && outcome === 'completed' ? 'good' : 'bad';
}

export function ResultTag({ state, outcome }: { state: RunState; outcome: Outcome }) {
  return (
    <span className={`lab-tag lab-tag--${runResultTone(state, outcome)}`}>{runResultText(state, outcome)}</span>
  );
}
