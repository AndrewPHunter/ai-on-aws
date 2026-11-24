// The lab explorer: every piece and every run, with no sign-in. Rendered for every path under /lab.
// It picks its page from the path itself, so it does not depend on how the app mounts it, and it asks only
// for /lab/api routes, never for the session or anything under /api.

import './lab.css';

import { useEffect } from 'react';
import { Link, NavLink, useLocation } from 'react-router';

import { EvaluationPage } from './EvaluationPage.tsx';
import { KnowledgePage } from './KnowledgePage.tsx';
import { MapPage } from './MapPage.tsx';
import { PeoplePage } from './PeoplePage.tsx';
import { RunPage } from './RunPage.tsx';
import { RunsPage } from './RunsPage.tsx';
import { ScenariosPage } from './ScenariosPage.tsx';

type Page =
  | { page: 'map' }
  | { page: 'scenarios' }
  | { page: 'runs' }
  | { page: 'run'; runId: string }
  | { page: 'knowledge' }
  | { page: 'evaluation' }
  | { page: 'people' }
  | { page: 'unknown' };

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function pageOf(pathname: string): Page {
  const parts = pathname.split('/').filter((part) => part !== '');
  if (parts[0] !== 'lab') {
    return { page: 'unknown' };
  }
  const [, section, id, ...rest] = parts;
  if (rest.length > 0) {
    return { page: 'unknown' };
  }
  if (section === undefined) {
    return { page: 'map' };
  }
  if (id === undefined) {
    switch (section) {
      case 'scenarios':
        return { page: 'scenarios' };
      case 'runs':
        return { page: 'runs' };
      case 'knowledge':
        return { page: 'knowledge' };
      case 'evaluation':
        return { page: 'evaluation' };
      case 'people':
        return { page: 'people' };
      default:
        return { page: 'unknown' };
    }
  }
  const runId = section === 'runs' ? decoded(id) : null;
  return runId === null || runId === '' ? { page: 'unknown' } : { page: 'run', runId };
}

const TABS = [
  { to: '/lab', label: 'Map', end: true },
  { to: '/lab/scenarios', label: 'Scenarios', end: false },
  { to: '/lab/runs', label: 'Runs', end: false },
  { to: '/lab/knowledge', label: 'Knowledge', end: false },
  { to: '/lab/evaluation', label: 'Evaluation', end: false },
  { to: '/lab/people', label: 'People', end: false },
] as const;

function Unknown() {
  return (
    <>
      <h1>Nothing here</h1>
      <p className="lab-lede">
        The explorer has no page at this address. <Link to="/lab">Go to the map</Link>, or choose a tab above.
      </p>
    </>
  );
}

export function LabApp() {
  const location = useLocation();
  const current = pageOf(location.pathname);

  // The tab's title says which tool it is, so the explorer and the desk are not confused in a tab bar.
  useEffect(() => {
    const before = document.title;
    document.title = 'Lab explorer';
    return () => {
      document.title = before;
    };
  }, []);

  return (
    <div className="lab">
      <a className="lab-skip" href="#lab-main">
        Skip to the page
      </a>
      <header className="lab-header">
        <div className="lab-header__name">
          <span className="lab-header__title">Lab explorer</span>
          <span className="lab-mono lab-header__address">{window.location.host}/lab</span>
        </div>
        <nav aria-label="Lab sections" className="lab-tabs">
          {TABS.map((tab) => (
            <NavLink key={tab.to} to={tab.to} end={tab.end} className="lab-tab">
              {tab.label}
            </NavLink>
          ))}
        </nav>
        <div className="lab-header__aside">
          <span className="lab-header__quiet">No sign-in. This machine only.</span>
          <a href="/" className="lab-header__back">
            Back to the desk
          </a>
        </div>
      </header>
      <main id="lab-main" className="lab-main" tabIndex={-1}>
        {current.page === 'map' ? <MapPage /> : null}
        {current.page === 'scenarios' ? <ScenariosPage /> : null}
        {current.page === 'runs' ? <RunsPage /> : null}
        {current.page === 'run' ? <RunPage runId={current.runId} /> : null}
        {current.page === 'knowledge' ? <KnowledgePage /> : null}
        {current.page === 'evaluation' ? <EvaluationPage /> : null}
        {current.page === 'people' ? <PeoplePage /> : null}
        {current.page === 'unknown' ? <Unknown /> : null}
      </main>
    </div>
  );
}
