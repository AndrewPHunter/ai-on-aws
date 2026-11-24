// One run: the message as it was received, what the run came to, and every step drawn to scale on one time
// axis. Choosing a step shows what it holds.

import { useState } from 'react';
import { Link } from 'react-router';

import type { InvocationResponse, Step, Trace, TracedRun } from '../../../shared/api.ts';
import {
  formatDateTime,
  formatDuration,
  labelAnswerText,
  labelDate,
  labelLinkText,
  pretty,
  stepTitle,
} from '../format.ts';
import { RUN_REFRESH_MS, useLabAgents, useLabRun } from './api.ts';
import { Empty, Failed, Loading, ResultTag } from './parts.tsx';

// One line of the time axis: a step of the run, or a step of another agent's response drawn under the call
// that asked for it.
type Row = {
  key: string;
  depth: 0 | 1;
  step: Step;
  // From the run's start to the step's own start.
  offsetMs: number;
};

function rowsOf(steps: readonly Step[], runStartMs: number): Row[] {
  const offset = (step: Step) => {
    const at = Date.parse(step.started_at);
    return Number.isNaN(at) ? 0 : at - runStartMs;
  };
  const rows: Row[] = [];
  steps.forEach((step, index) => {
    const key = String(index + 1);
    rows.push({ key, depth: 0, step, offsetMs: offset(step) });
    if (step.kind === 'delegation' && step.response !== null) {
      step.response.steps.forEach((inner, innerIndex) => {
        rows.push({ key: `${key}.${innerIndex + 1}`, depth: 1, step: inner, offsetMs: offset(inner) });
      });
    }
  });
  return rows;
}

const TICK_STEPS_MS = [100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

// Tick marks a reader can count: about six, each a round number of seconds.
function ticksFor(scaleMs: number): { stepMs: number; ticks: number[] } {
  const wanted = scaleMs / 6;
  const stepMs = TICK_STEPS_MS.find((candidate) => candidate >= wanted) ?? Math.ceil(wanted / 60_000) * 60_000;
  const ticks: number[] = [];
  for (let at = 0; at <= scaleMs + 1; at += stepMs) {
    ticks.push(at);
  }
  return { stepMs, ticks };
}

function tickText(ms: number): string {
  return ms > 0 && ms < 1000 ? `${ms} ms` : `${ms / 1000} s`;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function failedStep(step: Step): boolean {
  return (
    step.kind === 'error' ||
    (step.kind === 'tool' && step.is_error) ||
    (step.kind === 'delegation' && step.response === null) ||
    (step.kind === 'report_check' && step.finding === 'unknown')
  );
}

function Payload({ label, value }: { label: string; value: unknown }) {
  return (
    <>
      <h3 className="lab-subhead">{label}</h3>
      <pre className="lab-pre">{pretty(value)}</pre>
    </>
  );
}

function Facts({ facts }: { facts: readonly (readonly [string, string])[] }) {
  return (
    <dl className="lab-facts">
      {facts.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const FINDING_TEXT = {
  adverse_event: 'An adverse event',
  none: 'No adverse event',
  unknown: 'Could not be made',
} as const;

function StepContents({ step }: { step: Step }) {
  switch (step.kind) {
    case 'model':
      return (
        <>
          <Facts
            facts={[
              ['model', step.model],
              ['tokens in', step.input_tokens === null ? 'not given' : String(step.input_tokens)],
              ['tokens out', step.output_tokens === null ? 'not given' : String(step.output_tokens)],
              ['ended because', step.finish_reason],
            ]}
          />
          <p className="lab-note">
            The agent records what the model returned. What was sent to it is not part of the record.
          </p>
          {step.text === null || step.text === '' ? (
            <p className="lab-note">It wrote no text.</p>
          ) : (
            <Payload label="What it wrote" value={step.text} />
          )}
          {step.tool_calls.map((call, index) => (
            <Payload key={index} label={`Asked for ${call.name} with`} value={call.arguments} />
          ))}
        </>
      );
    case 'tool':
      return (
        <>
          <Facts
            facts={[
              ['tool', step.tool],
              ['asked for by', step.requested_by === 'agent' ? 'the agent’s own code' : 'the model'],
              ['result', step.is_error ? 'refused or did not answer' : 'answered'],
            ]}
          />
          <Payload label="Arguments" value={step.arguments} />
          <Payload label={step.is_error ? 'Came back as an error' : 'Came back'} value={step.result} />
        </>
      );
    case 'retrieval':
      return (
        <>
          <Facts facts={[['method', step.strategy]]} />
          <Payload label="Searched for" value={step.query} />
          <h3 className="lab-subhead">Hits</h3>
          {step.hits.length === 0 ? (
            <p className="lab-note">Nothing was found.</p>
          ) : (
            <ol className="lab-hits">
              {step.hits.map((hit, index) => (
                <li key={index} className={hit.shown ? undefined : 'lab-hits__unshown'}>
                  <p className="lab-hits__where">
                    <span>
                      <span className="lab-mono lab-hits__handle">{hit.handle}</span> {hit.drug}, {hit.section}
                    </span>
                    <span className="lab-mono">score {hit.score.toFixed(3)}</span>
                  </p>
                  <p className="lab-mono lab-hits__passage">{hit.passage}</p>
                  {hit.shown ? null : <p className="lab-hits__flag">Matched, but not shown to the model.</p>}
                  <p className="lab-hits__excerpt">{hit.excerpt}</p>
                </li>
              ))}
            </ol>
          )}
        </>
      );
    case 'delegation':
      return (
        <>
          <Facts
            facts={[
              ['called', step.to_agent],
              ['call', step.id],
              ['asked for by', step.requested_by === 'agent' ? 'the agent’s own code' : 'the model'],
              ...(step.replaces === null ? [] : [['replaces', step.replaces] as const]),
            ]}
          />
          <Payload label={`Sent as message ${step.message.id}`} value={step.message.text} />
          {step.failure === null ? null : <Payload label="Why there is no answer" value={step.failure} />}
          {step.response === null ? null : (
            <>
              <Facts
                facts={[
                  ['outcome', step.response.outcome],
                  ['stopped because', step.response.stop_reason ?? 'not given'],
                  ['handled by', step.response.agent.implementation],
                ]}
              />
              <Payload label="Its reply" value={step.response.reply} />
              <p className="lab-note">
                {step.response.steps.length === 0
                  ? 'It recorded no steps.'
                  : `Its ${step.response.steps.length} ${step.response.steps.length === 1 ? 'step is' : 'steps are'} drawn indented under this one on the time axis.`}
              </p>
            </>
          )}
        </>
      );
    case 'report_check':
      return (
        <>
          <p className="lab-note">
            Made by the agent’s own code, not asked for by the model: a separate request that showed the model only
            the message and kept only its yes or no.
          </p>
          <Facts
            facts={[
              ['model', step.model],
              ['finding', FINDING_TEXT[step.finding]],
            ]}
          />
        </>
      );
    case 'error':
      return <Payload label="What went wrong" value={step.message} />;
  }
}

function StepDetail({ row }: { row: Row }) {
  return (
    <section className="lab-panel lab-detail" id="lab-step-detail" aria-labelledby="lab-step-detail-title">
      <h2 id="lab-step-detail-title" className="lab-detail__title">
        Step {row.key}: {stepTitle(row.step)}
      </h2>
      <Facts
        facts={[
          ['kind', row.step.kind],
          ['took', formatDuration(row.step.duration_ms)],
          ['started', `${formatDuration(Math.max(0, row.offsetMs))} into the run`],
        ]}
      />
      <StepContents step={row.step} />
    </section>
  );
}

function Timeline({
  run,
  response,
  rows,
  selected,
  onSelect,
}: {
  run: TracedRun;
  response: InvocationResponse;
  rows: readonly Row[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const ends = rows.map((row) => row.offsetMs + row.step.duration_ms);
  const scaleMs = Math.max(1, run.duration_ms ?? 0, ...ends);
  const { stepMs, ticks } = ticksFor(scaleMs);
  const percent = (ms: number) => (ms / scaleMs) * 100;
  const gridSize = `${percent(stepMs)}% 100%`;

  return (
    <section className="lab-panel lab-axis" aria-labelledby="lab-axis-title">
      <div className="lab-axis__row lab-axis__header">
        <h2 id="lab-axis-title" className="lab-axis__label">
          What the agent did
        </h2>
        <div className="lab-axis__scale lab-mono" aria-hidden="true">
          {ticks.map((at) => {
            const left = clampPercent(percent(at));
            const shift = at === 0 ? '0' : left > 88 ? '-100%' : '-50%';
            return (
              <span key={at} style={{ left: `${left}%`, transform: `translateX(${shift})` }}>
                {tickText(at)}
              </span>
            );
          })}
        </div>
      </div>
      <p className="lab-note">
        {response.steps.length} {response.steps.length === 1 ? 'step' : 'steps'}
        {rows.length > response.steps.length
          ? `, and ${rows.length - response.steps.length} more inside calls to other agents, drawn indented`
          : ''}
        . Each bar starts when its step started and is as wide as it took. Choose a step to see what it holds.
      </p>
      {rows.length === 0 ? (
        <Empty>The agent recorded no steps.</Empty>
      ) : (
        <ol className="lab-steps">
          {rows.map((row) => {
            const isSelected = row.key === selected;
            const left = clampPercent(percent(row.offsetMs));
            const width = Math.min(100 - left, percent(row.step.duration_ms));
            const classes = [
              'lab-step',
              row.depth === 1 ? 'lab-step--nested' : '',
              isSelected ? 'is-selected' : '',
              failedStep(row.step) ? 'is-failed' : '',
            ]
              .filter((name) => name !== '')
              .join(' ');
            return (
              <li key={row.key} className={classes}>
                <button
                  type="button"
                  className="lab-axis__label lab-step__button"
                  aria-pressed={isSelected}
                  aria-controls="lab-step-detail"
                  onClick={() => onSelect(row.key)}
                >
                  <span className="lab-step__name">
                    <span className="lab-mono lab-step__number">{row.key}</span>
                    {row.depth === 1 ? <span className="lab-visually-hidden">Inside the call above: </span> : null}
                    {stepTitle(row.step)}
                  </span>
                  <span className="lab-mono lab-step__time">{formatDuration(row.step.duration_ms)}</span>
                </button>
                <div className="lab-axis__scale lab-step__track" style={{ backgroundSize: gridSize }} aria-hidden="true">
                  <div className="lab-step__bar" style={{ left: `${left}%`, width: `max(3px, ${width}%)` }} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

const ACTION_TEXT = {
  case_opened: 'opened',
  case_already_open: 'was already open for this message',
  follow_up_recorded: 'had a follow-up added',
} as const;

function RunOutcome({ run }: { run: TracedRun }) {
  if (run.state === 'running') {
    return (
      <p className="lab-note" role="status">
        The agent is still working on this. The page asks again every {RUN_REFRESH_MS / 1000} seconds.
      </p>
    );
  }
  if (run.response === null) {
    return (
      <div className="lab-failed">
        <p className="lab-failed__title">The run did not finish.</p>
        <p>{run.error ?? 'No reason was recorded.'}</p>
      </div>
    );
  }
  const { response } = run;
  return (
    <>
      <Facts
        facts={[
          ['outcome', response.outcome],
          ['stopped because', response.stop_reason ?? 'not given'],
          ...(response.label_answer === undefined ? [] : [['label', labelAnswerText(response.label_answer)] as const]),
        ]}
      />
      <h3 className="lab-subhead">Case actions</h3>
      {response.case_actions.length === 0 ? (
        <p className="lab-note">It acted on no case.</p>
      ) : (
        <ul className="lab-list">
          {response.case_actions.map((action) => (
            <li key={`${action.kind}-${action.case_id}`}>
              Case <span className="lab-mono">{action.case_id}</span> {ACTION_TEXT[action.kind]}. Its status was{' '}
              <span className="lab-mono">{action.status}</span>.
            </li>
          ))}
        </ul>
      )}
      <h3 className="lab-subhead">Reply</h3>
      {response.reply.trim() === '' ? (
        <p className="lab-note">The agent wrote no reply.</p>
      ) : (
        <pre className="lab-pre lab-pre--prose">{response.reply}</pre>
      )}
      <h3 className="lab-subhead">Label passages it cites</h3>
      {response.citations.length === 0 ? (
        <p className="lab-note">It cites none.</p>
      ) : (
        <ol className="lab-citations">
          {response.citations.map((citation, index) => (
            <li key={index}>
              <p className="lab-citations__where">
                <span className="lab-mono">[{index + 1}]</span> {citation.drug}, {citation.section}
              </p>
              <p className="lab-mono lab-citations__version">
                version {citation.version}, {labelDate(citation.effective_date)}, passage {citation.passage}
              </p>
              <blockquote>{citation.quote}</blockquote>
              <p>
                <a href={citation.source} target="_blank" rel="noopener noreferrer">
                  {labelLinkText(citation.source, citation.version)}
                </a>
              </p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function RunView({ trace, agentName }: { trace: Trace; agentName: string }) {
  const { run, inquiry } = trace;
  const response = run.response;
  const runStartMs = Date.parse(run.started_at);
  const rows = response === null || Number.isNaN(runStartMs) ? [] : rowsOf(response.steps, runStartMs);
  const [chosen, setChosen] = useState<string | null>(null);
  const selectedKey = chosen ?? rows[0]?.key ?? null;
  const selectedRow = rows.find((row) => row.key === selectedKey);

  return (
    <>
      <nav aria-label="Where you are" className="lab-crumbs">
        <Link to="/lab/runs">Runs</Link> <span aria-hidden="true">/</span>{' '}
        <span className="lab-mono">{run.id}</span>
      </nav>

      <div className="lab-runhead">
        <h1>Run of {agentName}</h1>
        <span className="lab-mono lab-runhead__time">
          {run.duration_ms === null ? 'still timing' : formatDuration(run.duration_ms)}
        </span>
        <ResultTag state={run.state} outcome={response?.outcome ?? null} />
      </div>
      <p className="lab-lede">
        Started {formatDateTime(run.started_at)} by {run.started_by?.name ?? 'someone not recorded'}.
        {response === null ? '' : ` Handled by ${response.agent.implementation}.`} Agent{' '}
        <span className="lab-mono">{run.agent_id}</span>, inquiry <span className="lab-mono">{inquiry.id}</span>.
      </p>

      <section className="lab-panel" aria-labelledby="lab-message-title">
        <h2 id="lab-message-title">The message as it was received</h2>
        <Facts
          facts={[
            ['from', inquiry.sender],
            ['received', formatDateTime(inquiry.received_at)],
            ['entered by', inquiry.entered_by?.name ?? 'not recorded'],
          ]}
        />
        <pre className="lab-pre lab-pre--prose">{inquiry.text}</pre>
      </section>

      {response === null ? (
        <section className="lab-panel" aria-labelledby="lab-axis-none">
          <h2 id="lab-axis-none">What the agent did</h2>
          <p className="lab-note">
            {run.state === 'running'
              ? 'The steps are drawn here when the agent finishes.'
              : 'The agent did not answer, so there are no steps to draw.'}
          </p>
        </section>
      ) : (
        <Timeline run={run} response={response} rows={rows} selected={selectedKey} onSelect={setChosen} />
      )}

      <div className="lab-pair">
        {selectedRow === undefined ? null : <StepDetail row={selectedRow} />}
        <section className="lab-panel lab-result" aria-labelledby="lab-result-title">
          <h2 id="lab-result-title">What the run came to</h2>
          <RunOutcome run={run} />
        </section>
      </div>
    </>
  );
}

export function RunPage({ runId }: { runId: string }) {
  const trace = useLabRun(runId);
  const agents = useLabAgents();

  if (trace.isPending) {
    return <Loading what="the run" />;
  }
  if (trace.isError) {
    return (
      <>
        <nav aria-label="Where you are" className="lab-crumbs">
          <Link to="/lab/runs">Runs</Link> <span aria-hidden="true">/</span>{' '}
          <span className="lab-mono">{runId}</span>
        </nav>
        <Failed what="this run" error={trace.error} />
        <p>
          <Link to="/lab/runs">Back to every run</Link>
        </p>
      </>
    );
  }
  const { run } = trace.data.trace;
  const agentName = agents.data?.agents.find((agent) => agent.id === run.agent_id)?.name ?? run.agent_id;
  return <RunView key={run.id} trace={trace.data.trace} agentName={agentName} />;
}
