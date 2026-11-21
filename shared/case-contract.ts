// The shapes the case system sends and accepts. The case system produces them; the client reads them.

// The four things a report needs before it can go to review.
export const ELEMENTS = ['patient', 'reporter', 'suspect_drug', 'event'] as const;
export type ElementName = (typeof ELEMENTS)[number];
export type Elements = Partial<Record<ElementName, string>>;

export const CASE_STATUSES = ['incomplete', 'awaiting_review', 'needs_information', 'approved', 'rejected'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const REVIEW_DECISIONS = ['approve', 'reject', 'request_information'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export type CaseView = {
  case_id: string;
  status: CaseStatus;
  missing: ElementName[];
  version: number;
  received_at: string;
  created_at: string;
  elements: Elements;
  note: string | null;
};

export type VersionView = {
  version: number;
  elements: Elements;
  note: string | null;
  message_id: string;
  // Who sent the message this version came from, as the caller gave it. Empty for a version recorded
  // before senders were kept.
  sender: string;
  received_at: string;
  recorded_at: string;
  recorded_by: string;
};

export type AuditView = {
  seq: number;
  at: string;
  actor: string;
  actor_kind: 'agent' | 'reviewer';
  action: string;
  version: number | null;
  detail: unknown;
};

// What a lookup returns. `truncated` is true when more cases matched than are listed.
export type FoundCases = { cases: CaseView[]; truncated: boolean };

// GET /cases/<id> on the review server.
export type CaseRecord = { case: CaseView; versions: VersionView[]; audit: AuditView[] };

// POST /cases/<id>/review on the review server.
export type ReviewRequest = { reviewer: string; decision: ReviewDecision; note?: string };
