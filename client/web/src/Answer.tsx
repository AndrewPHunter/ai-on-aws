// What a run came to, as the person at the desk reads it: while it runs, how long it has been going; when it
// failed or did not complete, what happened and why; when it completed, whether the label answered, the reply
// (which the person may edit before copying it) and the label passages it relies on. Used by the inbox and by
// "Ask the label".

import { useEffect, useRef, useState } from 'react';

import type { Citation, Run } from '../../shared/api.ts';
import { CopyButton, Elapsed, Paragraphs, Problem } from './components.tsx';
import { useDraftEdit } from './drafts.tsx';
import { labelAnswerText, labelDate, labelLinkText } from './format.ts';

export function RunAnswer({ run, working, replyTitle }: { run: Run; working: string; replyTitle: string }) {
  if (run.state === 'running') {
    return (
      <p className="working">
        <span className="pulse" aria-hidden="true" />
        <span>
          {working} <Elapsed since={run.started_at} />
        </span>
      </p>
    );
  }
  if (run.state === 'failed' || run.response === null) {
    return (
      <Problem>
        <p className="problem__title">This could not be handled.</p>
        <p>{run.error ?? 'No reason was recorded.'}</p>
        <p>Answer it yourself, or log it again once the cause is fixed.</p>
      </Problem>
    );
  }

  const { response } = run;
  if (response.outcome !== 'completed') {
    return (
      <Problem>
        <p className="problem__title">
          {response.outcome === 'stopped' ? 'Handling stopped before it finished.' : 'This could not be handled.'}
        </p>
        <p>{response.stop_reason ?? 'No reason was given.'}</p>
        <p>Read the message and answer it yourself.</p>
      </Problem>
    );
  }

  return (
    <>
      {response.label_answer === undefined ? null : (
        <p className="labelanswer">{labelAnswerText(response.label_answer)}</p>
      )}

      <Reply runId={run.id} agentText={response.reply} title={replyTitle} />

      {response.citations.length === 0 ? null : <Passages citations={response.citations} />}
    </>
  );
}

// Where focus goes once the controls have changed: Edit removes itself, Done and Reset may too.
type FocusNext = 'text' | 'edit' | null;

// The reply, as the agent wrote it or as the person has edited it. "Copy reply" copies what is shown. An edit is
// kept for this run, in this page's memory only (see drafts.tsx).
function Reply({ runId, agentText, title }: { runId: string; agentText: string; title: string }) {
  const draft = useDraftEdit(runId);
  const [editing, setEditing] = useState(false);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<FocusNext>(null);

  const shown = draft.text ?? agentText;
  const edited = shown !== agentText;

  useEffect(() => {
    const target = focusNext.current === 'text' ? textArea.current : focusNext.current === 'edit' ? editButton.current : null;
    focusNext.current = null;
    target?.focus();
  }, [editing, edited]);

  function startEditing(): void {
    focusNext.current = 'text';
    setEditing(true);
  }

  function stopEditing(): void {
    focusNext.current = 'edit';
    setEditing(false);
  }

  function reset(): void {
    focusNext.current = editing ? 'text' : 'edit';
    draft.reset();
  }

  return (
    <section className="stack" aria-labelledby="reply-title">
      <div className="sectionhead">
        <h2 id="reply-title">{edited ? `${title}, edited` : title}</h2>
        <span className="sectionhead__actions">
          {editing ? (
            <button type="button" className="button" onClick={stopEditing}>
              Done
            </button>
          ) : (
            <button type="button" className="button" ref={editButton} onClick={startEditing}>
              Edit
            </button>
          )}
          {shown.trim() === '' ? null : <CopyButton text={shown} label="Copy reply" />}
        </span>
      </div>
      {editing ? (
        <div className="field reply__field">
          <textarea
            ref={textArea}
            className="writing"
            rows={Math.min(24, Math.max(8, shown.split('\n').length + 2))}
            value={shown}
            aria-labelledby="reply-title"
            aria-describedby="reply-unsaved"
            onChange={(event) => draft.change(event.target.value)}
          />
        </div>
      ) : (
        <div className="card card--reading writing">
          {shown.trim() === '' ? <p className="absent">No reply was written.</p> : <Paragraphs text={shown} />}
        </div>
      )}
      {editing || edited ? (
        <p id="reply-unsaved" className="reply__unsaved">
          Your changes are not saved. Copy the reply before you leave this page.
        </p>
      ) : null}
      {edited ? (
        <div className="actions">
          <button type="button" className="button" onClick={reset}>
            Reset to the agent’s draft
          </button>
        </div>
      ) : null}
    </section>
  );
}

// Numbered from 1 in order, so a [2] in the reply can be found here.
function Passages({ citations }: { citations: readonly Citation[] }) {
  return (
    <section className="stack" aria-labelledby="passages-title">
      <h2 id="passages-title">From the approved label</h2>
      <ol className="passages">
        {citations.map((citation, index) => (
          <li key={index} className="card passage">
            <p className="passage__where">
              [{index + 1}] {citation.drug}
            </p>
            <p className="passage__meta">
              {citation.section}. Label version {citation.version}, {labelDate(citation.effective_date)}.
            </p>
            <blockquote className="writing">{citation.quote}</blockquote>
            <a href={citation.source} target="_blank" rel="noopener noreferrer">
              {labelLinkText(citation.source, citation.version)}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
