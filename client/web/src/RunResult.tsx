// What one run came to, as a person reads it: the outcome when it was not completed, the cases it acted on,
// whether the label answered, the reply and the label passages it cites. A run still working, or with no
// response, says so instead. Used by the inquiry page and by a run's trace.

import { Link } from 'react-router';

import type { Run } from '../../shared/api.ts';
import { Boxed, Problem } from './components.tsx';
import { formatDateTime, labelAnswerText, labelDate, labelLinkText } from './format.ts';

const ACTION_TEXT = {
  case_opened: 'opened',
  case_already_open: 'was already open for this message',
  follow_up_recorded: 'had a follow-up added',
} as const;

export function RunResult({ run }: { run: Run }) {
  if (run.state === 'running') {
    return (
      <p className="working">
        <span className="pulse" aria-hidden="true" /> The agent is working on this. Started{' '}
        {formatDateTime(run.started_at)}.
      </p>
    );
  }
  if (run.state === 'failed' || run.response === null) {
    return <Problem>{run.error ?? 'The run did not finish, and no reason was recorded.'}</Problem>;
  }

  const { response } = run;
  return (
    <>
      {response.outcome === 'completed' ? null : (
        <Problem>
          {response.outcome === 'stopped' ? 'The agent stopped before finishing' : 'The agent could not handle this'}
          {response.stop_reason === null ? '.' : `: ${response.stop_reason}`}
        </Problem>
      )}

      {response.case_actions.length === 0 ? null : (
        <Boxed title="An adverse event was reported in this message">
          <ul className="caseactions">
            {response.case_actions.map((action) => (
              <li key={`${action.kind}-${action.case_id}`}>
                Case <Link to={`/cases/${action.case_id}`}>{action.case_id}</Link> {ACTION_TEXT[action.kind]}. Its
                status was {action.status.replace(/_/g, ' ')}.
              </li>
            ))}
          </ul>
        </Boxed>
      )}

      {response.label_answer === undefined ? null : (
        <p className="labelanswer">{labelAnswerText(response.label_answer)}</p>
      )}

      <article className="reply" aria-label="Reply to the sender">
        <h3>Reply</h3>
        {response.reply.trim() === '' ? (
          <p className="absent">The agent wrote no reply.</p>
        ) : (
          response.reply.split(/\n{2,}/).map((paragraph, index) => (
            <p key={index} className="document">
              {paragraph}
            </p>
          ))
        )}
      </article>

      {response.citations.length === 0 ? null : (
        <section className="citations" aria-label="Passages of the label the reply relies on">
          <h3>From the approved label</h3>
          {/* Numbered from 1 in order, so a [2] in the reply can be found here. */}
          <ol>
            {response.citations.map((citation, index) => (
              <li key={index}>
                <p className="citations__where">
                  <span className="citations__number">[{index + 1}]</span>
                  <span className="citations__drug">{citation.drug}</span>
                  <span className="citations__section">{citation.section}</span>
                </p>
                <p className="citations__version">
                  Label version {citation.version}, {labelDate(citation.effective_date)}
                </p>
                <blockquote className="document">{citation.quote}</blockquote>
                <p className="citations__source">
                  <a href={citation.source} target="_blank" rel="noopener noreferrer">
                    {labelLinkText(citation.source, citation.version)}
                  </a>
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
