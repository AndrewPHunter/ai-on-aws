// Who is signed in, for the screens that need it. The server knows from its session; the app is told by
// GET /api/session and holds no token.

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import type { SessionUser } from '../../shared/api.ts';

const SignedInContext = createContext<SessionUser | null>(null);

export function SignedInProvider({ user, children }: { user: SessionUser; children: ReactNode }) {
  return <SignedInContext.Provider value={user}>{children}</SignedInContext.Provider>;
}

export function useSignedInUser(): SessionUser {
  const user = useContext(SignedInContext);
  if (user === null) {
    throw new Error('useSignedInUser is used outside SignedInProvider');
  }
  return user;
}
