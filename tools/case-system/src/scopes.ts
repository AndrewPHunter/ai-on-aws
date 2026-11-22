// Which scope each tool and each route needs. Each server's token check requires at least one scope of
// its own rows; past the check, a tool is offered and a route reached only with its own scope.

import type { Refusal } from '../../../shared/access-token.ts';

// The agents' server: MCP tools.
export const TOOL_SCOPES = {
  create_case: 'cases:write',
  add_follow_up: 'cases:write',
  find_case: 'cases:lookup',
} as const;

// The review server: routes, by method and path.
export const ROUTE_SCOPES = {
  'GET /cases': 'cases:read',
  'GET /cases/<id>': 'cases:read',
  'POST /cases/<id>/review': 'cases:review',
} as const;

export type ToolName = keyof typeof TOOL_SCOPES;
export type Route = keyof typeof ROUTE_SCOPES;

export const AGENT_SERVER_SCOPES: readonly string[] = [...new Set(Object.values(TOOL_SCOPES))];
export const REVIEW_SERVER_SCOPES: readonly string[] = [...new Set(Object.values(ROUTE_SCOPES))];

// Whether the caller's scopes reach the tool.
export function offersTool(tool: ToolName, scopes: readonly string[]): boolean {
  return scopes.includes(TOOL_SCOPES[tool]);
}

// The refusal for a caller whose scopes do not reach the route, naming the route's one scope; undefined
// when they do.
export function routeRefusal(route: Route, scopes: readonly string[]): Refusal | undefined {
  const scope = ROUTE_SCOPES[route];
  if (scopes.includes(scope)) {
    return undefined;
  }
  return { kind: 'refused', reason: 'insufficient_scope', detail: `${route} needs the scope ${scope}.`, scopes: [scope] };
}
