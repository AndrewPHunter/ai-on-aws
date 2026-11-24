// One run: the message as it was received, the evidence each piece exported for it, what the run came to, and every
// step drawn to scale on one time axis. Choosing a step shows what it holds. Beside it, every run of the same message,
// and a control to run the message again.

import { useState } from 'react';
import { Link } from 'react-router';

import type { ExportedSpan, InvocationResponse, Step, Trace, TracedRun } from '../../../shared/api.ts';
import {
  formatDateTime,
  formatDuration,
  labelAnswerText,
  labelDate,
  labelLinkText,
  pretty,
  stepTitle,
} from '../format.ts';
import { EVIDENCE_GRACE_MS, RUN_REFRESH_MS, readWhileSettling, useLabAgents, useLabInquiry, useLabRun, useLabRunSpans } from './api.ts';
import { Empty, Failed, Loading, ResultTag } from './parts.tsx';
import { RunControl } from './RunControl.tsx';

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

// The service the client exports as, and the case system's: the client's spans are drawn first and the case system's
// last, every other service (the agents) between them in the order it first started.
const CLIENT_SERVICE = 'client';
const CASE_SYSTEM_SERVICE = 'case-system';

// The closed list of outcomes a span may carry (shared/telemetry-attributes.ts), in words.
const SPAN_OUTCOME_TEXT: Readonly<Record<string, string>> = {
  completed: 'Completed',
  stopped: 'Stopped before the end',
  failed: 'Failed',
  executed: 'An answer came back',
  refused: 'Refused, nothing was done',
  response_lost: 'No answer came back',
  created: 'Created',
  replayed: 'Already done, answered again',
  conflict: 'Declined as a conflict',
};

function spanOutcomeText(span: ExportedSpan): string {
  const outcome = span.attributes['lab.outcome'];
  const words = typeof outcome === 'string' ? SPAN_OUTCOME_TEXT[outcome] : undefined;
  if (words !== undefined) return words;
  return span.status === 'error' ? 'Ended with an error' : 'Ended';
}

type EvidenceRow = { span: ExportedSpan; depth: number; startMs: number; endMs: number };
type ServiceGroup = { service: string; rows: EvidenceRow[] };

const spanKey = (traceId: string, spanId: string) => `${traceId}/${spanId}`;

// One service's spans, each child right under its parent and indented one more, when the parent is a span of the same
// service; any other span starts a line of its own. The spans come in start order, and keep it among siblings.
function treeRows(spans: readonly ExportedSpan[]): EvidenceRow[] {
  const present = new Set(spans.map((span) => spanKey(span.trace_id, span.span_id)));
  const children = new Map<string, ExportedSpan[]>();
  const tops: ExportedSpan[] = [];
  for (const span of spans) {
    const parent = span.parent === null ? null : spanKey(span.trace_id, span.parent);
    if (parent !== null && parent !== spanKey(span.trace_id, span.span_id) && present.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), span]);
    } else {
      tops.push(span);
    }
  }
  const rows: EvidenceRow[] = [];
  const seen = new Set<string>();
  const visit = (span: ExportedSpan, depth: number) => {
    const key = spanKey(span.trace_id, span.span_id);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ span, depth, startMs: Date.parse(span.start), endMs: Date.parse(span.end) });
    for (const child of children.get(key) ?? []) visit(child, depth + 1);
  };
  tops.forEach((span) => visit(span, 0));
  // A span whose parents loop back to it is reached from no top line: it is drawn as one.
  spans.forEach((span) => visit(span, 0));
  return rows;
}

function serviceGroups(spans: readonly ExportedSpan[]): ServiceGroup[] {
  const byService = new Map<string, ExportedSpan[]>();
  for (const span of spans) {
    const service = span.service ?? '(no service name)';
    byService.set(service, [...(byService.get(service) ?? []), span]);
  }
  const rank = (service: string) => (service === CLIENT_SERVICE ? 0 : service === CASE_SYSTEM_SERVICE ? 2 : 1);
  // The map keeps the order each service first appears in, which is the order it first started; the sort is stable.
  return [...byService.keys()]
    .sort((a, b) => rank(a) - rank(b))
    .map((service) => ({ service, rows: treeRows(byService.get(service) ?? []) }));
}

// The spans every piece exported for this run, read from the trace store, on one time axis.
function Evidence({ run }: { run: TracedRun }) {
  const running = run.state === 'running';
  const read = useLabRunSpans(run.id, running, run.finished_at);
  const spans = read.data?.spans ?? [];
  const groups = serviceGroups(spans);
  const rows = groups.flatMap((group) => group.rows);
  const startMs = Math.min(...rows.map((row) => row.startMs));
  const scaleMs = Math.max(1, ...rows.map((row) => row.endMs - startMs));
  const { stepMs, ticks } = ticksFor(scaleMs);
  const percent = (ms: number) => (ms / scaleMs) * 100;
  const ofClient = (name: string) => spans.some((span) => span.service === CLIENT_SERVICE && span.name === name);
  const unfinished = ofClient('desk.run.accepted') && !ofClient('desk.run');
  // The run has ended in the client's store, and the evidence was last read soon enough after that that some of it may
  // still be on its way to the trace store.
  const settling = !running && read.data !== undefined && read.data.evidence !== 'not_configured' && readWhileSettling(read.dataUpdatedAt, run.finished_at);
  const graceSeconds = EVIDENCE_GRACE_MS / 1000;

  return (
    <section className="lab-panel lab-axis" aria-labelledby="lab-evidence-title">
      <div className="lab-axis__row lab-axis__header">
        <h2 id="lab-evidence-title" className="lab-axis__label">
          Exported evidence
        </h2>
        {rows.length === 0 ? null : (
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
        )}
      </div>
      <p className="lab-note">
        Each piece exported these spans itself as it worked; the steps below came back in the agent’s answer.
      </p>
      {read.isPending ? <Loading what="the exported evidence" /> : null}
      {read.isError ? <Failed what="the exported evidence" error={read.error} /> : null}
      {read.data?.evidence === 'not_configured' ? (
        <Empty>TELEMETRY_STORE_URL is not set, so what was exported for this run cannot be read.</Empty>
      ) : null}
      {read.data?.evidence === 'none' ? (
        <Empty>
          {running || settling
            ? 'Nothing exported for this run has reached the trace store yet.'
            : 'Nothing was exported for this run: telemetry was off when it ran, or the trace store no longer holds its spans.'}
        </Empty>
      ) : null}
      {unfinished ? (
        <p className="lab-note" role="status">
          {running
            ? 'The run has not finished, so no ending has been exported yet.'
            : settling
              ? 'The run has ended in the client’s store, and its ending has not reached the trace store yet.'
              : 'The run did not finish while the client was running: its trace has the accepted span and no desk.run, and no ending was exported.'}
        </p>
      ) : null}
      {running && read.data !== undefined ? (
        <p className="lab-note">The run is still going. The evidence is asked for again every {RUN_REFRESH_MS / 1000} seconds.</p>
      ) : null}
      {settling ? (
        <p className="lab-note">
          The run ended less than {graceSeconds} seconds ago, so spans may still be arriving. The evidence is asked for again
          every {RUN_REFRESH_MS / 1000} seconds until then.
        </p>
      ) : null}
      {groups.map((group) => (
        <div key={group.service} className="lab-spans">
          <h3 className="lab-subhead lab-mono">{group.service}</h3>
          <ol className="lab-steps">
            {group.rows.map((row) => {
              const left = clampPercent(percent(row.startMs - startMs));
              const width = Math.min(100 - left, percent(row.endMs - row.startMs));
              const attempt = row.span.attributes['lab.attempt'];
              const classes = ['lab-step', 'lab-span', row.depth > 0 ? 'lab-step--nested' : '', row.span.status === 'error' ? 'is-failed' : '']
                .filter((name) => name !== '')
                .join(' ');
              return (
                <li key={spanKey(row.span.trace_id, row.span.span_id)} className={classes}>
                  <div className="lab-axis__label lab-span__label" style={{ paddingLeft: `${4 + Math.min(row.depth, 6) * 18}px` }}>
                    <span className="lab-span__name">
                      {row.depth > 0 ? <span className="lab-visually-hidden">Inside the span above: </span> : null}
                      <span className="lab-mono">{row.span.name}</span>
                      <span className="lab-span__outcome">
                        {spanOutcomeText(row.span)}
                        {typeof attempt === 'number' && attempt > 1 ? `, attempt ${attempt}` : ''}
                      </span>
                    </span>
                    <span className="lab-mono lab-step__time">{formatDuration(Math.max(0, row.endMs - row.startMs))}</span>
                  </div>
                  <div className="lab-axis__scale lab-step__track" style={{ backgroundSize: `${percent(stepMs)}% 100%` }} aria-hidden="true">
                    <div className="lab-step__bar" style={{ left: `${left}%`, width: `max(3px, ${width}%)` }} />
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
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

// What a completed run did, in words a reader can compare across agents: whether it acted on a case, and
// whether it answered from the label.
function didWords(response: InvocationResponse): string {
  const acted = response.case_actions.length > 0;
  // The orchestrator sets no label_answer; its citations are those of the expert replies it shows.
  const answered = response.label_answer === 'answered' || response.citations.length > 0;
  if (acted && answered) return 'Case and answer';
  if (acted) return 'Case only';
  if (answered) return 'Answer only';
  return 'No case, no answer';
}

// Every run of this run's message, by any agent, with this one marked; and a control to run it again.
function SameMessage({ run, agentName }: { run: TracedRun; agentName: (agentId: string) => string }) {
  const inquiry = useLabInquiry(run.inquiry_id);
  const runs = inquiry.data?.inquiry.runs ?? [];

  return (
    <section className="lab-panel" aria-labelledby="lab-same-title">
      <h2 id="lab-same-title">The same message, every agent</h2>
      {inquiry.isPending ? <Loading what="the runs of this message" /> : null}
      {inquiry.isError ? <Failed what="the runs of this message" error={inquiry.error} /> : null}
      {inquiry.data === undefined ? null : (
        <div className="lab-scroll">
          <table className="lab-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Result</th>
                <th scope="col" className="lab-table__num">
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((other) => {
                const current = other.id === run.id;
                return (
                  <tr key={other.id} className={current ? 'lab-row--current' : undefined}>
                    <th scope="row">
                      {current ? (
                        <span aria-current="page">{agentName(other.agent_id)}</span>
                      ) : (
                        <Link to={`/lab/runs/${encodeURIComponent(other.id)}`}>{agentName(other.agent_id)}</Link>
                      )}
                      <span className="lab-mono lab-table__sub">
                        {other.agent_id}
                        {current ? ', this run' : ''}
                      </span>
                    </th>
                    <td>
                      <ResultTag state={other.state} outcome={other.response?.outcome ?? null} />
                      {other.response === null ? null : (
                        <span className="lab-table__sub">{didWords(other.response)}</span>
                      )}
                    </td>
                    <td className="lab-mono lab-table__num">
                      {other.duration_ms !== null
                        ? formatDuration(other.duration_ms)
                        : other.state === 'running'
                          ? 'still timing'
                          : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {runs.some((other) => other.state === 'running') ? (
        <p className="lab-note" role="status">
          A run is still going. The table asks again every {RUN_REFRESH_MS / 1000} seconds.
        </p>
      ) : null}
      <RunControl
        id="lab-run-again"
        label="Run this message again through"
        message={{ inquiry_id: run.inquiry_id }}
        withAll={false}
        preferred={run.agent_id}
      />
    </section>
  );
}

function RunView({
  trace,
  agentName,
  agentNameOf,
}: {
  trace: Trace;
  agentName: string;
  agentNameOf: (agentId: string) => string;
}) {
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

      <Evidence run={run} />

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
        <div className="lab-side">
          <section className="lab-panel" aria-labelledby="lab-result-title">
            <h2 id="lab-result-title">What the run came to</h2>
            <RunOutcome run={run} />
          </section>
          <SameMessage run={run} agentName={agentNameOf} />
        </div>
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
  const agentNameOf = (agentId: string) =>
    agents.data?.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  return (
    <RunView key={run.id} trace={trace.data.trace} agentName={agentNameOf(run.agent_id)} agentNameOf={agentNameOf} />
  );
}
