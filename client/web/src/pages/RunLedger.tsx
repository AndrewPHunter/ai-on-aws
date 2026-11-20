import { ArrowRightLeft, Brain, CircleAlert, Search, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';

import type { Run, Step } from '../../../shared/api.ts';
import { formatDuration, pretty, stepTitle } from '../format.ts';

const ICON: Record<Step['kind'], ReactNode> = {
  model: <Brain size={16} aria-hidden="true" />,
  tool: <Wrench size={16} aria-hidden="true" />,
  retrieval: <Search size={16} aria-hidden="true" />,
  handoff: <ArrowRightLeft size={16} aria-hidden="true" />,
  error: <CircleAlert size={16} aria-hidden="true" />,
};

function Payload({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="payload">
      <p className="payload__label">{label}</p>
      <pre>{pretty(value)}</pre>
    </div>
  );
}

function StepDetail({ step }: { step: Step }) {
  switch (step.kind) {
    case 'model':
      return (
        <>
          <dl className="stepfacts">
            <div>
              <dt>Model</dt>
              <dd>{step.model}</dd>
            </div>
            <div>
              <dt>Ended because</dt>
              <dd>{step.finish_reason}</dd>
            </div>
            <div>
              <dt>Tokens in, out</dt>
              <dd>
                {step.input_tokens ?? '—'}, {step.output_tokens ?? '—'}
              </dd>
            </div>
          </dl>
          {step.text === null || step.text === '' ? null : <Payload label="What it wrote" value={step.text} />}
          {step.tool_calls.map((call, index) => (
            <Payload key={index} label={`Asked for ${call.name} with`} value={call.arguments} />
          ))}
        </>
      );
    case 'tool':
      return (
        <>
          <Payload label="Sent" value={step.arguments} />
          <Payload label={step.is_error ? 'Came back as an error' : 'Came back'} value={step.result} />
        </>
      );
    case 'retrieval':
      return (
        <>
          <dl className="stepfacts">
            <div>
              <dt>Searched for</dt>
              <dd>{step.query}</dd>
            </div>
            <div>
              <dt>Method</dt>
              <dd>{step.strategy}</dd>
            </div>
          </dl>
          {step.hits.length === 0 ? (
            <p className="absent">Nothing was found.</p>
          ) : (
            <ol className="hits">
              {step.hits.map((hit, index) => (
                <li key={index}>
                  <p className="hits__where">
                    <span>
                      {hit.drug}, {hit.section}
                    </span>
                    <span className="hits__score">{hit.score.toFixed(3)}</span>
                  </p>
                  <p className="document hits__excerpt">{hit.excerpt}</p>
                </li>
              ))}
            </ol>
          )}
        </>
      );
    case 'handoff':
      return <Payload label="Why" value={step.reason} />;
    case 'error':
      return <Payload label="What went wrong" value={step.message} />;
  }
}

export function RunLedger({ run }: { run: Run }) {
  if (run.state === 'running') {
    return (
      <div className="ledger">
        <h2>What the agent did</h2>
        <p className="ledger__none">The steps appear here when the agent finishes.</p>
      </div>
    );
  }
  if (run.response === null) {
    return (
      <div className="ledger">
        <h2>What the agent did</h2>
        <p className="ledger__none">The agent did not answer, so there are no steps to show.</p>
      </div>
    );
  }

  const { steps } = run.response;
  const total = steps.reduce((sum, step) => sum + step.duration_ms, 0);

  return (
    <div className="ledger">
      <h2>What the agent did</h2>
      <p className="ledger__sum">
        {steps.length} {steps.length === 1 ? 'step' : 'steps'}
        {run.duration_ms === null ? '' : `. The run took ${formatDuration(run.duration_ms)}`}. Handled by{' '}
        {run.response.agent.implementation}.
      </p>
      {steps.length === 0 ? <p className="ledger__none">The agent recorded no steps.</p> : null}
      <ol className="steps">
        {steps.map((step, index) => (
          <li key={index} className={`step step--${step.kind}${step.kind === 'tool' && step.is_error ? ' step--failed' : ''}`}>
            <details>
              <summary>
                <span className="step__icon">{ICON[step.kind]}</span>
                <span className="step__title">{stepTitle(step)}</span>
                <span className="step__time">{formatDuration(step.duration_ms)}</span>
                <span className="step__bar" aria-hidden="true">
                  <span style={{ width: `${total === 0 ? 0 : Math.max(2, (step.duration_ms / total) * 100)}%` }} />
                </span>
              </summary>
              <div className="step__detail">
                <StepDetail step={step} />
              </div>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
