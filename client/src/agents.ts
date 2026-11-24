// Calls an agent over the agent contract. Every way a call can go wrong comes back as a reason a
// person can read, and nothing the agent returns is used until it has passed the contract's schema.

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { InvocationRequest, InvocationResponse } from '../../shared/agent-contract.ts';
import type { Outcome, Telemetry } from '../../shared/telemetry.ts';

export type InvokeResult = { outcome: 'ok'; response: InvocationResponse } | { outcome: 'failed'; reason: string };

export type PingResult = { outcome: 'up' } | { outcome: 'down'; reason: string };

export function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

export function seconds(timeoutMs: number): string {
  const value = timeoutMs / 1000;
  return value === 1 ? '1 second' : `${value} seconds`;
}

// fetch reports "fetch failed" and keeps the useful part, such as ECONNREFUSED, in the cause.
export function describe(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

// The fetch and the reading of the body share one timeout, so an agent that sends headers and then
// stalls is treated the same as one that never answers. The call carries the access token got for the agent's
// scope: the signed-in user's, or the contact form's or the lab explorer's own.
//
// The call is one span, agent.invoke, of kind client, a child of the current span (the run's), with the run's id as
// its operation and attempt 1. The request carries traceparent naming that span. Its outcome tells an answer inside
// the contract (executed, whatever outcome the answer reports) from no answer (response_lost: none in time, or the
// connection failed) and from an answer outside the contract or a refusal (failed).
export async function invokeAgent(
  telemetry: Telemetry,
  operationId: string,
  url: string,
  request: InvocationRequest,
  timeoutMs: number,
  accessToken: string,
): Promise<InvokeResult> {
  const attributes = { 'lab.operation.id': operationId, 'lab.attempt': 1 };
  return telemetry.span('agent.invoke', { kind: 'client', attributes }, async (span) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    };
    telemetry.inject(headers);
    const called = await callAgent(url, request, timeoutMs, headers);
    span.set({ 'lab.outcome': called.outcome });
    return called.result;
  });
}

type Called = { outcome: Extract<Outcome, 'executed' | 'response_lost' | 'failed'>; result: InvokeResult };

const failedWith = (outcome: Called['outcome'], reason: string): Called => ({ outcome, result: { outcome: 'failed', reason } });

async function callAgent(url: string, request: InvocationRequest, timeoutMs: number, headers: Record<string, string>): Promise<Called> {
  let status: number;
  let body: string;
  try {
    const response = await fetch(`${url}/invocations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    body = await response.text();
  } catch (error) {
    if (isTimeout(error)) {
      return failedWith('response_lost', `The agent did not answer within ${seconds(timeoutMs)}.`);
    }
    return failedWith('response_lost', `Could not reach the agent: ${describe(error)}.`);
  }

  if (status < 200 || status > 299) {
    return failedWith('failed', `The agent answered with status ${status}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return failedWith('failed', "The agent's answer did not match the contract: it is not JSON.");
  }
  const result = invocationResponseSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first === undefined || first.path.length === 0 ? '(the whole answer)' : first.path.join('.');
    return failedWith('failed', `The agent's answer did not match the contract: ${where}: ${first?.message ?? 'unknown problem'}.`);
  }
  return { outcome: 'executed', result: { outcome: 'ok', response: result.data } };
}

export async function pingAgent(url: string, timeoutMs: number): Promise<PingResult> {
  return ping(`${url}/ping`, timeoutMs);
}

// Shared with the case system's health check: up means a 2xx answer within the time allowed.
// A health check carries no token.
export async function ping(target: string, timeoutMs: number): Promise<PingResult> {
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    if (response.status < 200 || response.status > 299) {
      return { outcome: 'down', reason: `It answered the health check with status ${response.status}.` };
    }
    return { outcome: 'up' };
  } catch (error) {
    if (isTimeout(error)) {
      return { outcome: 'down', reason: `It did not answer the health check within ${seconds(timeoutMs)}.` };
    }
    return { outcome: 'down', reason: `Could not reach it: ${describe(error)}.` };
  }
}
