import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/source-serif-4/opsz.css';
import '@fontsource-variable/source-serif-4/opsz-italic.css';
import './styles.css';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { SESSION_KEY, isSignedOut } from './api.ts';
import { App } from './App.tsx';
import { DraftEditsProvider } from './drafts.tsx';

// Any request answered 401 not_signed_in means the session is gone: the app goes back to the sign-in
// screen.
function onError(error: unknown): void {
  if (isSignedOut(error)) {
    queryClient.setQueryData(SESSION_KEY, null);
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, staleTime: 1000 } },
});

const root = document.getElementById('root');
if (root === null) {
  throw new Error('The page has no #root element');
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <DraftEditsProvider>
          <App />
        </DraftEditsProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
