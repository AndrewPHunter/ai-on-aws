// The access token a call to one target carries. A target is a scope: an agent's scope, cases:read or
// cases:review. The session's token for that scope is used if it has the call's minimum life left;
// otherwise a refresh with that scope gets one, which is kept under it.
//
// Refreshes of one session run one at a time, in the order asked, each with the refresh token the last
// one returned. A refresh looks again for a kept token when its turn comes, so two calls for the same
// target that arrive together share one refresh, and a call never gets another target's token.

import { IdentityUnreachable, SignInRefused } from './identity.ts';
import type { Refreshed } from './identity.ts';
import type { Session } from './sessions.ts';

export type TokenDeps = {
  refresh: (refreshToken: string, scope: string) => Promise<Refreshed>;
  now: () => Date;
  // Whether the session is still signed in, and how to end it.
  isLive: (session: Session) => boolean;
  end: (session: Session) => void;
};

export type TokenOutcome =
  | { outcome: 'token'; accessToken: string }
  // The session has ended: the refresh failed, or the provider issued a token too short for the call.
  | { outcome: 'ended'; reason: string }
  // The refresh succeeded but the token does not hold the scope asked for. The session goes on.
  | { outcome: 'not_granted'; reason: string };

function kept(session: Session, scope: string, minLifeMs: number, nowMs: number): string | undefined {
  const token = session.tokens.get(scope);
  return token !== undefined && token.expiresAt - nowMs >= minLifeMs ? token.accessToken : undefined;
}

async function refreshInTurn(session: Session, scope: string, minLifeMs: number, deps: TokenDeps): Promise<TokenOutcome> {
  if (!deps.isLive(session)) {
    return { outcome: 'ended', reason: 'Your session ended before this request could be sent. Sign in again.' };
  }
  const shared = kept(session, scope, minLifeMs, deps.now().getTime());
  if (shared !== undefined) {
    return { outcome: 'token', accessToken: shared };
  }
  if (session.refreshToken === null) {
    deps.end(session);
    return { outcome: 'ended', reason: 'Your session has no refresh token. Sign in again.' };
  }
  let refreshed: Refreshed;
  try {
    refreshed = await deps.refresh(session.refreshToken, scope);
  } catch (error) {
    if (error instanceof IdentityUnreachable || error instanceof SignInRefused) {
      deps.end(session);
      return { outcome: 'ended', reason: `Your sign-in could not be renewed: ${error.message} Sign in again.` };
    }
    throw error;
  }
  // Kept even when the scope is missing: the old refresh token may already be spent.
  if (refreshed.refreshToken !== null) {
    session.refreshToken = refreshed.refreshToken;
  }
  if (!refreshed.granted.includes(scope)) {
    return { outcome: 'not_granted', reason: `The identity provider did not grant ${scope} to your account.` };
  }
  if (refreshed.accessExpiresAt - deps.now().getTime() < minLifeMs) {
    deps.end(session);
    return {
      outcome: 'ended',
      reason: `The identity provider issued an access token that lives less than the ${minLifeMs / 1000} seconds this request needs. Sign in again.`,
    };
  }
  session.tokens.set(scope, { accessToken: refreshed.accessToken, expiresAt: refreshed.accessExpiresAt });
  return { outcome: 'token', accessToken: refreshed.accessToken };
}

export function tokenFor(session: Session, scope: string, minLifeMs: number, deps: TokenDeps): Promise<TokenOutcome> {
  const ready = kept(session, scope, minLifeMs, deps.now().getTime());
  if (ready !== undefined) {
    return Promise.resolve({ outcome: 'token', accessToken: ready });
  }
  const turn = session.refreshes.then(() => refreshInTurn(session, scope, minLifeMs, deps));
  session.refreshes = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}
