// The prepared inquiries, each with what sending it should show, and a control that runs it through an agent,
// or through every agent, as the lab explorer.

import { useLabSamples } from './api.ts';
import { Empty, Failed, Loading } from './parts.tsx';
import { RunControl } from './RunControl.tsx';

export function ScenariosPage() {
  const samples = useLabSamples();

  return (
    <>
      <div className="lab-intro">
        <div>
          <h1>Scenarios</h1>
          <p className="lab-lede">
            Prepared messages, each written to show one behaviour. Each says what sending it should show. Running
            one sends it as the lab explorer, not as a person, and opens the run.
          </p>
        </div>
      </div>

      {samples.isPending ? <Loading what="the prepared inquiries" /> : null}
      {samples.isError ? <Failed what="the prepared inquiries" error={samples.error} /> : null}
      {samples.data === undefined ? null : samples.data.samples.length === 0 ? (
        <Empty>The server offers no prepared inquiry.</Empty>
      ) : (
        <ol className="lab-scenarios">
          {samples.data.samples.map((sample) => (
            <li key={sample.id} className="lab-panel">
              <div className="lab-piece__head">
                <h2>{sample.title}</h2>
                <span className="lab-mono lab-piece__id">{sample.id}</span>
              </div>
              <dl className="lab-facts">
                <div>
                  <dt>from</dt>
                  <dd>{sample.sender}</dd>
                </div>
              </dl>
              <h3 className="lab-subhead">Message</h3>
              <pre className="lab-pre lab-pre--prose">{sample.text}</pre>
              <h3 className="lab-subhead">What it should show</h3>
              <p>{sample.shows}</p>
              <RunControl
                id={`lab-run-${sample.id}`}
                label="Run it through"
                message={{ sender: sample.sender, text: sample.text }}
                withAll
              />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
