// The case system's invariants 10 and 12 ("Always true" in tools/case-system/README.md), on the MCP server built for
// one request, reached through the MCP SDK's in-memory transport. Every element and note is an invented word, so an
// answer that carried what the case holds would name one.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { Telemetry } from '../../../shared/telemetry.ts';
import { buildMcpServer } from '../src/mcp.ts';
import { CaseStore } from '../src/store.ts';
import { recordingTelemetry, telemetryOff } from './telemetry-rig.ts';

const WORDS = ['quillon', 'zarbex', 'ostrel', 'myralgo', 'pellucid', 'vantrix'];

// A client of the server built for one message, holding the write scope.
async function connect(store: CaseStore, messageId: string, telemetry: Telemetry = telemetryOff()): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const context = { messageId, receivedAt: '2026-01-01T08:00:00.000Z', agentId: 'intake-handwritten', actingFor: { name: 'dana', subject: 'subject-dana' }, sender: 'Dr A. Rivera' };
  await buildMcpServer(store, context, ['cases:write'], { telemetry, parent: null, agentId: 'intake-handwritten' }).connect(serverSide);
  const client = new Client({ name: 'probe', version: '1' });
  await client.connect(clientSide);
  return client;
}

test('case-system 10. a tool that changes a case answers with a receipt and never with what the case holds', async (t) => {
  const store = new CaseStore(':memory:', () => new Date('2026-01-01T09:00:00.000Z'));
  const first = await connect(store, 'm1');
  const second = await connect(store, 'm2');
  t.after(() => Promise.all([first.close(), second.close()]).then(() => store.close()));
  const opened = { case_id: 'AE-000001', status: 'incomplete', version: 1, missing: ['reporter', 'event'] };
  const followed = { ...opened, version: 2, missing: ['reporter'] };
  // One row per answer that used to carry the case: a create, a conflicting create, a follow-up, a conflicting follow-up.
  const rows: [Client, string, Record<string, unknown>, unknown][] = [
    [first, 'create_case', { patient: 'Quillon', suspect_drug: 'Zarbex' }, opened],
    [first, 'create_case', { patient: 'Quillon', suspect_drug: 'Zarbex', event: 'Ostrel' }, opened],
    [second, 'add_follow_up', { case_id: 'AE-000001', event: 'Myralgo', note: 'Pellucid' }, followed],
    [second, 'add_follow_up', { case_id: 'AE-000001', event: 'Vantrix' }, followed],
  ];
  for (const [client, tool, args, receipt] of rows) {
    const [answer] = (await client.callTool({ name: tool, arguments: args })).content as { text: string }[];
    const text = answer?.text ?? '';
    assert.deepEqual((JSON.parse(text) as { case: unknown }).case, receipt, `${tool} ${JSON.stringify(args)}`);
    assert.deepEqual(WORDS.filter((word) => text.toLowerCase().includes(word)), [], `${tool} ${JSON.stringify(args)}`);
  }
});

test("case-system 12. a write's commit span says created, replayed or conflict and has ended when the answer arrives; a repeat is a replay", async (t) => {
  const store = new CaseStore(':memory:', () => new Date('2026-01-01T09:00:00.000Z'));
  const { telemetry, spans } = recordingTelemetry();
  const first = await connect(store, 'm1', telemetry);
  const second = await connect(store, 'm2', telemetry);
  t.after(() => Promise.all([first.close(), second.close()]).then(() => store.close()));
  // One row per write: the client, the tool, its arguments, then the commit's outcome and the call's.
  const rows: [Client, string, Record<string, unknown>, string, string][] = [
    [first, 'create_case', { patient: 'Quillon' }, 'created', 'executed'],
    [first, 'create_case', { patient: 'Quillon' }, 'replayed', 'executed'],
    [first, 'create_case', { patient: 'Zarbex' }, 'conflict', 'refused'],
    [second, 'add_follow_up', { case_id: 'AE-000001', event: 'Ostrel' }, 'created', 'executed'],
    [second, 'add_follow_up', { case_id: 'AE-000001', event: 'Ostrel' }, 'replayed', 'executed'],
  ];
  for (const [index, [client, tool, args]] of rows.entries()) {
    await client.callTool({ name: tool, arguments: args });
    // Both spans of the call, the commit and the tool's, had ended before its answer was sent.
    assert.equal(telemetry.counts().ended, 2 * (index + 1), `${tool} ${JSON.stringify(args)}`);
  }
  const ended = await spans();
  for (const [index, [, tool, args, commit, call]] of rows.entries()) {
    const label = `${tool} ${JSON.stringify(args)}`;
    const [commitSpan, toolSpan] = [ended[2 * index], ended[2 * index + 1]];
    assert.ok(commitSpan !== undefined && toolSpan !== undefined, label);
    assert.deepEqual([commitSpan.name, toolSpan.name, commitSpan.parentSpanContext?.spanId], ['case.commit', 'case.tool', toolSpan.spanContext().spanId], label);
    assert.deepEqual([commitSpan.attributes['lab.outcome'], toolSpan.attributes['lab.outcome']], [commit, call], label);
    assert.deepEqual([commitSpan.attributes['lab.inquiry.id'], toolSpan.attributes['gen_ai.tool.name']], [tool === 'create_case' ? 'm1' : 'm2', tool], label);
  }
  assert.equal(store.find({}).cases.length, 1);
});
