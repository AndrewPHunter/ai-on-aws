// The case store: adverse event cases, their versions, and an append-only audit trail.
// Everything that decides whether a case exists, is complete, or may change status is here,
// in code, and not in a model.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// The four things a report needs before it can go to review.
export const ELEMENTS = ['patient', 'reporter', 'suspect_drug', 'event'] as const;
export type ElementName = (typeof ELEMENTS)[number];
export type Elements = Partial<Record<ElementName, string>>;

export type CaseStatus = 'incomplete' | 'awaiting_review' | 'needs_information' | 'approved' | 'rejected';
export type ReviewDecision = 'approve' | 'reject' | 'request_information';

// Who is calling and for which inbound message. Supplied by the agent's code, never by the model.
export type CallContext = {
  messageId: string;
  receivedAt: string;
  agentId: string;
};

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

export type CreateResult = { outcome: 'created' | 'replayed' | 'conflict'; case: CaseView };

export type FollowUpResult =
  | { outcome: 'recorded' | 'replayed' | 'conflict'; case: CaseView }
  | { outcome: 'not_found' }
  | { outcome: 'nothing_to_add' };

export type ReviewResult =
  | { outcome: 'done'; case: CaseView }
  | { outcome: 'not_found' }
  | { outcome: 'note_required' }
  | { outcome: 'not_allowed'; status: CaseStatus };

export type CaseFilter = {
  caseId?: string;
  suspectDrug?: string;
  patient?: string;
  messageId?: string;
  status?: CaseStatus;
};

const SCHEMA = `
create table if not exists cases (
  n integer primary key,
  case_id text not null unique,
  status text not null,
  current_version integer not null,
  received_at text not null,
  created_at text not null
) strict;

create table if not exists case_versions (
  case_id text not null references cases(case_id),
  version integer not null,
  patient text,
  reporter text,
  suspect_drug text,
  event text,
  note text,
  message_id text not null,
  received_at text not null,
  recorded_at text not null,
  recorded_by text not null,
  primary key (case_id, version)
) strict;

create table if not exists operations (
  operation_key text primary key,
  payload_hash text not null,
  case_id text not null references cases(case_id),
  version integer not null,
  recorded_at text not null
) strict;

create table if not exists audit (
  seq integer primary key autoincrement,
  at text not null,
  actor text not null,
  actor_kind text not null check (actor_kind in ('agent', 'reviewer')),
  action text not null,
  case_id text not null references cases(case_id),
  version integer,
  detail text not null
) strict;
`;

const STATUSES: readonly CaseStatus[] = ['incomplete', 'awaiting_review', 'needs_information', 'approved', 'rejected'];
export const FIND_LIMIT = 50;

// What a lookup returns. `truncated` is true when more cases matched than are listed.
export type FoundCases = { cases: CaseView[]; truncated: boolean };

type Row = Record<string, unknown>;

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`Column ${column} does not hold text`);
  }
  return value;
}

function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Column ${column} holds neither text nor null`);
  }
  return value;
}

function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Column ${column} does not hold an integer`);
  }
  return value;
}

function statusOf(row: Row): CaseStatus {
  const value = text(row, 'status');
  const status = STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new Error(`Unknown case status ${value}`);
  }
  return status;
}

function elementsOf(row: Row): Elements {
  const elements: Elements = {};
  for (const name of ELEMENTS) {
    const value = optionalText(row, name);
    if (value !== null) {
      elements[name] = value;
    }
  }
  return elements;
}

// Trims each element and drops the empty ones, so "" and "  " count as missing.
export function normalise(input: Elements): Elements {
  const elements: Elements = {};
  for (const name of ELEMENTS) {
    const value = input[name]?.trim();
    if (value !== undefined && value !== '') {
      elements[name] = value;
    }
  }
  return elements;
}

export function missingFrom(elements: Elements): ElementName[] {
  return ELEMENTS.filter((name) => elements[name] === undefined);
}

// A case with all four elements goes to a reviewer. Anything less waits for more information.
// This checks that each element is present, not that it is good enough: that is the reviewer's call.
function statusAfterWrite(elements: Elements): CaseStatus {
  return missingFrom(elements).length === 0 ? 'awaiting_review' : 'incomplete';
}

function hashOf(elements: Elements, note: string | null): string {
  const canonical = JSON.stringify([...ELEMENTS.map((name) => elements[name] ?? null), note]);
  return createHash('sha256').update(canonical).digest('hex');
}

function likePattern(fragment: string): string {
  return `%${fragment.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export class CaseStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path: string, now: () => Date) {
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec('pragma foreign_keys = on');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // One case per inbound message. The same message with the same content returns the case
  // already created. The same message with different content is a conflict, and creates nothing.
  createCase(context: CallContext, input: Elements): CreateResult {
    const elements = normalise(input);
    const operationKey = `create:${context.messageId}`;
    const payloadHash = hashOf(elements, null);

    return this.inTransaction(() => {
      const prior = this.operation(operationKey);
      if (prior !== undefined) {
        const outcome = prior.payloadHash === payloadHash ? 'replayed' : 'conflict';
        this.audit(context.agentId, 'agent', `create_${outcome}`, prior.caseId, prior.version, {
          message_id: context.messageId,
        });
        return { outcome, case: this.requireCase(prior.caseId) };
      }

      const number = this.nextCaseNumber();
      const caseId = `AE-${String(number).padStart(6, '0')}`;
      const recordedAt = this.now().toISOString();
      this.db
        .prepare(
          'insert into cases (n, case_id, status, current_version, received_at, created_at) values (?, ?, ?, 1, ?, ?)',
        )
        .run(number, caseId, statusAfterWrite(elements), context.receivedAt, recordedAt);
      this.insertVersion(caseId, 1, elements, null, context, recordedAt);
      this.recordOperation(operationKey, payloadHash, caseId, 1, recordedAt);
      this.audit(context.agentId, 'agent', 'case_created', caseId, 1, {
        message_id: context.messageId,
        missing: missingFrom(elements),
      });
      return { outcome: 'created', case: this.requireCase(caseId) };
    });
  }

  // Adds information as a new version. Earlier versions are never changed.
  // The case goes back to a reviewer, or stays incomplete, whatever its status was.
  addFollowUp(context: CallContext, caseId: string, input: Elements, noteInput: string | undefined): FollowUpResult {
    const provided = normalise(input);
    const trimmedNote = noteInput?.trim();
    const note = trimmedNote === undefined || trimmedNote === '' ? null : trimmedNote;
    if (Object.keys(provided).length === 0 && note === null) {
      return { outcome: 'nothing_to_add' };
    }
    const operationKey = `follow_up:${context.messageId}:${caseId}`;
    const payloadHash = hashOf(provided, note);

    return this.inTransaction(() => {
      const current = this.currentRow(caseId);
      if (current === undefined) {
        return { outcome: 'not_found' };
      }
      const prior = this.operation(operationKey);
      if (prior !== undefined) {
        const outcome = prior.payloadHash === payloadHash ? 'replayed' : 'conflict';
        this.audit(context.agentId, 'agent', `follow_up_${outcome}`, caseId, prior.version, {
          message_id: context.messageId,
        });
        return { outcome, case: this.requireCase(caseId) };
      }

      const version = integer(current, 'current_version') + 1;
      const merged: Elements = { ...elementsOf(current), ...provided };
      const recordedAt = this.now().toISOString();
      this.insertVersion(caseId, version, merged, note, context, recordedAt);
      this.db
        .prepare('update cases set status = ?, current_version = ? where case_id = ?')
        .run(statusAfterWrite(merged), version, caseId);
      this.recordOperation(operationKey, payloadHash, caseId, version, recordedAt);
      this.audit(context.agentId, 'agent', 'follow_up_added', caseId, version, {
        message_id: context.messageId,
        changed: Object.keys(provided),
        missing: missingFrom(merged),
      });
      return { outcome: 'recorded', case: this.requireCase(caseId) };
    });
  }

  // A person's decision on a case. Approve and reject need a case that is awaiting review.
  review(caseId: string, reviewer: string, decision: ReviewDecision, noteInput: string | undefined): ReviewResult {
    const trimmedNote = noteInput?.trim();
    const note = trimmedNote === undefined || trimmedNote === '' ? null : trimmedNote;
    if (decision === 'request_information' && note === null) {
      return { outcome: 'note_required' };
    }

    return this.inTransaction(() => {
      const current = this.currentRow(caseId);
      if (current === undefined) {
        return { outcome: 'not_found' };
      }
      const status = statusOf(current);
      const allowedFrom: readonly CaseStatus[] =
        decision === 'request_information' ? ['awaiting_review', 'incomplete'] : ['awaiting_review'];
      if (!allowedFrom.includes(status)) {
        return { outcome: 'not_allowed', status };
      }
      const next: CaseStatus =
        decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'needs_information';
      this.db.prepare('update cases set status = ? where case_id = ?').run(next, caseId);
      this.audit(reviewer, 'reviewer', `review_${decision}`, caseId, integer(current, 'current_version'), {
        from: status,
        to: next,
        note,
      });
      return { outcome: 'done', case: this.requireCase(caseId) };
    });
  }

  getCase(caseId: string): CaseView | undefined {
    const row = this.currentRow(caseId);
    return row === undefined ? undefined : this.viewOf(row);
  }

  // Cases matching every filter given, newest first, at most FIND_LIMIT of them.
  // Drug and patient match on a fragment, ignoring case.
  find(filter: CaseFilter): FoundCases {
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (filter.caseId !== undefined) {
      conditions.push('c.case_id = ?');
      parameters.push(filter.caseId);
    }
    if (filter.status !== undefined) {
      conditions.push('c.status = ?');
      parameters.push(filter.status);
    }
    if (filter.suspectDrug !== undefined) {
      conditions.push("v.suspect_drug like ? escape '\\'");
      parameters.push(likePattern(filter.suspectDrug));
    }
    if (filter.patient !== undefined) {
      conditions.push("v.patient like ? escape '\\'");
      parameters.push(likePattern(filter.patient));
    }
    if (filter.messageId !== undefined) {
      conditions.push('exists (select 1 from case_versions m where m.case_id = c.case_id and m.message_id = ?)');
      parameters.push(filter.messageId);
    }
    const where = conditions.length === 0 ? '' : `where ${conditions.join(' and ')}`;
    const rows = this.db
      .prepare(
        `select c.case_id, c.status, c.current_version, c.received_at, c.created_at,
                v.patient, v.reporter, v.suspect_drug, v.event, v.note
           from cases c
           join case_versions v on v.case_id = c.case_id and v.version = c.current_version
           ${where}
          order by c.n desc
          limit ${FIND_LIMIT + 1}`,
      )
      .all(...parameters);
    return {
      cases: rows.slice(0, FIND_LIMIT).map((row) => this.viewOf(row)),
      truncated: rows.length > FIND_LIMIT,
    };
  }

  versions(caseId: string): VersionView[] {
    const rows = this.db.prepare('select * from case_versions where case_id = ? order by version').all(caseId);
    return rows.map((row) => ({
      version: integer(row, 'version'),
      elements: elementsOf(row),
      note: optionalText(row, 'note'),
      message_id: text(row, 'message_id'),
      received_at: text(row, 'received_at'),
      recorded_at: text(row, 'recorded_at'),
      recorded_by: text(row, 'recorded_by'),
    }));
  }

  auditTrail(caseId: string): AuditView[] {
    const rows = this.db.prepare('select * from audit where case_id = ? order by seq').all(caseId);
    return rows.map((row) => {
      const kind = text(row, 'actor_kind');
      if (kind !== 'agent' && kind !== 'reviewer') {
        throw new Error(`Unknown actor kind ${kind}`);
      }
      const version = row['version'];
      const detail: unknown = JSON.parse(text(row, 'detail'));
      return {
        seq: integer(row, 'seq'),
        at: text(row, 'at'),
        actor: text(row, 'actor'),
        actor_kind: kind,
        action: text(row, 'action'),
        version: version === null ? null : integer(row, 'version'),
        detail,
      };
    });
  }

  private inTransaction<Result>(work: () => Result): Result {
    this.db.exec('begin immediate');
    try {
      const result = work();
      this.db.exec('commit');
      return result;
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }

  private nextCaseNumber(): number {
    const row = this.db.prepare('select coalesce(max(n), 0) + 1 as next from cases').get();
    if (row === undefined) {
      throw new Error('Could not read the next case number');
    }
    return integer(row, 'next');
  }

  private currentRow(caseId: string): Row | undefined {
    return this.db
      .prepare(
        `select c.case_id, c.status, c.current_version, c.received_at, c.created_at,
                v.patient, v.reporter, v.suspect_drug, v.event, v.note
           from cases c
           join case_versions v on v.case_id = c.case_id and v.version = c.current_version
          where c.case_id = ?`,
      )
      .get(caseId);
  }

  private requireCase(caseId: string): CaseView {
    const row = this.currentRow(caseId);
    if (row === undefined) {
      throw new Error(`Case ${caseId} is recorded in an operation but does not exist`);
    }
    return this.viewOf(row);
  }

  private viewOf(row: Row): CaseView {
    const elements = elementsOf(row);
    return {
      case_id: text(row, 'case_id'),
      status: statusOf(row),
      missing: missingFrom(elements),
      version: integer(row, 'current_version'),
      received_at: text(row, 'received_at'),
      created_at: text(row, 'created_at'),
      elements,
      note: optionalText(row, 'note'),
    };
  }

  private operation(operationKey: string): { payloadHash: string; caseId: string; version: number } | undefined {
    const row = this.db
      .prepare('select payload_hash, case_id, version from operations where operation_key = ?')
      .get(operationKey);
    if (row === undefined) {
      return undefined;
    }
    return {
      payloadHash: text(row, 'payload_hash'),
      caseId: text(row, 'case_id'),
      version: integer(row, 'version'),
    };
  }

  private recordOperation(
    operationKey: string,
    payloadHash: string,
    caseId: string,
    version: number,
    recordedAt: string,
  ): void {
    this.db
      .prepare(
        'insert into operations (operation_key, payload_hash, case_id, version, recorded_at) values (?, ?, ?, ?, ?)',
      )
      .run(operationKey, payloadHash, caseId, version, recordedAt);
  }

  private insertVersion(
    caseId: string,
    version: number,
    elements: Elements,
    note: string | null,
    context: CallContext,
    recordedAt: string,
  ): void {
    this.db
      .prepare(
        `insert into case_versions
           (case_id, version, patient, reporter, suspect_drug, event, note,
            message_id, received_at, recorded_at, recorded_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        caseId,
        version,
        elements.patient ?? null,
        elements.reporter ?? null,
        elements.suspect_drug ?? null,
        elements.event ?? null,
        note,
        context.messageId,
        context.receivedAt,
        recordedAt,
        context.agentId,
      );
  }

  private audit(
    actor: string,
    actorKind: 'agent' | 'reviewer',
    action: string,
    caseId: string,
    version: number | null,
    detail: unknown,
  ): void {
    this.db
      .prepare('insert into audit (at, actor, actor_kind, action, case_id, version, detail) values (?, ?, ?, ?, ?, ?, ?)')
      .run(this.now().toISOString(), actor, actorKind, action, caseId, version, JSON.stringify(detail));
  }
}
