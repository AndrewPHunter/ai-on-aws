import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CaseStore, FIND_LIMIT } from '../src/store.ts';
import type { CallContext, Elements } from '../src/store.ts';

// A clock that moves one second on every reading, so times are fixed and ordered.
function steppingClock(): () => Date {
  let seconds = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++));
}

function memoryStore(): CaseStore {
  return new CaseStore(':memory:', steppingClock());
}

function message(id: string): CallContext {
  return { messageId: id, receivedAt: '2025-12-31T23:00:00.000Z', agentId: 'intake-agent' };
}

const COMPLETE: Elements = {
  patient: 'JD, 54, male',
  reporter: 'Dr A. Rivera, cardiologist, a.rivera@example.org',
  suspect_drug: 'atorvastatin',
  event: 'severe muscle pain after two weeks',
};

test('a case with all four elements is created awaiting review', () => {
  const store = memoryStore();
  const result = store.createCase(message('m1'), COMPLETE);

  assert.equal(result.outcome, 'created');
  assert.equal(result.case.case_id, 'AE-000001');
  assert.equal(result.case.status, 'awaiting_review');
  assert.deepEqual(result.case.missing, []);
  assert.equal(result.case.version, 1);
  assert.equal(result.case.received_at, '2025-12-31T23:00:00.000Z');
  assert.deepEqual(result.case.elements, COMPLETE);
});

test('a case missing an element is recorded as incomplete and says what is missing', () => {
  const store = memoryStore();
  const result = store.createCase(message('m1'), { suspect_drug: 'atorvastatin', event: 'rash', reporter: '   ' });

  assert.equal(result.outcome, 'created');
  assert.equal(result.case.status, 'incomplete');
  assert.deepEqual(result.case.missing, ['patient', 'reporter']);
});

test('the same message with the same content creates one case and returns it again', () => {
  const store = memoryStore();
  const first = store.createCase(message('m1'), COMPLETE);
  const second = store.createCase(message('m1'), { ...COMPLETE, patient: '  JD, 54, male  ' });

  assert.equal(second.outcome, 'replayed');
  assert.equal(second.case.case_id, first.case.case_id);
  assert.equal(store.find({}).cases.length, 1);
  assert.deepEqual(
    store.auditTrail('AE-000001').map((entry) => entry.action),
    ['case_created', 'create_replayed'],
  );
});

test('the same message with different content is a conflict and changes nothing', () => {
  const store = memoryStore();
  store.createCase(message('m1'), COMPLETE);
  const second = store.createCase(message('m1'), { ...COMPLETE, event: 'something else entirely' });

  assert.equal(second.outcome, 'conflict');
  assert.equal(second.case.case_id, 'AE-000001');
  assert.equal(second.case.elements.event, COMPLETE.event);
  assert.equal(second.case.version, 1);
  assert.equal(store.find({}).cases.length, 1);
});

test('different messages create different cases, numbered in order', () => {
  const store = memoryStore();
  store.createCase(message('m1'), COMPLETE);
  const second = store.createCase(message('m2'), COMPLETE);

  assert.equal(second.outcome, 'created');
  assert.equal(second.case.case_id, 'AE-000002');
});

test('a follow-up adds a version, completes the case, and leaves the first version as it was', () => {
  const store = memoryStore();
  store.createCase(message('m1'), { suspect_drug: 'atorvastatin', event: 'rash' });
  const result = store.addFollowUp(
    message('m2'),
    'AE-000001',
    { patient: 'JD, 54', reporter: 'Dr Rivera' },
    'Reporter phoned back',
  );

  assert.equal(result.outcome, 'recorded');
  assert.ok(result.outcome === 'recorded');
  assert.equal(result.case.status, 'awaiting_review');
  assert.equal(result.case.version, 2);
  assert.equal(result.case.note, 'Reporter phoned back');

  const versions = store.versions('AE-000001');
  assert.equal(versions.length, 2);
  assert.deepEqual(versions[0]?.elements, { suspect_drug: 'atorvastatin', event: 'rash' });
  assert.equal(versions[0]?.message_id, 'm1');
  assert.deepEqual(versions[1]?.elements, {
    patient: 'JD, 54',
    reporter: 'Dr Rivera',
    suspect_drug: 'atorvastatin',
    event: 'rash',
  });
  assert.equal(versions[1]?.message_id, 'm2');
});

test('a repeated follow-up from the same message is recorded once', () => {
  const store = memoryStore();
  store.createCase(message('m1'), { suspect_drug: 'atorvastatin', event: 'rash' });
  store.addFollowUp(message('m2'), 'AE-000001', { patient: 'JD' }, undefined);
  const again = store.addFollowUp(message('m2'), 'AE-000001', { patient: 'JD' }, undefined);
  const different = store.addFollowUp(message('m2'), 'AE-000001', { patient: 'someone else' }, undefined);

  assert.equal(again.outcome, 'replayed');
  assert.equal(different.outcome, 'conflict');
  assert.equal(store.versions('AE-000001').length, 2);
  assert.equal(store.getCase('AE-000001')?.elements.patient, 'JD');
});

test('a follow-up needs a case that exists and something to add', () => {
  const store = memoryStore();
  store.createCase(message('m1'), COMPLETE);

  assert.equal(store.addFollowUp(message('m2'), 'AE-000099', { patient: 'JD' }, undefined).outcome, 'not_found');
  assert.equal(store.addFollowUp(message('m2'), 'AE-000001', { patient: '  ' }, '  ').outcome, 'nothing_to_add');
  assert.equal(store.versions('AE-000001').length, 1);
});

test('a reviewer can approve a case that is awaiting review, and only then', () => {
  const store = memoryStore();
  store.createCase(message('m1'), COMPLETE);
  store.createCase(message('m2'), { event: 'rash' });

  const approved = store.review('AE-000001', 'r.okafor', 'approve', undefined);
  assert.equal(approved.outcome, 'done');
  assert.ok(approved.outcome === 'done');
  assert.equal(approved.case.status, 'approved');

  const twice = store.review('AE-000001', 'r.okafor', 'reject', undefined);
  assert.deepEqual(twice, { outcome: 'not_allowed', status: 'approved' });

  const incomplete = store.review('AE-000002', 'r.okafor', 'approve', undefined);
  assert.deepEqual(incomplete, { outcome: 'not_allowed', status: 'incomplete' });

  assert.equal(store.review('AE-000099', 'r.okafor', 'approve', undefined).outcome, 'not_found');

  const trail = store.auditTrail('AE-000001');
  const decision = trail.find((entry) => entry.action === 'review_approve');
  assert.equal(decision?.actor, 'r.okafor');
  assert.equal(decision?.actor_kind, 'reviewer');
});

test('asking for more information needs a note and is allowed on an incomplete case', () => {
  const store = memoryStore();
  store.createCase(message('m1'), { event: 'rash' });

  assert.equal(store.review('AE-000001', 'r.okafor', 'request_information', '  ').outcome, 'note_required');
  const asked = store.review('AE-000001', 'r.okafor', 'request_information', 'Which drug, and who is reporting?');
  assert.equal(asked.outcome, 'done');
  assert.ok(asked.outcome === 'done');
  assert.equal(asked.case.status, 'needs_information');
});

test('a follow-up on an approved case puts the new version back in front of a reviewer', () => {
  const store = memoryStore();
  store.createCase(message('m1'), COMPLETE);
  store.review('AE-000001', 'r.okafor', 'approve', undefined);
  const result = store.addFollowUp(message('m2'), 'AE-000001', { event: 'severe muscle pain, now hospitalised' }, undefined);

  assert.equal(result.outcome, 'recorded');
  assert.ok(result.outcome === 'recorded');
  assert.equal(result.case.status, 'awaiting_review');
  assert.equal(result.case.version, 2);
});

test('cases are found by drug, by patient and by the message they came from', () => {
  const store = memoryStore();
  store.createCase(message('m1'), COMPLETE);
  store.createCase(message('m2'), { ...COMPLETE, suspect_drug: 'Metformin 500 mg', patient: 'AB, 61, female' });
  store.addFollowUp(message('m3'), 'AE-000001', {}, 'extra detail');

  assert.deepEqual(
    store.find({ suspectDrug: 'METFORMIN' }).cases.map((found) => found.case_id),
    ['AE-000002'],
  );
  assert.deepEqual(
    store.find({ patient: 'jd' }).cases.map((found) => found.case_id),
    ['AE-000001'],
  );
  assert.deepEqual(
    store.find({ messageId: 'm3' }).cases.map((found) => found.case_id),
    ['AE-000001'],
  );
  assert.deepEqual(store.find({ suspectDrug: '%' }), { cases: [], truncated: false });
  assert.deepEqual(
    store.find({ status: 'awaiting_review' }).cases.map((found) => found.case_id),
    ['AE-000002', 'AE-000001'],
  );
});

test('a lookup lists the newest cases first and says when it has left some out', () => {
  const store = memoryStore();
  for (let index = 1; index <= FIND_LIMIT + 1; index++) {
    store.createCase(message(`m${index}`), COMPLETE);
  }
  const found = store.find({});

  assert.equal(found.truncated, true);
  assert.equal(found.cases.length, FIND_LIMIT);
  assert.equal(found.cases[0]?.case_id, `AE-${String(FIND_LIMIT + 1).padStart(6, '0')}`);
  assert.equal(found.cases.some((listed) => listed.case_id === 'AE-000001'), false);
  assert.equal(store.find({ caseId: 'AE-000001' }).truncated, false);
});

test('cases and the record of handled messages survive closing and reopening the file', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'case-store-')), 'cases.sqlite');

  const first = new CaseStore(path, steppingClock());
  first.createCase(message('m1'), COMPLETE);
  first.close();

  const second = new CaseStore(path, steppingClock());
  assert.equal(second.getCase('AE-000001')?.status, 'awaiting_review');
  assert.equal(second.createCase(message('m1'), COMPLETE).outcome, 'replayed');
  assert.equal(second.createCase(message('m2'), COMPLETE).case.case_id, 'AE-000002');
  second.close();
});
