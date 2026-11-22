// The case system's invariants 1 to 7 ("Always true" in tools/case-system/README.md) that the store decides, one
// test each, on the real store class over an in-memory SQLite database. Every name and drug here is invented.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CaseStore } from '../src/store.ts';
import type { CallContext, CaseStatus, Elements, ReviewDecision } from '../src/store.ts';

const DANA = { name: 'Dana Desk', subject: 'subject-dana' };
const RILEY = { name: 'Riley Reviewer', subject: 'subject-riley' };
const RIVERA = 'Dr A. Rivera, a.rivera@example.org';
const KATO = 'Dr M. Kato, m.kato@example.org';
const COMPLETE: Elements = { patient: 'JD, 54, male', reporter: RIVERA, suspect_drug: 'examplamab', event: 'muscle pain' };

const message = (id: string, sender = RIVERA): CallContext => ({
  messageId: id,
  receivedAt: '2026-01-01T00:00:00.000Z',
  agentId: 'intake-agent',
  actingFor: DANA,
  sender,
});

// A store whose clock reads whatever the test last set.
function rig(): { store: CaseStore; at: (iso: string) => void } {
  let now = new Date('2026-01-01T09:00:00.000Z');
  return { store: new CaseStore(':memory:', () => now), at: (iso) => (now = new Date(iso)) };
}

// A case opened from the message given, brought to the status given (an incomplete case lacks the reporter).
function caseIn(store: CaseStore, status: CaseStatus, messageId: string): string {
  const { reporter: _reporter, ...incomplete } = COMPLETE;
  const id = store.createCase(message(messageId), status === 'incomplete' ? incomplete : COMPLETE).case.case_id;
  const decision: Record<CaseStatus, ReviewDecision | null> = {
    awaiting_review: null,
    incomplete: null,
    approved: 'approve',
    rejected: 'reject',
    needs_information: 'request_information',
  };
  const wanted = decision[status];
  if (wanted !== null) assert.equal(store.review(id, RILEY, wanted, 'a note').outcome, 'done');
  return id;
}

test('case-system 1. a case is awaiting review with all four elements, and otherwise incomplete listing what is missing', () => {
  const { store } = rig();
  const { event: _event, ...withoutEvent } = COMPLETE;
  const rows: { name: string; elements: Elements; status: CaseStatus; missing: string[] }[] = [
    { name: 'all four', elements: COMPLETE, status: 'awaiting_review', missing: [] },
    { name: 'no event', elements: withoutEvent, status: 'incomplete', missing: ['event'] },
    { name: 'a blank reporter', elements: { ...COMPLETE, reporter: '  ' }, status: 'incomplete', missing: ['reporter'] },
  ];
  rows.forEach((row, n) => {
    const { case: view } = store.createCase(message(`m${n}`), row.elements);
    assert.deepEqual([view.status, view.missing], [row.status, row.missing], row.name);
  });
  const gap = store.createCase(message('m-gap'), withoutEvent).case.case_id;
  const filled = store.addFollowUp(message('m-fill'), gap, { event: 'muscle pain' }, undefined);
  assert.ok(filled.outcome === 'recorded');
  assert.deepEqual([filled.case.status, filled.case.missing], ['awaiting_review', []], 'a follow-up that fills the gap');
});

test('case-system 2. one case per inbound message: the same content returns it, different content is refused and changes nothing', () => {
  const { store } = rig();
  const first = store.createCase(message('m1'), COMPLETE);
  const again = store.createCase(message('m1'), COMPLETE);
  const reworded = store.createCase(message('m1'), { ...COMPLETE, event: 'reworded' });
  assert.equal(first.outcome, 'created');
  assert.deepEqual([again.outcome, again.case], ['replayed', first.case]);
  assert.deepEqual([reworded.outcome, reworded.case], ['conflict', first.case]);
  assert.deepEqual(store.getCase(first.case.case_id), first.case);
  assert.equal(store.versions(first.case.case_id).length, 1);
  assert.equal(store.find({}).cases.length, 1);
  assert.notEqual(store.createCase(message('m2'), COMPLETE).case.case_id, first.case.case_id, 'another message opens another case');
});

test('case-system 3. a follow-up adds a version and never overwrites; one from the same message is recorded once', () => {
  const { store } = rig();
  const id = store.createCase(message('m1'), COMPLETE).case.case_id;
  const before = store.versions(id);
  assert.equal(store.addFollowUp(message('m2'), id, { event: 'muscle pain and fever' }, undefined).outcome, 'recorded');
  assert.equal(store.addFollowUp(message('m2'), id, { event: 'muscle pain and fever' }, undefined).outcome, 'replayed');
  assert.equal(store.addFollowUp(message('m2'), id, { event: 'something else' }, undefined).outcome, 'conflict');
  const after = store.versions(id);
  assert.equal(after.length, 2);
  assert.deepEqual(after[0], before[0]);
  assert.deepEqual([after[1]?.version, after[1]?.elements.event], [2, 'muscle pain and fever']);
});

test('case-system 4. a follow-up sends the case back to review, whatever its status was', () => {
  const { store } = rig();
  for (const status of ['approved', 'rejected', 'needs_information'] as const) {
    const id = caseIn(store, status, `m-${status}`);
    const result = store.addFollowUp(message(`f-${status}`), id, {}, 'the reporter called back');
    assert.equal(result.outcome === 'recorded' ? result.case.status : result.outcome, 'awaiting_review', status);
  }
});

test('case-system 5. a decision is accepted only from the statuses allowed for it, and a refused one changes nothing', () => {
  const { store } = rig();
  const rows: { from: CaseStatus; decision: ReviewDecision; note?: string; outcome: string; status: CaseStatus }[] = [
    { from: 'awaiting_review', decision: 'approve', outcome: 'done', status: 'approved' },
    { from: 'awaiting_review', decision: 'reject', outcome: 'done', status: 'rejected' },
    { from: 'incomplete', decision: 'approve', outcome: 'not_allowed', status: 'incomplete' },
    { from: 'approved', decision: 'reject', outcome: 'not_allowed', status: 'approved' },
    { from: 'incomplete', decision: 'request_information', note: 'which drug?', outcome: 'done', status: 'needs_information' },
    { from: 'approved', decision: 'request_information', note: 'which drug?', outcome: 'not_allowed', status: 'approved' },
    { from: 'awaiting_review', decision: 'request_information', outcome: 'note_required', status: 'awaiting_review' },
  ];
  rows.forEach((row, n) => {
    const id = caseIn(store, row.from, `m${n}`);
    const result = store.review(id, RILEY, row.decision, row.note);
    assert.deepEqual([result.outcome, store.getCase(id)?.status], [row.outcome, row.status], `${row.decision} from ${row.from}`);
  });
});

test("case-system 6. an agent sees and adds to only the sender's own cases; another sender's case is answered as one that does not exist", () => {
  const { store } = rig();
  const created = store.createCase(message('m1', RIVERA), COMPLETE).case;
  assert.deepEqual(store.find({ caseId: created.case_id, sender: RIVERA }).cases, [created], 'the owner finds it');
  assert.deepEqual(store.find({ caseId: created.case_id, sender: KATO }).cases, []);
  assert.deepEqual(store.find({ suspectDrug: 'examplamab', sender: KATO }).cases, []);
  const other = store.addFollowUp(message('m2', KATO), created.case_id, { event: 'fever' }, undefined);
  assert.deepEqual(other, store.addFollowUp(message('m3', KATO), 'AE-999999', { event: 'fever' }, undefined));
  assert.equal(store.versions(created.case_id).length, 1);
});

test('case-system 7. every change is in the audit trail with who, when and which message, replays and refused conflicts included', () => {
  const { store, at } = rig();
  const calls: [string, () => unknown][] = [
    ['2026-01-01T10:00:01.000Z', () => store.createCase(message('m1'), COMPLETE)],
    ['2026-01-01T10:00:02.000Z', () => store.createCase(message('m1'), COMPLETE)],
    ['2026-01-01T10:00:03.000Z', () => store.createCase(message('m1'), { ...COMPLETE, event: 'reworded' })],
    ['2026-01-01T10:00:04.000Z', () => store.addFollowUp(message('m2'), 'AE-000001', {}, 'called back')],
    ['2026-01-01T10:00:05.000Z', () => store.addFollowUp(message('m2'), 'AE-000001', {}, 'called back')],
    ['2026-01-01T10:00:06.000Z', () => store.addFollowUp(message('m2'), 'AE-000001', {}, 'something else')],
    ['2026-01-01T10:00:07.000Z', () => store.review('AE-000001', RILEY, 'approve', undefined)],
  ];
  for (const [when, call] of calls) {
    at(when);
    call();
  }
  const messageOf = (detail: unknown): unknown => (typeof detail === 'object' && detail !== null ? Reflect.get(detail, 'message_id') : undefined);
  const agent = (when: string, id: string) => ({ at: when, actor: 'intake-agent', acting_for: DANA, actor_subject: null, message: id });
  assert.deepEqual(
    store.auditTrail('AE-000001').map((entry) => ({ at: entry.at, actor: entry.actor, acting_for: entry.acting_for, actor_subject: entry.actor_subject, message: messageOf(entry.detail) })),
    [
      ...calls.slice(0, 3).map(([when]) => agent(when, 'm1')),
      ...calls.slice(3, 6).map(([when]) => agent(when, 'm2')),
      { at: '2026-01-01T10:00:07.000Z', actor: RILEY.name, acting_for: null, actor_subject: RILEY.subject, message: undefined },
    ],
  );
});
