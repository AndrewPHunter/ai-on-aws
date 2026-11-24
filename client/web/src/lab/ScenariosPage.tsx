// The prepared inquiries the desk offers, each with what sending it should show. Read-only.

import { useLabSamples } from './api.ts';
import { Empty, Failed, Loading } from './parts.tsx';

export function ScenariosPage() {
  const samples = useLabSamples();

  return (
    <>
      <div className="lab-intro">
        <div>
          <h1>Scenarios</h1>
          <p className="lab-lede">
            The prepared inquiries the desk offers. Each says what sending it should show. Send one from the desk;
            its run then appears under Runs.
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
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
