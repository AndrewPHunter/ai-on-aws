// Small pieces used on more than one screen.

import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { CaseStatus } from '../../shared/api.ts';
import { STATUS_LABEL, formatElapsed } from './format.ts';
import type { Tone } from './inbox.ts';

// A status in words on its own colour. The words always differ, so colour is never the only signal.
export function Tag({ tone, children }: { tone: Tone | CaseStatus; children: ReactNode }) {
  return <span className={`tag tag--${tone}`}>{children}</span>;
}

export function CaseStatusTag({ status }: { status: CaseStatus }) {
  return <Tag tone={status}>{STATUS_LABEL[status]}</Tag>;
}

// Text a person wrote, split into its paragraphs.
export function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </>
  );
}

// Time since `since`, counted on screen each second.
export function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="elapsed">{formatElapsed(now - new Date(since).getTime())}</span>;
}

type CopyState = 'idle' | 'copied' | 'failed';

// Copies `text` to the clipboard, and says so for a moment once it has.
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<CopyState>('idle');
  useEffect(() => {
    if (state !== 'copied') {
      return;
    }
    const timer = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);

  function copy(): void {
    navigator.clipboard.writeText(text).then(
      () => setState('copied'),
      () => setState('failed'),
    );
  }

  return (
    <span className="copy">
      <button type="button" className="button button--primary" onClick={copy}>
        {state === 'copied' ? 'Copied' : label}
      </button>
      <span className="copy__status" role="status">
        {state === 'failed' ? 'The browser did not allow copying. Select the text and copy it instead.' : ''}
      </span>
    </span>
  );
}

// The heavy frame. Used for one thing on the desk: the decision on a case.
export function Boxed({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="boxed">
      <h2 className="boxed__title">{title}</h2>
      {children}
    </section>
  );
}

export function Problem({ children }: { children: ReactNode }) {
  return (
    <div className="problem" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <div>{children}</div>
    </div>
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
