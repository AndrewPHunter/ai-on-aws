// Who is signed in, in the server's memory only. A session holds the user and their tokens; the browser
// holds only the session's identifier, in a cookie. Nothing here is written to disk, so every session
// ends when the process does.
//
// Also the sign-ins under way: the state, nonce and PKCE verifier of each, until its callback arrives,
// and the binding: a value also given to the browser that started the sign-in, in a cookie, so that only
// that browser can complete it.

import type { PendingSignIn, SignedInUser, TokenSet } from './identity.ts';

// A sign-in must be completed in under this: a callback this late or later is refused.
export const PENDING_LIFETIME_MS = 10 * 60 * 1000;
// At most this many sign-ins wait for their callback; starting another forgets the oldest.
export const MAX_PENDING = 1000;
// 256 bits, for session identifiers, state, nonce, the PKCE verifier and the binding.
const SECRET_BYTES = 32;

export type Session = {
  id: string;
  user: SignedInUser;
  tokens: TokenSet;
  // A renewal under way, so requests that arrive meanwhile wait for it instead of starting another.
  renewing: Promise<TokenSet> | null;
};

type Pending = PendingSignIn & { binding: string; startedAt: number };

export type StartedSignIn = { pending: PendingSignIn; binding: string };

export class SessionStore {
  private readonly now: () => Date;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly sessions = new Map<string, Session>();
  // In insertion order, so the first entry is the oldest.
  private readonly pending = new Map<string, Pending>();

  constructor(now: () => Date, randomBytes: (size: number) => Uint8Array) {
    this.now = now;
    this.randomBytes = randomBytes;
  }

  private secret(): string {
    const bytes = this.randomBytes(SECRET_BYTES);
    if (bytes.length < SECRET_BYTES) {
      throw new Error(`The source of randomness gave ${bytes.length} bytes, not ${SECRET_BYTES}`);
    }
    return Buffer.from(bytes).toString('base64url');
  }

  beginSignIn(): StartedSignIn {
    const startedAt = this.now().getTime();
    for (const [state, entry] of this.pending) {
      if (startedAt - entry.startedAt < PENDING_LIFETIME_MS && this.pending.size < MAX_PENDING) break;
      this.pending.delete(state);
    }
    const entry: Pending = {
      state: this.secret(),
      nonce: this.secret(),
      verifier: this.secret(),
      binding: this.secret(),
      startedAt,
    };
    this.pending.set(entry.state, entry);
    return { pending: { state: entry.state, nonce: entry.nonce, verifier: entry.verifier }, binding: entry.binding };
  }

  // The sign-in a callback's state belongs to, used up by taking it whatever the outcome. Undefined when
  // the state is unknown or already used, the sign-in is PENDING_LIFETIME_MS old or older, or the binding
  // the browser sent is missing or is not this sign-in's.
  takePending(state: string, binding: string | undefined): PendingSignIn | undefined {
    const entry = this.pending.get(state);
    if (entry === undefined) return undefined;
    this.pending.delete(state);
    if (this.now().getTime() - entry.startedAt >= PENDING_LIFETIME_MS) return undefined;
    if (binding === undefined || binding !== entry.binding) return undefined;
    return { state: entry.state, nonce: entry.nonce, verifier: entry.verifier };
  }

  // Forgets a sign-in that will not be completed.
  dropPending(state: string): void {
    this.pending.delete(state);
  }

  create(user: SignedInUser, tokens: TokenSet): Session {
    const session: Session = { id: this.secret(), user, tokens, renewing: null };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  // How long the session's access token has left, by this store's clock.
  remainingMs(session: Session): number {
    return session.tokens.accessExpiresAt - this.now().getTime();
  }
}
