import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { INTERRUPTED_ERROR, InquiryStore, LIST_LIMIT, STALE_ERROR } from '../src/store.ts';
import { EXAMPLE_RESPONSE, steppingClock, tempDir } from './helpers.ts';

const START = '2026-02-01T08:00:00.000Z';

function inquiry(id: string): { id: string; receivedAt: string; sender: string; text: string } {
  return { id, receivedAt: '2026-02-01T07:59:00.000Z', sender: 'Dr Rivera', text: `Question ${id}` };
}

test('a completed run keeps the response, its timing, and the case ids it names', (t) => {
  const store = new InquiryStore(':memory:', steppingClock(START));
  t.after(() => {
    store.close();
  });
  store.createInquiry(inquiry('q1'));
  store.startRun('r1', 'q1', 'intake');
  assert.equal(store.completeRun('r1', EXAMPLE_RESPONSE), true);

  assert.deepEqual(store.getInquiry('q1'), {
    id: 'q1',
    received_at: '2026-02-01T07:59:00.000Z',
    sender: 'Dr Rivera',
    text: 'Question q1',
    runs: [
      {
        id: 'r1',
        inquiry_id: 'q1',
        agent_id: 'intake',
        state: 'completed',
        started_at: '2026-02-01T08:00:00.000Z',
        finished_at: '2026-02-01T08:00:01.000Z',
        duration_ms: 1000,
        error: null,
        response: EXAMPLE_RESPONSE,
      },
    ],
  });
  assert.deepEqual(store.listInquiries().inquiries[0]?.runs, [
    { id: 'r1', agent_id: 'intake', state: 'completed', case_ids: ['AE-000001'] },
  ]);
});

test('a run cannot be started for an inquiry that does not exist', (t) => {
  const store = new InquiryStore(':memory:', steppingClock(START));
  t.after(() => {
    store.close();
  });
  assert.equal(store.startRun('r1', 'missing', 'intake'), undefined);
  assert.equal(store.getInquiry('missing'), undefined);
});

test('failInterruptedRuns fails only running runs, and a late answer does not overwrite it', (t) => {
  const store = new InquiryStore(':memory:', steppingClock(START));
  t.after(() => {
    store.close();
  });
  store.createInquiry(inquiry('q1'));
  store.startRun('done', 'q1', 'intake');
  store.completeRun('done', EXAMPLE_RESPONSE);
  store.startRun('left', 'q1', 'intake');

  assert.equal(store.failInterruptedRuns(), 1);
  const left = store.getRun('left');
  assert.ok(left);
  assert.equal(left.state, 'failed');
  assert.equal(left.error, INTERRUPTED_ERROR);
  assert.equal(left.response, null);
  assert.equal(store.getRun('done')?.state, 'completed');

  assert.equal(store.completeRun('left', EXAMPLE_RESPONSE), false);
  assert.equal(store.getRun('left')?.state, 'failed');
});

test('inquiries and runs survive closing and reopening the store file', (t) => {
  const path = join(tempDir(t), 'client.db');
  const first = new InquiryStore(path, steppingClock(START));
  first.createInquiry(inquiry('q1'));
  first.startRun('r1', 'q1', 'intake');
  first.failRun('r1', 'The agent answered with status 500.');
  const before = first.getInquiry('q1');
  first.close();

  const second = new InquiryStore(path, steppingClock(START));
  t.after(() => {
    second.close();
  });
  assert.notEqual(before, undefined);
  assert.deepEqual(second.getInquiry('q1'), before);
});

test('the list is newest first, at most the limit, and says when it is truncated', (t) => {
  const store = new InquiryStore(':memory:', steppingClock(START));
  t.after(() => {
    store.close();
  });
  for (let n = 1; n <= LIST_LIMIT; n++) {
    store.createInquiry(inquiry(`q${n}`));
  }
  const full = store.listInquiries();
  assert.equal(full.truncated, false);
  assert.equal(full.inquiries.length, LIST_LIMIT);
  assert.equal(full.inquiries[0]?.id, `q${LIST_LIMIT}`);

  store.createInquiry(inquiry('newest'));
  const over = store.listInquiries();
  assert.equal(over.truncated, true);
  assert.equal(over.inquiries.length, LIST_LIMIT);
  assert.equal(over.inquiries[0]?.id, 'newest');
  assert.equal(over.inquiries.at(-1)?.id, 'q2');
});

test('a stored answer that no longer matches the contract fails that one run, not the inbox', (t) => {
  const path = join(tempDir(t), 'client.sqlite');
  const first = new InquiryStore(path, steppingClock(START));
  first.createInquiry(inquiry('q1'));
  first.startRun('r1', 'q1', 'intake');
  first.completeRun('r1', EXAMPLE_RESPONSE);
  first.createInquiry(inquiry('q2'));
  first.startRun('r2', 'q2', 'intake');
  first.completeRun('r2', EXAMPLE_RESPONSE);
  first.close();

  // What an older version of the contract would have left behind.
  const raw = new DatabaseSync(path);
  raw.prepare('update runs set response = ? where id = ?').run(JSON.stringify({ reply: 'old shape' }), 'r1');
  raw.close();

  const second = new InquiryStore(path, steppingClock(START));
  t.after(() => {
    second.close();
  });
  const stale = second.getInquiry('q1')?.runs[0];
  assert.equal(stale?.state, 'failed');
  assert.equal(stale?.error, STALE_ERROR);
  assert.equal(stale?.response, null);
  assert.equal(second.getInquiry('q2')?.runs[0]?.state, 'completed');
  assert.equal(second.listInquiries().inquiries.length, 2);
});
