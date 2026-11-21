import { Inbox, ClipboardCheck, Activity } from 'lucide-react';
import { NavLink, Navigate, Route, Routes } from 'react-router';

import type { SessionUser } from '../../shared/api.ts';
import { failureText, useCases, useSession, useSignOut, useStatus } from './api.ts';
import { Loading, Problem } from './components.tsx';
import { CasePage } from './pages/CasePage.tsx';
import { CasesPage } from './pages/CasesPage.tsx';
import { InquiriesPage } from './pages/InquiriesPage.tsx';
import { SystemPage } from './pages/SystemPage.tsx';
import { SignedInProvider } from './session.tsx';

function Rail({ user }: { user: SessionUser }) {
  const signOut = useSignOut();
  const awaiting = useCases('awaiting_review');
  const status = useStatus();
  const waiting = awaiting.data?.cases.length ?? 0;
  const down = status.data?.pieces.filter((piece) => piece.state === 'down').length ?? 0;

  return (
    <header className="rail">
      <div className="rail__mark">
        <span className="rail__glyph" aria-hidden="true" />
        <span className="rail__name">Medical information desk</span>
      </div>

      <nav className="rail__nav" aria-label="Sections">
        <NavLink to="/inquiries" className="rail__link">
          <Inbox size={18} aria-hidden="true" />
          <span>Inquiries</span>
        </NavLink>
        <NavLink to="/cases" className="rail__link">
          <ClipboardCheck size={18} aria-hidden="true" />
          <span>Cases</span>
          {waiting > 0 ? (
            <span className="rail__count" title={`${waiting} awaiting review`}>
              {awaiting.data?.truncated === true ? `${waiting}+` : waiting}
            </span>
          ) : null}
        </NavLink>
        <NavLink to="/system" className="rail__link">
          <Activity size={18} aria-hidden="true" />
          <span>System</span>
          {down > 0 ? (
            <span className="rail__count rail__count--alert" title={`${down} not reachable`}>
              {down}
            </span>
          ) : null}
        </NavLink>
      </nav>

      <div className="rail__reviewer">
        <p className="rail__hint">Signed in as</p>
        <p>
          <strong>{user.name}</strong>
        </p>
        <p className="rail__hint">{user.is_reviewer ? 'Reviewer: can decide cases.' : 'Not a reviewer.'}</p>
        <button
          type="button"
          className="button button--small"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          Sign out
        </button>
        {signOut.isError ? <Problem>{failureText(signOut.error)}</Problem> : null}
      </div>
    </header>
  );
}

function SignIn() {
  return (
    <main className="page">
      <div className="column">
        <div className="empty">
          <p className="empty__title">Medical information desk</p>
          <div className="empty__body">
            <p>Sign in with your desk account to receive inquiries and review cases.</p>
            <p>
              <a className="button button--primary" href="/auth/login">
                Sign in
              </a>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

export function App() {
  const session = useSession();

  if (session.isPending) {
    return (
      <main className="page">
        <div className="column">
          <Loading what="who is signed in" />
        </div>
      </main>
    );
  }
  if (session.isError) {
    return (
      <main className="page">
        <div className="column">
          <Problem>{failureText(session.error)}</Problem>
        </div>
      </main>
    );
  }
  if (session.data === null) {
    return <SignIn />;
  }

  const { user } = session.data;
  return (
    <SignedInProvider user={user}>
      <div className="shell">
        <Rail user={user} />
        <main className="page">
          <Routes>
            <Route path="/" element={<Navigate to="/inquiries" replace />} />
            <Route path="/inquiries" element={<InquiriesPage />} />
            <Route path="/inquiries/:inquiryId" element={<InquiriesPage />} />
            <Route path="/cases" element={<CasesPage />} />
            <Route path="/cases/:caseId" element={<CasePage />} />
            <Route path="/system" element={<SystemPage />} />
            <Route path="*" element={<Navigate to="/inquiries" replace />} />
          </Routes>
        </main>
      </div>
    </SignedInProvider>
  );
}
