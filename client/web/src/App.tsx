import { Inbox, ClipboardCheck, Activity } from 'lucide-react';
import { NavLink, Navigate, Route, Routes } from 'react-router';

import { useCases, useStatus } from './api.ts';
import { CasePage } from './pages/CasePage.tsx';
import { CasesPage } from './pages/CasesPage.tsx';
import { InquiriesPage } from './pages/InquiriesPage.tsx';
import { SystemPage } from './pages/SystemPage.tsx';
import { useReviewer } from './reviewer.tsx';

function Rail() {
  const reviewer = useReviewer();
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
        <label htmlFor="reviewer-name">Reviewing as</label>
        <input
          id="reviewer-name"
          value={reviewer.name}
          onChange={(event) => reviewer.setName(event.target.value)}
          placeholder="Your name"
          autoComplete="name"
        />
        <p className="rail__hint">Decisions are recorded under this name. Nobody is signed in here.</p>
      </div>
    </header>
  );
}

export function App() {
  return (
    <div className="shell">
      <Rail />
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
  );
}
