// What the label index holds, and a label search made the way the label expert makes one: find the label, then
// search it. Everything shown is what the search engine and the retrieval service answered, read at run time.

import { useState } from 'react';
import type { FormEvent } from 'react';

import type { FoundLabel, FoundPassage, KnowledgeCall, KnowledgeSearchResponse, LabelIndex } from '../../../shared/api.ts';
import { formatDateTime, formatDuration, labelDate, labelLinkText, pretty } from '../format.ts';
import { failureText, useLabKnowledge, useLabelSearch } from './api.ts';
import { Failed, Loading } from './parts.tsx';

// The retrieval service's own limits, which the server checks too.
const MAX_MEDICINE = 200;
const MAX_QUESTION = 1000;

export function KnowledgePage() {
  return (
    <>
      <div className="lab-intro">
        <div>
          <h1>Knowledge</h1>
          <p className="lab-lede">
            The label index the retrieval service searches, as the search engine reports it, and a search through the
            service as the label expert makes one: find the label by the medicine&rsquo;s name, then search it for the
            question.
          </p>
        </div>
      </div>
      <IndexPanel />
      <SearchPanel />
    </>
  );
}

function IndexPanel() {
  const knowledge = useLabKnowledge();
  return (
    <section className="lab-panel" aria-labelledby="lab-index-title">
      <div className="lab-panelhead">
        <h2 id="lab-index-title">What the index holds</h2>
        <button type="button" className="lab-button lab-button--quiet" onClick={() => void knowledge.refetch()} disabled={knowledge.isFetching}>
          {knowledge.isFetching ? 'Reading…' : 'Read again'}
        </button>
      </div>
      {knowledge.isPending ? <Loading what="the index" /> : null}
      {knowledge.isError ? <Failed what="the index" error={knowledge.error} /> : null}
      {knowledge.data === undefined ? null : (
        <>
          <IndexFacts index={knowledge.data.index} />
          <p className="lab-note">Read from the search engine at {formatDateTime(knowledge.data.checked_at)}.</p>
        </>
      )}
    </section>
  );
}

function IndexFacts({ index }: { index: LabelIndex }) {
  if (index.state === 'not_built') {
    return (
      <div className="lab-empty">
        <p>
          The index is not built: the alias <span className="lab-mono">{index.alias}</span> does not exist, so a search
          finds nothing.
        </p>
        <p className="lab-mono">{index.detail}</p>
      </div>
    );
  }
  const facts: [string, string][] = [
    ['Alias', index.alias],
    ['Index it points at', index.index],
    ['Passages', String(index.passages)],
  ];
  if (index.embedding === null) {
    facts.push(['Embedding', 'None: built without vectors']);
  } else {
    facts.push(
      ['Embedding model', index.embedding.repository],
      ['Revision', index.embedding.revision],
      ['Dimensions', String(index.embedding.dimensions)],
      ['Recipe', index.embedding.recipe],
    );
  }
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

function SearchPanel() {
  const search = useLabelSearch();
  const [medicine, setMedicine] = useState('');
  const [question, setQuestion] = useState('');
  const [missing, setMissing] = useState<string | null>(null);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const empty = [medicine.trim() === '' ? 'the medicine' : null, question.trim() === '' ? 'the question' : null].filter(
      (name): name is string => name !== null,
    );
    if (empty.length > 0) {
      setMissing(`Give ${empty.join(' and ')} before searching.`);
      return;
    }
    setMissing(null);
    search.mutate({ medicine: medicine.trim(), question: question.trim() });
  }

  return (
    <section className="lab-panel" aria-labelledby="lab-search-title">
      <h2 id="lab-search-title">Try a search</h2>
      <form className="lab-form" onSubmit={submit} noValidate>
        <div className="lab-field">
          <label htmlFor="lab-search-medicine">Medicine</label>
          <input
            id="lab-search-medicine"
            className="lab-input"
            value={medicine}
            maxLength={MAX_MEDICINE}
            autoComplete="off"
            onChange={(event) => setMedicine(event.target.value)}
          />
          <p className="lab-field__hint">A product name, generic name or active ingredient, as find_labels takes it.</p>
        </div>
        <div className="lab-field">
          <label htmlFor="lab-search-question">Question</label>
          <textarea
            id="lab-search-question"
            className="lab-input lab-input--area"
            value={question}
            maxLength={MAX_QUESTION}
            rows={3}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <p className="lab-field__hint">The words search_label looks for in that label, up to {MAX_QUESTION} characters.</p>
        </div>
        <div>
          <button type="submit" className="lab-button" disabled={search.isPending}>
            {search.isPending ? 'Searching…' : 'Search'}
          </button>
        </div>
        {missing === null ? null : (
          <p className="lab-failed" role="alert">
            {missing}
          </p>
        )}
      </form>
      {search.isPending ? (
        <p className="lab-note" role="status">
          Asking the retrieval service…
        </p>
      ) : null}
      {search.isError ? (
        <div className="lab-failed" role="alert">
          <p className="lab-failed__title">The search was not made.</p>
          <p>{failureText(search.error)}</p>
        </div>
      ) : null}
      {search.data === undefined || search.isPending ? null : <SearchResult result={search.data} />}
    </section>
  );
}

function SearchResult({ result }: { result: KnowledgeSearchResponse }) {
  return (
    <div className="lab-result" aria-live="polite">
      <Calls calls={result.calls} />
      {result.outcome === 'failed' ? (
        <div className="lab-failed" role="alert">
          <p className="lab-failed__title">The search failed.</p>
          <p>
            <span className="lab-mono">{result.error}</span>: {result.detail}
          </p>
        </div>
      ) : null}
      {result.outcome === 'no_label' ? (
        <>
          <p className="lab-empty">No label in the index has that name, so no label was searched. The service answered:</p>
          <pre className="lab-pre">{pretty(result.answer)}</pre>
        </>
      ) : null}
      {result.outcome === 'found' ? (
        <>
          <Labels labels={result.labels} searched={result.searched} />
          <h3 className="lab-subhead">Passages</h3>
          <p className="lab-note">
            Ranked by the service&rsquo;s strategy, <span className="lab-mono">{result.strategy}</span>, best first.
          </p>
          {result.passages.length === 0 ? (
            <p className="lab-empty">The label holds no passage that matches the question.</p>
          ) : (
            <ol className="lab-hits">
              {result.passages.map((passage) => (
                <Passage key={passage.chunk_id} passage={passage} names={result.searched.names} />
              ))}
            </ol>
          )}
        </>
      ) : null}
    </div>
  );
}

function Calls({ calls }: { calls: readonly KnowledgeCall[] }) {
  if (calls.length === 0) {
    return <p className="lab-note">No call reached the retrieval service.</p>;
  }
  return (
    <>
      <h3 className="lab-subhead">Calls made</h3>
      <div className="lab-scroll">
        <table className="lab-table">
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Sent</th>
              <th scope="col" className="lab-table__num">
                Time taken
              </th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call, index) => (
              <tr key={index}>
                <th scope="row" className="lab-mono">
                  {call.tool}
                </th>
                <td className="lab-mono">{JSON.stringify(call.sent)}</td>
                <td className="lab-mono lab-table__num">{formatDuration(call.duration_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Labels({ labels, searched }: { labels: readonly FoundLabel[]; searched: FoundLabel }) {
  return (
    <>
      <h3 className="lab-subhead">Labels found</h3>
      <div className="lab-scroll">
        <table className="lab-table">
          <thead>
            <tr>
              <th scope="col">Names</th>
              <th scope="col">Version</th>
              <th scope="col">Date</th>
              <th scope="col">Set id</th>
              <th scope="col">Searched</th>
            </tr>
          </thead>
          <tbody>
            {labels.map((label) => (
              <tr key={label.set_id} className={label.set_id === searched.set_id ? 'lab-row--current' : undefined}>
                <th scope="row">{label.names.join(', ')}</th>
                <td className="lab-mono">{label.version}</td>
                <td className="lab-mono">{labelDate(label.effective_date)}</td>
                <td className="lab-mono">{label.set_id}</td>
                <td>{label.set_id === searched.set_id ? 'Yes, the newest' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function sectionText(section: FoundPassage['section']): string {
  if (section.path.length > 0) return section.path.join(' > ');
  const named = [section.number, section.title].filter((part): part is string => part !== null && part.trim() !== '');
  return named.length > 0 ? named.join(' ') : 'Untitled section';
}

function ranksText(ranks: FoundPassage['ranks']): string {
  if (ranks === null) return 'no ranks given';
  const given = (['keyword', 'vector', 'fused', 'reranked'] as const)
    .filter((list) => ranks[list] !== null)
    .map((list) => `${list} ${String(ranks[list])}`);
  return given.length > 0 ? given.join(', ') : 'no ranks given';
}

function Passage({ passage, names }: { passage: FoundPassage; names: readonly string[] }) {
  return (
    <li>
      <p className="lab-hits__where">
        <span>
          <span className="lab-mono">{passage.rank}.</span> {names.join(', ')}, {sectionText(passage.section)}
          {passage.part === 'highlights' ? ' (Highlights)' : ''}
        </span>
        <span className="lab-mono">score {passage.score}</span>
      </p>
      <p className="lab-mono lab-hits__passage">
        version {passage.label.version}, {labelDate(passage.label.effective_date)}; ranks: {ranksText(passage.ranks)};
        passage {passage.chunk_id}
      </p>
      <pre className="lab-pre lab-pre--prose">{passage.text}</pre>
      <p>
        <a href={passage.label.source} target="_blank" rel="noopener noreferrer">
          {labelLinkText(passage.label.source, passage.label.version)}
        </a>
      </p>
    </li>
  );
}
