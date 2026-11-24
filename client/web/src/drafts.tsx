// A desk worker's edits to a draft reply, by the run that wrote the draft. They are held in this page's memory
// only: opening another inquiry and coming back keeps them, and reloading the page loses them. Nothing is sent
// to the server or written to the browser's storage.

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

type DraftEdits = {
  edits: ReadonlyMap<string, string>;
  change: (runId: string, text: string) => void;
  reset: (runId: string) => void;
};

const DraftEditsContext = createContext<DraftEdits | null>(null);

export function DraftEditsProvider({ children }: { children: ReactNode }) {
  const [edits, setEdits] = useState<ReadonlyMap<string, string>>(() => new Map());
  const change = useCallback((runId: string, text: string) => {
    setEdits((current) => new Map(current).set(runId, text));
  }, []);
  const reset = useCallback((runId: string) => {
    setEdits((current) => {
      const next = new Map(current);
      next.delete(runId);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ edits, change, reset }), [edits, change, reset]);
  return <DraftEditsContext value={value}>{children}</DraftEditsContext>;
}

// The edited text of a run's draft, or undefined when it has not been edited (or was reset), with the two ways
// to change that.
export function useDraftEdit(runId: string): {
  text: string | undefined;
  change: (text: string) => void;
  reset: () => void;
} {
  const drafts = useContext(DraftEditsContext);
  if (drafts === null) {
    throw new Error('useDraftEdit needs a DraftEditsProvider above it');
  }
  const { edits, change, reset } = drafts;
  return {
    text: edits.get(runId),
    change: (text: string) => change(runId, text),
    reset: () => reset(runId),
  };
}
