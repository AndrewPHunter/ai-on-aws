// Wording and number formatting shared by the screens.

import type { CaseStatus, ElementName, LabelAnswer, RunState, Step } from '../../shared/api.ts';

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const timeWithSeconds = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function formatDate(iso: string): string {
  return dateOnly.format(new Date(iso));
}

export function formatTime(iso: string): string {
  return timeWithSeconds.format(new Date(iso));
}

export function daysAfter(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

export const STATUS_LABEL: Record<CaseStatus, string> = {
  incomplete: 'Incomplete',
  awaiting_review: 'Awaiting review',
  needs_information: 'Needs information',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const ELEMENT_LABEL: Record<ElementName, string> = {
  patient: 'Patient',
  reporter: 'Reporter',
  suspect_drug: 'Suspect drug',
  event: 'Adverse event',
};

export const RUN_STATE_LABEL: Record<RunState, string> = {
  running: 'Working',
  completed: 'Finished',
  failed: 'Did not run',
};

const AUDIT_LABEL: Record<string, string> = {
  case_created: 'Case opened',
  create_replayed: 'Repeat of the same request recognised. Nothing new was created',
  create_conflict: 'A second, different case for the same message was refused',
  follow_up_added: 'Follow-up added',
  follow_up_replayed: 'Repeat of the same follow-up recognised. Nothing new was recorded',
  follow_up_conflict: 'A second, different follow-up for the same message was refused',
  review_approve: 'Approved',
  review_reject: 'Rejected',
  review_request_information: 'More information requested',
};

export function auditLabel(action: string): string {
  return AUDIT_LABEL[action] ?? action;
}

export function stepTitle(step: Step): string {
  switch (step.kind) {
    case 'model':
      if (step.tool_calls.length === 0) {
        return 'The model answered';
      }
      return `The model asked for ${step.tool_calls.map((call) => call.name).join(', ')}`;
    case 'tool': {
      const who = step.requested_by === 'agent' ? ', repeated by the agent’s own code' : '';
      return step.is_error ? `${step.tool} was refused or did not answer${who}` : `${step.tool} ran${who}`;
    }
    case 'retrieval':
      return 'Searched the label';
    case 'handoff':
      return `Passed to ${step.to_agent}`;
    case 'error':
      return 'A step failed';
  }
}

// Whether a question about a drug label was answered, in plain words.
export const LABEL_ANSWER_TEXT: Record<LabelAnswer, string> = {
  answered: 'Answered from the label.',
  no_label: 'No label for this drug.',
  label_does_not_answer: 'The label does not answer this.',
  not_a_label_question: 'Not a question about a label.',
};

export function labelAnswerText(answer: LabelAnswer): string {
  return LABEL_ANSWER_TEXT[answer];
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

// A label's date as it carries it (YYYYMMDD), written for a person: 30 January 2026. Written out here, not by
// the browser's locale, so every reader sees the same words. Eight digits that are not a real date are shown
// as they are, never as "Invalid Date"; anything else is shown as given.
export function labelDate(yyyymmdd: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd);
  if (match === null) {
    return yyyymmdd;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const name = MONTHS[month - 1];
  if (name === undefined || day < 1 || day > daysInMonth) {
    return yyyymmdd;
  }
  return `${day} ${name} ${year}`;
}

// The words of a link to a label's page: which version, and the site it is on.
export function labelLinkText(source: string, version: number): string {
  let host: string;
  try {
    host = new URL(source).hostname;
  } catch {
    host = source;
  }
  return `Version ${version} of the label, at ${host}`;
}

export function firstLine(text: string, length: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1).trimEnd()}…`;
}

export function pretty(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}
