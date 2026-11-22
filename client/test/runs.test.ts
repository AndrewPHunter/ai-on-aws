// Invariants 1 to 3 of client/README.md ("Always true"): a message keeps its identity, a run always ends, and an
// answer outside the agent contract is a failed run. One scripted agent answers by the text of the message.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { InquiryStore } from '../src/store.ts';
import type { Answer } from './support.ts';
import { EXAMPLE_RESPONSE, RILEY, at, call, clock, deskConfig, scripted, settled, signedIn, startDesk } from './support.ts';

let release: () => void = () => undefined;
const ANSWERS: Record<string, () => Answer | Promise<Answer>> = {
  hold: () => new Promise((resolve) => (release = () => resolve({ status: 200, body: EXAMPLE_RESPONSE }))),
  'status 500': () => ({ status: 500, body: { error: 'internal' } }),
  'connection closed': () => 'close',
  'not JSON': () => ({ status: 200, body: 'this is not JSON' }),
  'breaks the schema': () => ({ status: 200, body: { ...EXAMPLE_RESPONSE, reply: 42 } }),
};

const agent = await scripted({ after }, (r) => ANSWERS[String(at(r.body, 'message', 'text'))]?.() ?? { status: 200, body: EXAMPLE_RESPONSE });
const agents = ['first', 'second'].map((id) => ({ id, name: id, description: 'scripted', url: agent.url }));
const desk = await startDesk({ after }, deskConfig({ agents, caseReviewUrl: 'http://127.0.0.1:1' }), clock());
const cookie = signedIn(desk, RILEY, 'access-runs', 3_600_000, 'refresh-runs');

async function send(text: string): Promise<{ status: number; id: string; state: unknown }> {
  const { status, body } = await call(`${desk.url}/api/inquiries`, { cookie, method: 'POST', body: { sender: 'A clinician', text, agent_id: 'first' } });
  return { status, id: String(at(body, 'inquiry', 'id')), state: at(body, 'inquiry', 'runs', 0, 'state') };
}

test('invariant 1: a message keeps its identifier and receipt time when sent again', async () => {
  const { id } = await send('keep my identity');
  // Each wait is for the run to end, read through the API, and each message is found by its text: neither may
  // depend on the identifier, which is what is under test.
  await settled(desk, id, cookie);
  desk.clock.advance(60_000);
  const again = await call(`${desk.url}/api/inquiries/${id}/runs`, { cookie, method: 'POST', body: { agent_id: 'second' } });
  assert.equal(again.status, 202);
  await settled(desk, id, cookie);
  const sent = agent.received.filter((r) => at(r.body, 'message', 'text') === 'keep my identity').map((r) => at(r.body, 'message'));
  assert.equal(sent.length, 2);
  assert.equal(at(sent[0], 'id'), id);
  assert.deepEqual(sent[1], sent[0]);
});

test('invariant 2: sending answers at once, and every run ends finished or failed, including after a restart', { timeout: 10_000 }, async (t) => {
  await t.test('the agent is still working when the send is answered', async () => {
    const { status, id, state } = await send('hold');
    await agent.waitFor((r) => at(r.body, 'message', 'text') === 'hold');
    assert.deepEqual({ status, state }, { status: 202, state: 'running' });
    release();
    assert.equal(at(await settled(desk, id, cookie), 'runs', 0, 'state'), 'completed');
  });
  for (const text of ['status 500', 'connection closed']) {
    await t.test(`the agent fails: ${text}`, async () => {
      const { id } = await send(text);
      assert.equal(at(await settled(desk, id, cookie), 'runs', 0, 'state'), 'failed');
    });
  }
  await t.test('the client restarts while a run is in progress', () => {
    const dir = mkdtempSync(join(tmpdir(), 'client-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'client.db');
    const before = new InquiryStore(path, desk.clock.now);
    const actor = { sub: RILEY.sub, name: RILEY.name };
    before.createInquiry({ id: 'inq-restart', receivedAt: desk.clock.now().toISOString(), sender: 'A clinician', text: 'synthetic', enteredBy: actor });
    assert.equal(before.startRun('run-restart', 'inq-restart', 'first', actor)?.state, 'running');
    before.close();
    const restarted = new InquiryStore(path, desk.clock.now);
    restarted.failInterruptedRuns();
    assert.equal(restarted.getRun('run-restart')?.state, 'failed');
    restarted.close();
  });
});

test('invariant 3: an answer outside the contract is a failed run with the reason', async (t) => {
  for (const text of ['not JSON', 'breaks the schema']) {
    await t.test(text, async () => {
      const { id } = await send(text);
      const run = at(await settled(desk, id, cookie), 'runs', 0);
      assert.equal(at(run, 'state'), 'failed');
      assert.equal(at(run, 'response'), null);
      const error = at(run, 'error');
      assert.ok(typeof error === 'string' && error.length > 0, 'the run carries no reason');
    });
  }
});
