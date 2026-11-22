// How an agent gets the token it sends a tool server. Shared by all three agents.
//
// An agent is called with a token meant for itself. Before it connects to its tool server it exchanges that
// token, once per run, as itself, for one naming the tool server's audience and the scopes it needs there
// (the TokenExchange in shared/token-exchange.ts). Only the exchanged token goes to the tool server. An
// exchange that is refused or cannot be made is a reason the run ends with: nothing is connected. It is not
// retried.

import type { InboundMessage } from '../../../shared/agent-contract.ts';
import type { TokenExchange } from '../../../shared/token-exchange.ts';
import type { Connected } from './tool-set.ts';

// A tool server as an exchange names it: its audience, the scopes the agent needs there, and its name in a
// run's reason.
export type ToolServer = { name: string; audience: string; scopes: readonly string[] };

// What each intake agent asks for: it creates, finds and adds to cases.
export const CASE_SYSTEM: ToolServer = { name: 'the case system', audience: 'case-system', scopes: ['cases:write', 'cases:lookup'] };

// What the label expert asks for: it searches labels.
export const KNOWLEDGE: ToolServer = { name: 'the retrieval service', audience: 'knowledge', scopes: ['labels:search'] };

export type ToolToken = { ok: true; token: string } | { ok: false; reason: string };

// Exchanges the caller's token for one meant for the tool server, within the time given. A refused exchange
// becomes the run's reason with the exchange's detail: the provider's words, which hold no token or secret.
// An unavailable exchange becomes a fixed sentence of the agent's own, because its detail can name the
// provider's host and port, and a run's response carries no address.
export async function toolToken(exchange: TokenExchange, server: ToolServer, callerToken: string, timeoutMs: number): Promise<ToolToken> {
  const got = await exchange({ subjectToken: callerToken, audience: server.audience, scopes: server.scopes, timeoutMs });
  if (got.kind === 'token') {
    return { ok: true, token: got.token };
  }
  if (got.kind === 'refused') {
    return { ok: false, reason: `The agent could not get a token for ${server.name}: ${got.detail}` };
  }
  return {
    ok: false,
    reason: `The agent could not get a token for ${server.name}: the identity provider could not be reached or did not answer in time.`,
  };
}

export type ConnectTools = (message: InboundMessage, token: string, timeoutMs: number) => Promise<Connected>;

// A connection that is given the caller's token and connects with the exchanged one. The exchange and the
// connection are each given the time this is given. This is how the hand-written intake agent is wired.
export function connectWithToolToken(exchange: TokenExchange, server: ToolServer, connect: ConnectTools): ConnectTools {
  return async (message, callerToken, timeoutMs) => {
    const got = await toolToken(exchange, server, callerToken, timeoutMs);
    if (!got.ok) {
      return { ok: false, reason: got.reason };
    }
    return connect(message, got.token, timeoutMs);
  };
}
