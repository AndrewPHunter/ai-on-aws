import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

const RIVERA = 'Dr A. Rivera, cardiologist, a.rivera@example.org';

// The signed-in user an agent acts for, and the reviewer, as an access token names them.
const DANA = { name: 'Dana Desk', subject: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f02' };
const RILEY = { name: 'Riley Reviewer', subject: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f01' };

function message(id: string, sender = RIVERA): CallContext {
  return { messageId: id, receivedAt: '2025-12-31T23:00:00.000Z', agentId: 'intake-agent', actingFor: DANA, sender };
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

  const approved = store.review('AE-000001', RILEY, 'approve', undefined);
  assert.equal(approved.outcome, 'done');
  assert.ok(approved.outcome === 'done');
  assert.equal(approved.case.status, 'approved');

  const twice = store.review('AE-000001', RILEY, 'reject', undefined);
  assert.deepEqual(twice, { outcome: 'not_allowed', status: 'approved' });

  const incomplete = store.review('AE-000002', RILEY, 'approve', undefined);
  assert.deepEqual(incomplete, { outcome: 'not_allowed', status: 'incomplete' });

  assert.equal(store.review('AE-000099', RILEY, 'approve', undefined).outcome, 'not_found');

  const trail = store.auditTrail('AE-000001');
  const decision = trail.find((entry) => entry.action === 'review_approve');
  assert.equal(decision?.actor, 'Riley Reviewer');
  assert.equal(decision?.actor_kind, 'reviewer');
});

test('asking for more information needs a note and is allowed on an incomplete case', () => {
  const store = memoryStore();
  store.createCase(message('m1'), { event: 'rash' });

  assert.equal(store.review('AE-000001', RILEY, 'request_information', '  ').outcome, 'note_required');
  const asked = store.review('AE-000001', RILEY, 'request_information', 'Which drug, and who is reporting?');
  assert.equal(asked.outcome, 'done');
  assert.ok(asked.outcome === 'done');
  assert.equal(asked.case.status, 'needs_information');
});

test('a follow-up on an approved case puts the new version back in front of a reviewer', () => {
  const store = memoryStore();
  store.createCase(message('m1'), COMPLETE);
  store.review('AE-000001', RILEY, 'approve', undefined);
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

const KATO = 'Dr M. Kato, pharmacy, m.kato@example.org';

test('a lookup for a sender returns only cases that sender has reported on', () => {
  const store = memoryStore();
  store.createCase(message('m1'), COMPLETE);
  store.createCase(message('m2', KATO), COMPLETE);

  assert.deepEqual(
    store.find({ sender: RIVERA, suspectDrug: 'atorvastatin' }).cases.map((found) => found.case_id),
    ['AE-000001'],
  );
  assert.deepEqual(
    store.find({ sender: KATO }).cases.map((found) => found.case_id),
    ['AE-000002'],
  );
  assert.deepEqual(store.find({ sender: 'someone else' }).cases, []);
  assert.equal(store.find({}).cases.length, 2);
});

test('two spellings of a sender that differ only in case and spacing are the same sender', () => {
  const store = memoryStore();
  store.createCase(message('m1'), COMPLETE);

  const found = store.find({ sender: '  dr a. rivera,   CARDIOLOGIST, a.rivera@example.org ' });
  assert.equal(found.cases.length, 1);
});

test('a follow-up from a sender who has not reported on the case is answered as if there were no such case', () => {
  const store = memoryStore();
  store.createCase(message('m1'), COMPLETE);

  const notTheirs = store.addFollowUp(message('m2', KATO), 'AE-000001', { event: 'changed' }, undefined);
  const notThere = store.addFollowUp(message('m3', KATO), 'AE-000099', { event: 'changed' }, undefined);

  assert.deepEqual(notTheirs, { outcome: 'not_found' });
  assert.deepEqual(notTheirs, notThere);
  assert.equal(store.versions('AE-000001').length, 1);
  assert.equal(store.auditTrail('AE-000001').length, 1);
});

test('a sender who has added to a case can find it and add to it again', () => {
  const store = memoryStore();
  store.createCase(message('m1'), COMPLETE);
  store.addFollowUp(message('m2'), 'AE-000001', {}, 'first follow-up');
  const again = store.addFollowUp(message('m3'), 'AE-000001', {}, 'second follow-up');

  assert.equal(again.outcome, 'recorded');
  assert.deepEqual(
    store.versions('AE-000001').map((version) => version.sender),
    [RIVERA, RIVERA, RIVERA],
  );
});

test('a store written before senders were kept still opens, and no sender finds its old cases', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'case-store-old-')), 'cases.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    create table cases (
      n integer primary key, case_id text not null unique, status text not null,
      current_version integer not null, received_at text not null, created_at text not null
    ) strict;
    create table case_versions (
      case_id text not null references cases(case_id), version integer not null,
      patient text, reporter text, suspect_drug text, event text, note text,
      message_id text not null, received_at text not null, recorded_at text not null, recorded_by text not null,
      primary key (case_id, version)
    ) strict;
    insert into cases values (1, 'AE-000001', 'awaiting_review', 1, '2025-12-31T23:00:00.000Z', '2026-01-01T00:00:00.000Z');
    insert into case_versions values ('AE-000001', 1, 'JD', 'Dr Rivera', 'atorvastatin', 'rash', null,
      'old-message', '2025-12-31T23:00:00.000Z', '2026-01-01T00:00:00.000Z', 'old-agent');
  `);
  old.close();

  const store = new CaseStore(path, steppingClock());
  assert.equal(store.getCase('AE-000001')?.status, 'awaiting_review');
  assert.equal(store.versions('AE-000001')[0]?.sender, '');
  assert.deepEqual(store.find({ sender: RIVERA }).cases, []);
  assert.deepEqual(store.find({ sender: '' }).cases, []);
  assert.equal(store.find({}).cases.length, 1);
  assert.deepEqual(store.addFollowUp(message('m0', ''), 'AE-000001', { event: 'changed' }, undefined), { outcome: 'not_found' });
  assert.equal(store.createCase(message('m1'), COMPLETE).case.case_id, 'AE-000002');
  store.close();
});
