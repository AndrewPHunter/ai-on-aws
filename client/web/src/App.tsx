import { Inbox, ClipboardCheck, Activity } from 'lucide-react';
import { NavLink, Navigate, Route, Routes } from 'react-router';

import type { SessionMay, SessionUser } from '../../shared/api.ts';
import { failureText, useCases, useSession, useSignOut, useStatus } from './api.ts';
import { Empty, Loading, Problem } from './components.tsx';
import { CasePage } from './pages/CasePage.tsx';
import { CasesPage } from './pages/CasesPage.tsx';
import { InquiriesPage } from './pages/InquiriesPage.tsx';
import { SystemPage } from './pages/SystemPage.tsx';
import { SignedInProvider } from './session.tsx';

// Rendered only for a session that may read cases, so nobody else asks for them.
function CasesLink() {
  const awaiting = useCases('awaiting_review');
  const waiting = awaiting.data?.cases.length ?? 0;
  return (
    <NavLink to="/cases" className="rail__link">
      <ClipboardCheck size={18} aria-hidden="true" />
      <span>Cases</span>
      {waiting > 0 ? (
        <span className="rail__count" title={`${waiting} awaiting review`}>
          {awaiting.data?.truncated === true ? `${waiting}+` : waiting}
        </span>
      ) : null}
    </NavLink>
  );
}

function mayText(may: SessionMay): string {
  if (may.decide_cases) return 'Can decide cases.';
  if (may.read_cases) return 'Can read cases, not decide them.';
  return 'Cannot see cases.';
}

function Rail({ user, may }: { user: SessionUser; may: SessionMay }) {
  const signOut = useSignOut();
  const status = useStatus();
  const down = status.data?.pieces.filter((piece) => piece.state === 'down').length ?? 0;

  return (
    <header className="rail">
      <div className="rail__mark">
        <span className="rail__glyph" aria-hidden="true" />
        <span className="rail__name">Medical information desk</span>
      </div>

      <nav className="rail__nav" aria-label="Sections">
        {may.agents.length > 0 ? (
          <NavLink to="/inquiries" className="rail__link">
            <Inbox size={18} aria-hidden="true" />
            <span>Inquiries</span>
          </NavLink>
        ) : null}
        {may.read_cases ? <CasesLink /> : null}
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
        <p className="rail__hint">{mayText(may)}</p>
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

function NothingToDo() {
  return (
    <div className="column">
      <Empty title="Nothing to do here">
        <p>Your account has nothing to do at this desk: it may not send inquiries to an agent or read cases.</p>
      </Empty>
    </div>
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

  const { user, may } = session.data;
  const inquiries = may.agents.length > 0;
  // Where a path the session has no page for leads. With neither inquiries nor cases, every such path
  // shows that the account has nothing to do here.
  const home = inquiries ? '/inquiries' : may.read_cases ? '/cases' : undefined;
  const elsewhere = home === undefined ? <NothingToDo /> : <Navigate to={home} replace />;
  return (
    <SignedInProvider session={session.data}>
      <div className="shell">
        <Rail user={user} may={may} />
        <main className="page">
          <Routes>
            <Route path="/" element={elsewhere} />
            {inquiries ? <Route path="/inquiries" element={<InquiriesPage />} /> : null}
            {inquiries ? <Route path="/inquiries/:inquiryId" element={<InquiriesPage />} /> : null}
            {may.read_cases ? <Route path="/cases" element={<CasesPage />} /> : null}
            {may.read_cases ? <Route path="/cases/:caseId" element={<CasePage />} /> : null}
            <Route path="/system" element={<SystemPage />} />
            <Route path="*" element={elsewhere} />
          </Routes>
        </main>
      </div>
    </SignedInProvider>
  );
}
