import { Link, useSearchParams } from 'react-router';

import type { CaseStatus } from '../../../shared/api.ts';
import { failureText, useCases } from '../api.ts';
import { CaseStatusTag, Empty, Loading, Problem } from '../components.tsx';
import { STATUS_LABEL, firstLine, formatDateTime } from '../format.ts';

const FILTERS: readonly CaseStatus[] = ['awaiting_review', 'incomplete', 'needs_information', 'approved', 'rejected'];

function isStatus(value: string | null): value is CaseStatus {
  return FILTERS.some((status) => status === value);
}

export function CasesPage() {
  const [params, setParams] = useSearchParams();
  const wanted = params.get('status');
  const status = isStatus(wanted) ? wanted : undefined;
  const cases = useCases(status);

  return (
    <div className="page page--wide stack stack--large">
      <div>
        <h1>Cases</h1>
        <p className="lead">
          Adverse event cases opened from inquiries. The intake agent opens a case and adds follow-ups; a safety
          reviewer approves or rejects it.
        </p>
      </div>

      <div className="filters" role="group" aria-label="Show cases that are">
        <button type="button" className="filter" aria-pressed={status === undefined} onClick={() => setParams({})}>
          All
        </button>
        {FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            className="filter"
            aria-pressed={status === filter}
            onClick={() => setParams({ status: filter })}
          >
            {STATUS_LABEL[filter]}
          </button>
        ))}
      </div>

      {cases.isPending ? <Loading what="cases" /> : null}
      {cases.isError ? (
        <Problem>
          <p>{failureText(cases.error)}</p>
        </Problem>
      ) : null}

      {cases.data === undefined ? null : cases.data.cases.length === 0 ? (
        <Empty title={status === undefined ? 'No cases yet' : `No cases are ${STATUS_LABEL[status].toLowerCase()}`}>
          <p>A case appears here when an inquiry reports an adverse event.</p>
        </Empty>
      ) : (
        <div className="stack">
          <div className="tablebox">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Case</th>
                  <th scope="col">Status</th>
                  <th scope="col">Suspect drug</th>
                  <th scope="col">Adverse event</th>
                  <th scope="col">Received</th>
                </tr>
              </thead>
              <tbody>
                {cases.data.cases.map((found) => (
                  <tr key={found.case_id}>
                    <th scope="row">
                      <Link to={`/cases/${found.case_id}`} className="caseno">
                        {found.case_id}
                      </Link>
                    </th>
                    <td>
                      <CaseStatusTag status={found.status} />
                    </td>
                    <td className="writing-cell">
                      {found.elements.suspect_drug ?? <span className="absent">Not given</span>}
                    </td>
                    <td className="writing-cell">
                      {found.elements.event === undefined ? (
                        <span className="absent">Not given</span>
                      ) : (
                        firstLine(found.elements.event, 90)
                      )}
                    </td>
                    <td className="nowrap">{formatDateTime(found.received_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cases.data.truncated ? <p className="footnote">Showing the 50 newest. Older cases are not listed here.</p> : null}
        </div>
      )}
    </div>
  );
}
