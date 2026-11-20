// Wording and number formatting shared by the screens.

import type { CaseStatus, ElementName, RunState, Step } from '../../shared/api.ts';

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
    case 'tool':
      return step.is_error ? `${step.tool} was refused or failed` : `${step.tool} ran`;
    case 'retrieval':
      return 'Searched the label';
    case 'handoff':
      return `Passed to ${step.to_agent}`;
    case 'error':
      return 'A step failed';
  }
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
