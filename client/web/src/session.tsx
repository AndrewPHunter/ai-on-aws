// Who is signed in and what they may do, for the screens that need it. The server knows from its session;
// the app is told by GET /api/session and holds no token.

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import type { SessionMay, SessionUser, SessionView } from '../../shared/api.ts';

const SignedInContext = createContext<SessionView | null>(null);

export function SignedInProvider({ session, children }: { session: SessionView; children: ReactNode }) {
  return <SignedInContext.Provider value={session}>{children}</SignedInContext.Provider>;
}

function useSignedIn(): SessionView {
  const session = useContext(SignedInContext);
  if (session === null) {
    throw new Error('A signed-in hook is used outside SignedInProvider');
  }
  return session;
}

export function useSignedInUser(): SessionUser {
  return useSignedIn().user;
}

export function useMay(): SessionMay {
  return useSignedIn().may;
}
