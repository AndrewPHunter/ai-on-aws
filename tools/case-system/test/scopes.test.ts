// The case system's invariant 9 ("Always true" in tools/case-system/README.md). The routes are decided by the
// function the review server calls; the tools by the MCP server built for one request, reached through the MCP
// SDK's in-memory transport. The caller's scopes are given as plain values: no token is involved.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { refusalAnswer } from '../../../shared/access-token.ts';
import { buildMcpServer } from '../src/mcp.ts';
import { ROUTE_SCOPES, TOOL_SCOPES, routeRefusal } from '../src/scopes.ts';
import type { Route, ToolName } from '../src/scopes.ts';
import { CaseStore } from '../src/store.ts';
import type { CallContext } from '../src/store.ts';

const RIVERA = 'Dr A. Rivera, a.rivera@example.org';
const COMPLETE = { patient: 'JD, 54, male', reporter: RIVERA, suspect_drug: 'examplamab', event: 'muscle pain' };
const message = (messageId: string): CallContext => ({
  messageId,
  receivedAt: '2026-01-01T08:00:00.000Z',
  agentId: 'intake-handwritten',
  actingFor: { name: 'dana', subject: 'subject-dana' },
  sender: RIVERA,
});
// Arguments each tool would act on if it were reached: every one but find_case would change the store.
const ARGS: Record<ToolName, Record<string, unknown>> = {
  create_case: COMPLETE,
  find_case: { case_id: 'AE-000001' },
  add_follow_up: { case_id: 'AE-000001', event: 'fever' },
};
const TOOLS = Object.keys(TOOL_SCOPES) as ToolName[];
const ROUTES = Object.keys(ROUTE_SCOPES) as Route[];

test('case-system 9. a tool or a route is reached only with a token that carries its scope; a tool not offered changes nothing when called', async (t) => {
  const rows: { scope: string; tools: ToolName[]; routes: Route[] }[] = [
    { scope: 'cases:write', tools: ['add_follow_up', 'create_case'], routes: [] },
    { scope: 'cases:lookup', tools: ['find_case'], routes: [] },
    { scope: 'cases:read', tools: [], routes: ['GET /cases', 'GET /cases/<id>'] },
    { scope: 'cases:review', tools: [], routes: ['POST /cases/<id>/review'] },
  ];
  for (const row of rows) {
    const scopes = [row.scope];
    assert.deepEqual(ROUTES.filter((route) => routeRefusal(route, scopes) === undefined), row.routes, `routes for ${row.scope}`);
    for (const route of ROUTES.filter((candidate) => !row.routes.includes(candidate))) {
      const refusal = routeRefusal(route, scopes);
      assert.ok(refusal !== undefined);
      assert.deepEqual([refusalAnswer(refusal).status, refusal.reason === 'insufficient_scope' && refusal.scopes], [403, [ROUTE_SCOPES[route]]]);
    }

    const store = new CaseStore(':memory:', () => new Date('2026-01-01T09:00:00.000Z'));
    store.createCase(message('m1'), COMPLETE);
    const server = buildMcpServer(store, message('m2'), scopes);
    const client = new Client({ name: 'probe', version: '1' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    t.after(async () => {
      await client.close();
      store.close();
    });
    // A server offered no tool at all does not answer tools/list.
    const offered = await client.listTools().then((listed) => listed.tools.map((tool) => tool.name).sort(), () => []);
    assert.deepEqual(offered, row.tools, `tools for ${row.scope}`);
    const state = (): string => JSON.stringify([store.find({}), store.versions('AE-000001'), store.auditTrail('AE-000001')]);
    for (const tool of TOOLS.filter((candidate) => !row.tools.includes(candidate))) {
      const before = state();
      const refused = await client.callTool({ name: tool, arguments: ARGS[tool] }).then((result) => result.isError === true, () => true);
      assert.deepEqual([refused, state()], [true, before], `${tool} with ${row.scope}`);
    }
  }
});
