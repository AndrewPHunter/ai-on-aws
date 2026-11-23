// The case system's invariant 10 ("Always true" in tools/case-system/README.md), on the MCP server built for one
// request, reached through the MCP SDK's in-memory transport. Every element and note is an invented word, so an
// answer that carried what the case holds would name one.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildMcpServer } from '../src/mcp.ts';
import { CaseStore } from '../src/store.ts';

const WORDS = ['quillon', 'zarbex', 'ostrel', 'myralgo', 'pellucid', 'vantrix'];

// A client of the server built for one message, holding the write scope.
async function connect(store: CaseStore, messageId: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const context = { messageId, receivedAt: '2026-01-01T08:00:00.000Z', agentId: 'intake-handwritten', actingFor: { name: 'dana', subject: 'subject-dana' }, sender: 'Dr A. Rivera' };
  await buildMcpServer(store, context, ['cases:write']).connect(serverSide);
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
