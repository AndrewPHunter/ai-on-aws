// The two agents the orchestrator calls, and one call to either.
//
// A call is POST <address>/invocations with the agent contract's request, as a client makes it, carrying a token
// the orchestrator got for that agent by exchanging the caller's (../tools/tool-token.ts). The caller's own token
// is never sent. Every way a call can go wrong is a failure sentence that names no address and no token. A failed
// call is never made again.
//
// The exchange and the call share one time limit, kept here with a timer as well as passed on, so a call that
// never answers ends at the limit whatever the function making it does.

import { delegatedResponseSchema } from '../../../shared/agent-contract.ts';
import type { DelegatedResponse, InvocationRequest } from '../../../shared/agent-contract.ts';
import type { TokenExchange } from '../../../shared/token-exchange.ts';
import { INTAKE_AGENT, LABEL_EXPERT, toolToken } from '../tools/tool-token.ts';
import type { TokenTarget } from '../tools/tool-token.ts';

export type SubAgentId = 'intake-strands' | 'expert';
export type SubAgent = { id: SubAgentId; token: TokenTarget };

export const INTAKE: SubAgent = { id: 'intake-strands', token: INTAKE_AGENT };
export const EXPERT: SubAgent = { id: 'expert', token: LABEL_EXPERT };

export type SubAgentCall = { to: SubAgent; request: InvocationRequest; token: string; timeoutMs: number };
export type SubAgentAnswer = { ok: true; response: DelegatedResponse } | { ok: false; failure: string };

// Makes one call to a sub-agent. Production passes callOverHttp; a test passes a scripted function.
export type CallSubAgent = (call: SubAgentCall) => Promise<SubAgentAnswer>;

function named(to: SubAgent): string {
  const { name } = to.token;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function didNotAnswerWithin(to: SubAgent, ms: number): string {
  return `${named(to)} did not answer within ${Math.round(ms / 1000)} s.`;
}

function couldNotBeReached(to: SubAgent): string {
  return `${named(to)} could not be reached.`;
}

// The call over HTTP, to the address given for each sub-agent.
export function callOverHttp(addresses: Readonly<Record<SubAgentId, string>>, fetchFn: typeof fetch): CallSubAgent {
  return async ({ to, request, token, timeoutMs }) => {
    let status: number;
    let text: string;
    try {
      const answer = await fetchFn(`${addresses[to.id]}/invocations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
        // A redirect is an answer that is not 200, never followed: following it would send the token on.
        redirect: 'manual',
      });
      status = answer.status;
      text = await answer.text();
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return { ok: false, failure: timedOut ? didNotAnswerWithin(to, timeoutMs) : couldNotBeReached(to) };
    }
    if (status !== 200) {
      return { ok: false, failure: `${named(to)} answered with status ${status}.` };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, failure: `${named(to)}'s answer is not JSON.` };
    }
    const parsed = delegatedResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, failure: `${named(to)}'s answer is outside the agent contract.` };
    }
    return { ok: true, response: parsed.data };
  };
}

// One call with the token for it: the caller's token is exchanged for one meant for `to`, and the call is made
// with what is left of `budgetMs`. A refused or failed exchange is this call's failure. Never throws.
export async function callWithToken(
  deps: { exchange: TokenExchange; callSubAgent: CallSubAgent; now: () => Date },
  to: SubAgent,
  request: InvocationRequest,
  callerToken: string,
  budgetMs: number,
): Promise<SubAgentAnswer> {
  const started = deps.now().getTime();
  const work = async (): Promise<SubAgentAnswer> => {
    const got = await toolToken(deps.exchange, to.token, callerToken, budgetMs);
    if (!got.ok) {
      return { ok: false, failure: got.reason };
    }
    const timeoutMs = Math.max(0, budgetMs - (deps.now().getTime() - started));
    return deps.callSubAgent({ to, request, token: got.token, timeoutMs });
  };
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<SubAgentAnswer>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, failure: didNotAnswerWithin(to, budgetMs) });
    }, budgetMs);
  });
  try {
    return await Promise.race([work().catch((): SubAgentAnswer => ({ ok: false, failure: couldNotBeReached(to) })), limit]);
  } finally {
    clearTimeout(timer);
  }
}
