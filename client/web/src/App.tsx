import { ChevronDown, ExternalLink } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router';

import type { SessionMay, SessionUser } from '../../shared/api.ts';
import { failureText, useCases, useSession, useSignOut } from './api.ts';
import { Empty, Loading, Problem } from './components.tsx';
import { roleWords } from './format.ts';
import { INBOX_AGENT, LABEL_AGENT } from './inbox.ts';
import { LabApp } from './lab/LabApp.tsx';
import { CasePage } from './pages/CasePage.tsx';
import { CasesPage } from './pages/CasesPage.tsx';
import { InboxPage } from './pages/InboxPage.tsx';
import { LabelPage } from './pages/LabelPage.tsx';
import { LogInquiryPage } from './pages/LogInquiryPage.tsx';
import { SignedInProvider } from './session.tsx';

// Every path under /lab is the lab explorer, which asks nothing of the desk, not even who is signed in.
// Everything else is the desk.
export function App() {
  const { pathname } = useLocation();
  if (pathname === '/lab' || pathname.startsWith('/lab/')) {
    return <LabApp />;
  }
  return <Desk />;
}

function Mark() {
  return (
    <span className="mark">
      <svg aria-hidden="true" width="26" height="26" viewBox="0 0 26 26" fill="none" strokeWidth="2">
        <rect x="2" y="2" width="22" height="22" stroke="currentColor" />
        <path d="M13 7v12M7 13h12" className="mark__cross" />
      </svg>
      <span className="mark__name">Medical Information Desk</span>
    </span>
  );
}

// The sections this session may use, in the order the header shows them.
type Section = 'inbox' | 'label' | 'cases';

function sectionsOf(may: SessionMay): Section[] {
  const sections: Section[] = [];
  if (may.agents.includes(INBOX_AGENT)) sections.push('inbox');
  if (may.agents.includes(LABEL_AGENT)) sections.push('label');
  if (may.read_cases) sections.push('cases');
  return sections;
}

const SECTION_PATH: Record<Section, string> = { inbox: '/inquiries', label: '/label', cases: '/cases' };

// Rendered only for a session that may read cases, so nobody else asks for them.
function CasesLink() {
  const awaiting = useCases('awaiting_review');
  const waiting = awaiting.data?.cases.length ?? 0;
  return (
    <NavLink to="/cases" className="nav__link">
      Cases
      {waiting > 0 ? (
        <span className="tag tag--awaiting_review">
          {waiting}
          {awaiting.data?.truncated === true ? '+' : ''} to review
        </span>
      ) : null}
    </NavLink>
  );
}

function UserMenu({ user }: { user: SessionUser }) {
  const signOut = useSignOut();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const box = useRef<HTMLDivElement>(null);
  const roles = roleWords(user.roles);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointer(event: PointerEvent): void {
      if (box.current !== null && event.target instanceof Node && !box.current.contains(event.target)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="usermenu" ref={box}>
      <button
        type="button"
        className="usermenu__button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="usermenu__who">
          <span className="usermenu__name">{user.name}</span>
          {roles.length === 0 ? null : <span className="usermenu__role">{roles.join(', ')}</span>}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="usermenu__panel" id={menuId}>
          <button
            type="button"
            className="usermenu__item"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            {signOut.isPending ? 'Signing out…' : 'Sign out'}
          </button>
          {signOut.isError ? <Problem>{failureText(signOut.error)}</Problem> : null}
        </div>
      ) : null}
    </div>
  );
}

function LabLink() {
  return (
    <a className="lablink" href="/lab" target="_blank" rel="noopener">
      <ExternalLink size={15} aria-hidden="true" />
      Open lab explorer
    </a>
  );
}

function Header({ user, sections }: { user: SessionUser; sections: readonly Section[] }) {
  return (
    <header className="topbar">
      <Mark />
      <nav className="nav" aria-label="Sections">
        {sections.includes('inbox') ? (
          <NavLink to="/inquiries" className="nav__link">
            Inbox
          </NavLink>
        ) : null}
        {sections.includes('label') ? (
          <NavLink to="/label" className="nav__link">
            Ask the label
          </NavLink>
        ) : null}
        {sections.includes('cases') ? <CasesLink /> : null}
      </nav>
      <div className="topbar__end">
        <LabLink />
        <UserMenu user={user} />
      </div>
    </header>
  );
}

// Each new page starts at its top.
function ScrollToTop() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname, search]);
  return null;
}

function NothingToDo() {
  return (
    <div className="page page--narrow">
      <Empty title="Nothing to do here">
        <p>Your account has nothing to do at this desk: it may not log inquiries, ask the label or read cases.</p>
      </Empty>
    </div>
  );
}

function SignIn() {
  return (
    <main className="signin">
      <div className="signin__card">
        <Mark />
        <p>Sign in with your desk account to answer inquiries and review adverse event cases.</p>
        <a className="button button--primary button--wide" href="/auth/login">
          Sign in
        </a>
        <a className="signin__lab" href="/lab">
          Open lab explorer
        </a>
      </div>
    </main>
  );
}

function Desk() {
  const session = useSession();

  if (session.isPending) {
    return (
      <main className="signin">
        <Loading what="who is signed in" />
      </main>
    );
  }
  if (session.isError) {
    return (
      <main className="signin">
        <div className="signin__card">
          <Problem>
            <p>{failureText(session.error)}</p>
            <p>Reload the page to try again.</p>
          </Problem>
        </div>
      </main>
    );
  }
  if (session.data === null) {
    return <SignIn />;
  }

  const { user, may } = session.data;
  const sections = sectionsOf(may);
  const first = sections[0];
  // Where a path the session has no page for leads: the first section it may use, or, with none, a page
  // saying the account has nothing to do here.
  const elsewhere = first === undefined ? <NothingToDo /> : <Navigate to={SECTION_PATH[first]} replace />;
  return (
    <SignedInProvider session={session.data}>
      <ScrollToTop />
      <Header user={user} sections={sections} />
      <main className="main">
        <Routes>
          <Route path="/" element={elsewhere} />
          {sections.includes('inbox') ? (
            <>
              <Route path="/inquiries" element={<InboxPage />} />
              <Route path="/inquiries/new" element={<LogInquiryPage />} />
              <Route path="/inquiries/:inquiryId" element={<InboxPage />} />
            </>
          ) : null}
          {sections.includes('label') ? <Route path="/label" element={<LabelPage />} /> : null}
          {sections.includes('cases') ? (
            <>
              <Route path="/cases" element={<CasesPage />} />
              <Route path="/cases/:caseId" element={<CasePage />} />
            </>
          ) : null}
          <Route path="*" element={elsewhere} />
        </Routes>
      </main>
    </SignedInProvider>
  );
}
