// The case system's invariant 10 ("Always true" in tools/case-system/README.md), on the MCP server built for one
// request, reached through the MCP SDK's in-memory transport. Every element and note is an invented word, so an
// answer that carried what the case holds would name one.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildMcpServer } from '../src/mcp.ts';
import { CaseStore } from '../src/store.ts';
import type { CallContext } from '../src/store.ts';

const message = (messageId: string): CallContext => ({
  messageId,
  receivedAt: '2026-01-01T08:00:00.000Z',
  agentId: 'intake-handwritten',
  actingFor: { name: 'dana', subject: 'subject-dana' },
  sender: 'Dr A. Rivera, a.rivera@example.org',
});
const WORDS = ['quillon', 'zarbex', 'ostrel', 'myralgo', 'pellucid', 'vantrix'];

test('case-system 10. a tool that changes a case answers with a receipt and never with what the case holds', async (t) => {
  const store = new CaseStore(':memory:', () => new Date('2026-01-01T09:00:00.000Z'));
  const clients = new Map<string, Client>();
  t.after(async () => {
    for (const client of clients.values()) await client.close();
    store.close();
  });
  const clientFor = async (messageId: string): Promise<Client> => {
    const known = clients.get(messageId);
    if (known !== undefined) return known;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(store, message(messageId), ['cases:write']).connect(serverSide);
    const client = new Client({ name: 'probe', version: '1' });
    await client.connect(clientSide);
    clients.set(messageId, client);
    return client;
  };

  const opened = { case_id: 'AE-000001', status: 'incomplete', version: 1, missing: ['reporter', 'event'] };
  const followed = { ...opened, version: 2, missing: ['reporter'] };
  const rows: { name: string; message: string; tool: string; args: Record<string, unknown>; answer: string; receipt: unknown }[] = [
    { name: 'a create', message: 'm1', tool: 'create_case', args: { patient: 'Quillon', suspect_drug: 'Zarbex' }, answer: 'created', receipt: opened },
    { name: 'a replayed create', message: 'm1', tool: 'create_case', args: { patient: 'Quillon', suspect_drug: 'Zarbex' }, answer: 'replayed', receipt: opened },
    { name: 'a conflicting create', message: 'm1', tool: 'create_case', args: { patient: 'Quillon', suspect_drug: 'Zarbex', event: 'Ostrel' }, answer: 'case_already_opened_for_this_message', receipt: opened },
    { name: 'a follow-up', message: 'm2', tool: 'add_follow_up', args: { case_id: 'AE-000001', event: 'Myralgo', note: 'Pellucid' }, answer: 'recorded', receipt: followed },
    { name: 'a conflicting follow-up', message: 'm2', tool: 'add_follow_up', args: { case_id: 'AE-000001', event: 'Vantrix' }, answer: 'follow_up_already_recorded_for_this_message', receipt: followed },
  ];
  for (const row of rows) {
    const result = await (await clientFor(row.message)).callTool({ name: row.tool, arguments: row.args });
    const [first] = result.content as { text: string }[];
    assert.ok(first !== undefined, row.name);
    const payload = JSON.parse(first.text) as Record<string, unknown>;
    assert.deepEqual([payload['outcome'] ?? payload['error'], payload['case']], [row.answer, row.receipt], row.name);
    assert.deepEqual(WORDS.filter((word) => first.text.toLowerCase().includes(word)), [], row.name);
  }
});
