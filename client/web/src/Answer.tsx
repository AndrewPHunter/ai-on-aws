// What a run came to, as the person at the desk reads it: while it runs, how long it has been going; when it
// failed or did not complete, what happened and why; when it completed, whether the label answered, the reply
// and the label passages it relies on. Used by the inbox and by "Ask the label".

import type { Citation, Run } from '../../shared/api.ts';
import { CopyButton, Elapsed, Paragraphs, Problem } from './components.tsx';
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

      <section className="stack" aria-labelledby="reply-title">
        <div className="sectionhead">
          <h2 id="reply-title">{replyTitle}</h2>
          {response.reply.trim() === '' ? null : <CopyButton text={response.reply} label="Copy reply" />}
        </div>
        <div className="card card--reading writing">
          {response.reply.trim() === '' ? <p className="absent">No reply was written.</p> : <Paragraphs text={response.reply} />}
        </div>
      </section>

      {response.citations.length === 0 ? null : <Passages citations={response.citations} />}
    </>
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
