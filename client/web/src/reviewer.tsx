// Who is reviewing. The lab does not sign anyone in: this is the name a decision is recorded under.

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

type Reviewer = { name: string; setName: (name: string) => void };

const STORAGE_KEY = 'desk.reviewer';
const ReviewerContext = createContext<Reviewer | null>(null);

function stored(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function ReviewerProvider({ children }: { children: ReactNode }) {
  const [name, setNameState] = useState(stored);
  const setName = useCallback((next: string) => {
    setNameState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private windows). The name then lasts until the page is closed.
    }
  }, []);
  const value = useMemo(() => ({ name, setName }), [name, setName]);
  return <ReviewerContext.Provider value={value}>{children}</ReviewerContext.Provider>;
}

export function useReviewer(): Reviewer {
  const reviewer = useContext(ReviewerContext);
  if (reviewer === null) {
    throw new Error('useReviewer is used outside ReviewerProvider');
  }
  return reviewer;
}
