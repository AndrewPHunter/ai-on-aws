// Forwards case review to the case system's review server. The case system owns every decision about
// a case, so its status code and body are passed back unchanged; the client adds nothing and hides
// nothing. Only a review server that cannot be reached, or that answers with something other than
// JSON, becomes an answer of the client's own. Every call carries the signed-in user's access token.

import { describe, isTimeout, seconds } from './agents.ts';

export const CASE_TIMEOUT_MS = 10_000;

export type Forwarded = { outcome: 'answered'; status: number; body: unknown } | { outcome: 'unreachable'; reason: string };

async function forward(target: string, init: RequestInit): Promise<Forwarded> {
  let status: number;
  let text: string;
  try {
    const response = await fetch(target, { ...init, signal: AbortSignal.timeout(CASE_TIMEOUT_MS) });
    status = response.status;
    text = await response.text();
  } catch (error) {
    if (isTimeout(error)) {
      return { outcome: 'unreachable', reason: `The case system did not answer within ${seconds(CASE_TIMEOUT_MS)}.` };
    }
    return { outcome: 'unreachable', reason: `Could not reach the case system: ${describe(error)}.` };
  }
  try {
    const body: unknown = JSON.parse(text);
    return { outcome: 'answered', status, body };
  } catch {
    return { outcome: 'unreachable', reason: `The case system answered with status ${status} and a body that is not JSON.` };
  }
}

function bearer(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

export function listCases(baseUrl: string, status: string | null, accessToken: string): Promise<Forwarded> {
  const query = status === null ? '' : `?${new URLSearchParams({ status }).toString()}`;
  return forward(`${baseUrl}/cases${query}`, { method: 'GET', headers: bearer(accessToken) });
}

export function getCase(baseUrl: string, caseId: string, accessToken: string): Promise<Forwarded> {
  return forward(`${baseUrl}/cases/${encodeURIComponent(caseId)}`, { method: 'GET', headers: bearer(accessToken) });
}

export function postReview(baseUrl: string, caseId: string, review: unknown, accessToken: string): Promise<Forwarded> {
  return forward(`${baseUrl}/cases/${encodeURIComponent(caseId)}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(accessToken) },
    body: JSON.stringify(review),
  });
}
