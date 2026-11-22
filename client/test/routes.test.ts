// Invariants 5, 6 and 9 of client/README.md ("Always true"), and the probe that the built app is served. The
// agent and the case system are scripted servers; the identity provider renews by a function (support.ts).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import type { Received } from './support.ts';
import { APP_ORIGIN, DANA, EXAMPLE_RESPONSE, RILEY, at, call, clock, deskConfig, scripted, settled, signedIn, startDesk } from './support.ts';

const webRoot = mkdtempSync(join(tmpdir(), 'client-web-'));
after(() => rmSync(webRoot, { recursive: true, force: true }));
mkdirSync(join(webRoot, 'assets'));
writeFileSync(join(webRoot, 'index.html'), 'the app page');
writeFileSync(join(webRoot, 'assets', 'app.js'), 'the app script');

const agent = await scripted({ after }, () => ({ status: 200, body: EXAMPLE_RESPONSE }));
const cases = await scripted({ after }, () => ({ status: 200, body: { answered: 'by the case system' } }));
const config = deskConfig({ agents: [{ id: 'first', name: 'First', description: 'scripted', url: agent.url }], caseReviewUrl: cases.url, webRoot });
const desk = await startDesk({ after }, config, clock());
const textOf = (r: Received): unknown => at(r.body, 'message', 'text');

function inquire(cookie: string, text: string, origin?: string): Promise<{ status: number; body: unknown }> {
  return call(`${desk.url}/api/inquiries`, { cookie, origin, method: 'POST', body: { sender: 'A clinician', text, agent_id: 'first' } });
}

async function listed(cookie: string, text: string): Promise<boolean> {
  const { body } = await call(`${desk.url}/api/inquiries`, { cookie });
  const inquiries = at(body, 'inquiries');
  return Array.isArray(inquiries) && inquiries.some((inquiry) => at(inquiry, 'text') === text);
}

test('invariant 5: every call to an agent or the case system carries a live token, renewed first; a failed renewal ends the session', { timeout: 10_000 }, async (t) => {
  const setup = signedIn(desk, RILEY, 'access-setup', 3_600_000, 'refresh-setup');
  const inquiryId = String(at((await inquire(setup, 'for a new run')).body, 'inquiry', 'id'));
  await settled(desk, inquiryId, setup);
  const before = agent.received.length;
  // A token with 100 s left is enough for a case call (30 s) and not for an agent run (180 s); one with 10 s, for neither.
  const rows = [
    { name: 'a new inquiry, token long-lived', life: 3_600_000, renewed: false, send: (c: string) => inquire(c, 'long-lived'), seen: () => agent.waitFor((r) => textOf(r) === 'long-lived') },
    { name: 'a new inquiry, token short of an agent run', life: 100_000, renewed: true, send: (c: string) => inquire(c, 'short'), seen: () => agent.waitFor((r) => textOf(r) === 'short') },
    {
      name: 'a new run of an inquiry, token short of an agent run',
      life: 100_000,
      renewed: true,
      send: (c: string) => call(`${desk.url}/api/inquiries/${inquiryId}/runs`, { cookie: c, method: 'POST', body: { agent_id: 'first' } }),
      seen: () => agent.waitFor((r) => textOf(r) === 'for a new run' && agent.received.indexOf(r) >= before),
    },
    { name: 'the case list', life: 10_000, renewed: true, send: (c: string) => call(`${desk.url}/api/cases?status=awaiting_review`, { cookie: c }), seen: () => cases.waitFor((r) => r.path.startsWith('/cases?')) },
    { name: 'a case', life: 10_000, renewed: true, send: (c: string) => call(`${desk.url}/api/cases/AE-51`, { cookie: c }), seen: () => cases.waitFor((r) => r.path === '/cases/AE-51') },
    {
      name: 'a review',
      life: 10_000,
      renewed: true,
      send: (c: string) => call(`${desk.url}/api/cases/AE-52/review`, { cookie: c, method: 'POST', body: { decision: 'approve' } }),
      seen: () => cases.waitFor((r) => r.path === '/cases/AE-52/review'),
    },
  ];
  for (const [n, row] of rows.entries()) {
    await t.test(row.name, async () => {
      const cookie = signedIn(desk, RILEY, `access-${n}`, row.life, `refresh-${n}`);
      assert.ok((await row.send(cookie)).status < 300);
      assert.equal((await row.seen()).authorization, row.renewed ? `Bearer renewed-refresh-${n}` : `Bearer access-${n}`);
    });
  }
  await t.test('the renewal is refused', async () => {
    const cookie = signedIn(desk, RILEY, 'access-refused', 10_000, 'refuse');
    assert.equal((await inquire(cookie, 'refused renewal')).status, 401);
    assert.equal((await call(`${desk.url}/api/session`, { cookie })).status, 401);
    assert.equal(await listed(setup, 'refused renewal'), false);
    assert.equal(agent.received.some((r) => textOf(r) === 'refused renewal'), false);
  });
});

test('invariant 6: the reviewer of a case is whoever is signed in, never a name the browser sends', async (t) => {
  const cookie = signedIn(desk, RILEY, 'access-riley', 3_600_000, 'refresh-riley');
  await t.test("a decision is forwarded with the signed-in user's token and no reviewer", async () => {
    const reply = await call(`${desk.url}/api/cases/AE-61/review`, { cookie, method: 'POST', body: { decision: 'approve', note: 'synthetic note' } });
    assert.deepEqual(reply, { status: 200, body: { answered: 'by the case system' } });
    const forwarded = await cases.waitFor((r) => r.path === '/cases/AE-61/review');
    assert.deepEqual({ authorization: forwarded.authorization, body: forwarded.body }, { authorization: 'Bearer access-riley', body: { decision: 'approve', note: 'synthetic note' } });
  });
  await t.test('a decision that names its reviewer is refused and not forwarded', async () => {
    const reply = await call(`${desk.url}/api/cases/AE-62/review`, { cookie, method: 'POST', body: { decision: 'approve', reviewer: 'Someone Else' } });
    assert.equal(reply.status, 400);
    assert.equal(cases.received.some((r) => r.path === '/cases/AE-62/review'), false);
  });
});

test('invariant 9: a POST from another site is refused', async (t) => {
  const cookie = signedIn(desk, DANA, 'access-dana', 3_600_000, 'refresh-dana');
  await t.test('an inquiry from another site', async () => {
    assert.equal((await inquire(cookie, 'from elsewhere', 'https://elsewhere.example')).status, 403);
    assert.equal(await listed(cookie, 'from elsewhere'), false);
  });
  await t.test('a sign-out from another site', async () => {
    assert.equal((await call(`${desk.url}/auth/logout`, { cookie, method: 'POST', origin: 'https://elsewhere.example' })).status, 403);
    assert.equal((await call(`${desk.url}/api/session`, { cookie })).status, 200);
  });
  await t.test("an inquiry from the app's own origin is taken", async () => {
    const { status, body } = await inquire(cookie, 'from the app', APP_ORIGIN);
    assert.equal(status, 202);
    await settled(desk, String(at(body, 'inquiry', 'id')), cookie);
  });
});

test('probe: the built app is served, and any other path is its page', async () => {
  const script = await fetch(`${desk.url}/assets/app.js`);
  assert.equal(await script.text(), 'the app script');
  const page = await fetch(`${desk.url}/cases/AE-1`);
  assert.equal(await page.text(), 'the app page');
});
