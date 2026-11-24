import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, useParams } from 'react-router';

import type { CaseAction, Inquiry, InquirySummary, Run } from '../../../shared/api.ts';
import { RunAnswer } from '../Answer.tsx';
import { ApiFailure, failureText, useFinishedInquiries, useInquiries, useInquiry } from '../api.ts';
import { Empty, Loading, Paragraphs, Problem, Tag } from '../components.tsx';
import { caseStatusWords, firstLine, formatDateTime, formatDuration, formatWhen } from '../format.ts';
import { inboxStatus, isLabelLookup, latestRun } from '../inbox.ts';
import { useMay } from '../session.tsx';

function InboxList({ openId }: { openId: string | undefined }) {
  const inquiries = useInquiries();
  const listed = (inquiries.data?.inquiries ?? []).filter((inquiry) => !isLabelLookup(inquiry));
  const finished = listed.flatMap((inquiry) => {
    const latest = latestRun(inquiry);
    return latest !== undefined && latest.state === 'completed' && !inquiry.runs.some((run) => run.state === 'running')
      ? [{ inquiryId: inquiry.id, latestRunId: latest.id }]
      : [];
  });
  const wholes = useFinishedInquiries(finished);
  const wholeOf = new Map(finished.map((entry, index) => [entry.inquiryId, wholes[index]]));
  const [now] = useState(() => new Date());

  return (
    <aside className="inbox" aria-labelledby="inbox-title">
      <div className="inbox__head">
        <h1 id="inbox-title">Inbox</h1>
        <Link to="/inquiries/new" className="button button--primary">
          Log an inquiry
        </Link>
      </div>

      {inquiries.isPending ? <Loading what="the inbox" /> : null}
      {inquiries.isError ? (
        <div className="inbox__pad">
          <Problem>
            <p>{failureText(inquiries.error)}</p>
          </Problem>
        </div>
      ) : null}
      {inquiries.data !== undefined && listed.length === 0 ? (
        <p className="inbox__none">
          Inquiries you log appear here, newest first, each with its draft reply and any case it opened.
        </p>
      ) : null}

      <ul className="inbox__list">
        {listed.map((inquiry) => (
          <InboxItem
            key={inquiry.id}
            inquiry={inquiry}
            now={now}
            open={inquiry.id === openId}
            whole={wholeOf.get(inquiry.id)}
          />
        ))}
      </ul>
      {inquiries.data?.truncated === true ? <p className="inbox__none">Showing the 100 newest inquiries.</p> : null}
    </aside>
  );
}

function InboxItem({
  inquiry,
  now,
  open,
  whole,
}: {
  inquiry: InquirySummary;
  now: Date;
  open: boolean;
  whole: { data?: Inquiry; isError: boolean } | undefined;
}) {
  const status = inboxStatus(inquiry, whole?.data, whole?.isError === true);
  return (
    <li>
      <NavLink to={`/inquiries/${inquiry.id}`} className="inbox__item" aria-current={open ? 'true' : undefined}>
        <span className="inbox__line">
          <span className="inbox__from">{firstLine(inquiry.sender, 60)}</span>
          <span className="inbox__when">{formatWhen(inquiry.received_at, now)}</span>
        </span>
        <span className="inbox__text">{firstLine(inquiry.text, 90)}</span>
        <Tag tone={status.tone}>{status.text}</Tag>
      </NavLink>
    </li>
  );
}

const ACTION_WORDS: Record<CaseAction['kind'], string> = {
  case_opened: 'Opened',
  case_already_open: 'Already open',
  follow_up_recorded: 'Follow-up recorded',
};

function CaseColumn({ run }: { run: Run }) {
  const may = useMay();
  const actions = run.response?.case_actions ?? [];
  const handled = run.state !== 'running' && run.finished_at !== null;
  if (actions.length === 0 && !handled) {
    return null;
  }
  return (
    <aside className="side" aria-label="Cases and handling">
      {actions.map((action) => {
        const status = caseStatusWords(action.status);
        return (
          <section key={`${action.kind}-${action.case_id}`} className="card side__card">
            <h2 className="side__title">Adverse event case</h2>
            <p className="side__case">
              {may.read_cases ? <Link to={`/cases/${action.case_id}`}>{action.case_id}</Link> : action.case_id}
            </p>
            <p>
              {ACTION_WORDS[action.kind]} from this inquiry.
              {status === null ? '' : ` Its status then: ${status.toLowerCase()}.`}
            </p>
            {may.read_cases ? null : <p>A safety reviewer decides it.</p>}
          </section>
        );
      })}
      {run.state === 'running' || run.finished_at === null ? null : (
        <section className="card side__card">
          <h2 className="side__title">Handled</h2>
          <p>
            {run.duration_ms === null ? 'Finished' : `Took ${formatDuration(run.duration_ms)}, finished`}{' '}
            {formatDateTime(run.finished_at)}.
          </p>
        </section>
      )}
    </aside>
  );
}

function Reading({ inquiryId }: { inquiryId: string }) {
  const inquiry = useInquiry(inquiryId);

  if (inquiry.isPending) {
    return (
      <div className="reading">
        <Loading what="the inquiry" />
      </div>
    );
  }
  if (inquiry.isError) {
    const missing = inquiry.error instanceof ApiFailure && inquiry.error.status === 404;
    return (
      <div className="reading">
        <Problem>
          <p>{missing ? 'This inquiry is not in your inbox.' : failureText(inquiry.error)}</p>
        </Problem>
      </div>
    );
  }

  const found = inquiry.data;
  const run = latestRun(found);
  return (
    <>
      <div className="reading">
        <article className="card card--reading" aria-label="The inquiry">
          <div className="message__head">
            <span className="message__from">{found.sender}</span>
            <span className="message__when">
              Received {formatDateTime(found.received_at)}.
              {found.entered_by === null ? '' : ` Logged by ${found.entered_by.name}.`}
            </span>
          </div>
          <div className="writing">
            <Paragraphs text={found.text} />
          </div>
        </article>
        {run === undefined ? (
          <Problem>
            <p className="problem__title">This inquiry was never handled.</p>
            <p>It was logged but not handed on. Answer it yourself, or log it again.</p>
          </Problem>
        ) : (
          <RunAnswer run={run} working="Being handled." replyTitle="Draft reply" />
        )}
      </div>
      {run === undefined ? null : <CaseColumn run={run} />}
    </>
  );
}

export function InboxPage() {
  const { inquiryId } = useParams();
  return (
    <div className={inquiryId === undefined ? 'inboxpage' : 'inboxpage inboxpage--open'}>
      <InboxList openId={inquiryId} />
      <div className="inboxpage__body">
        {inquiryId === undefined ? (
          <div className="reading reading--none">
            <Empty title="No inquiry open">
              <p>Choose one from the inbox to read its draft reply, or log a new one.</p>
            </Empty>
          </div>
        ) : (
          <>
            <Link to="/inquiries" className="back">
              <ArrowLeft size={16} aria-hidden="true" /> Inbox
            </Link>
            <Reading key={inquiryId} inquiryId={inquiryId} />
          </>
        )}
      </div>
    </div>
  );
}
