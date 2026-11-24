// Which inquiries the inbox lists, and the one status each shows there.

import type { Inquiry, InquirySummary, RunSummary } from '../../shared/api.ts';

// The agents the desk sends to: the orchestrator handles an inquiry logged in the inbox; the label expert
// answers a question asked on "Ask the label".
export const INBOX_AGENT = 'orchestrator';
export const LABEL_AGENT = 'expert';

export function latestRun<Run>(inquiry: { runs: readonly Run[] }): Run | undefined {
  return inquiry.runs[inquiry.runs.length - 1];
}

// A label lookup: every run of it was by the label expert. An inquiry with no run is not one.
export function isLabelLookup(inquiry: { runs: readonly Pick<RunSummary, 'agent_id'>[] }): boolean {
  return inquiry.runs.length > 0 && inquiry.runs.every((run) => run.agent_id === LABEL_AGENT);
}

export type Tone = 'working' | 'attention' | 'case' | 'answered' | 'quiet';
export type InboxStatus = { tone: Tone; text: string };

// The status of an inquiry in the inbox. `whole` is the inquiry read in full, needed once its latest run has
// finished; `wholeFailed` says it could not be read.
export function inboxStatus(summary: InquirySummary, whole: Inquiry | undefined, wholeFailed: boolean): InboxStatus {
  if (summary.runs.some((run) => run.state === 'running')) {
    return { tone: 'working', text: 'Working' };
  }
  const latest = latestRun(summary);
  if (latest === undefined || latest.state === 'failed') {
    return { tone: 'attention', text: 'Needs attention' };
  }
  if (whole === undefined) {
    return wholeFailed ? { tone: 'quiet', text: 'Status could not be read' } : { tone: 'quiet', text: 'Reading status…' };
  }
  const latestWhole = latestRun(whole);
  if (latestWhole?.response == null || latestWhole.response.outcome !== 'completed') {
    return { tone: 'attention', text: 'Needs attention' };
  }
  const actions = whole.runs.flatMap((run) => run.response?.case_actions ?? []);
  const opened = unique(actions.filter((action) => action.kind === 'case_opened').map((action) => action.case_id));
  if (opened.length > 0) {
    return { tone: 'case', text: `Case opened: ${opened.join(', ')}` };
  }
  const followed = unique(actions.filter((action) => action.kind === 'follow_up_recorded').map((action) => action.case_id));
  if (followed.length > 0) {
    return { tone: 'case', text: `Follow-up added to ${followed.join(', ')}` };
  }
  return { tone: 'answered', text: 'Answered' };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
