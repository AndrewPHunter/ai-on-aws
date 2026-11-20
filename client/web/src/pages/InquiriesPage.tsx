import { ArrowLeft, Plus } from 'lucide-react';
import { Link, NavLink, useParams } from 'react-router';

import type { InquirySummary } from '../../../shared/api.ts';
import { failureText, useInquiries } from '../api.ts';
import { Loading, Problem } from '../components.tsx';
import { firstLine, formatDateTime } from '../format.ts';
import { ComposeInquiry } from './ComposeInquiry.tsx';
import { InquiryDetail } from './InquiryDetail.tsx';

function summaryNote(inquiry: InquirySummary): string {
  if (inquiry.runs.some((run) => run.state === 'running')) {
    return 'An agent is working on it';
  }
  const cases = new Set(inquiry.runs.flatMap((run) => run.case_ids));
  if (cases.size > 0) {
    return `Case ${[...cases].join(', ')}`;
  }
  if (inquiry.runs.every((run) => run.state === 'failed')) {
    return 'No agent handled it';
  }
  return 'Answered, no case';
}

export function InquiriesPage() {
  const { inquiryId } = useParams();
  const inquiries = useInquiries();

  return (
    <div className={inquiryId === undefined ? 'desk desk--compose' : 'desk desk--reading'}>
      <aside className="desk__list" aria-label="Inquiries received">
        <div className="desk__listhead">
          <h1>Inquiries</h1>
          <Link to="/inquiries" className="button button--small">
            <Plus size={16} aria-hidden="true" /> New
          </Link>
        </div>

        {inquiries.isPending ? <Loading what="inquiries" /> : null}
        {inquiries.isError ? <Problem>{failureText(inquiries.error)}</Problem> : null}
        {inquiries.data?.inquiries.length === 0 ? (
          <p className="desk__none">Nothing has been received yet.</p>
        ) : null}

        <ul className="inbox">
          {inquiries.data?.inquiries.map((inquiry) => (
            <li key={inquiry.id}>
              <NavLink to={`/inquiries/${inquiry.id}`} className="inbox__item">
                <span className="inbox__from">{firstLine(inquiry.sender, 44)}</span>
                <span className="inbox__when">{formatDateTime(inquiry.received_at)}</span>
                <span className="inbox__text">{firstLine(inquiry.text, 110)}</span>
                <span className="inbox__note">{summaryNote(inquiry)}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        {inquiries.data?.truncated === true ? (
          <p className="footnote">Showing the 100 newest inquiries.</p>
        ) : null}
      </aside>

      <section className="desk__main">
        {inquiryId === undefined ? (
          <ComposeInquiry />
        ) : (
          <>
            <Link to="/inquiries" className="back back--narrow">
              <ArrowLeft size={16} aria-hidden="true" /> Inquiries
            </Link>
            <InquiryDetail key={inquiryId} inquiryId={inquiryId} />
          </>
        )}
      </section>
    </div>
  );
}
