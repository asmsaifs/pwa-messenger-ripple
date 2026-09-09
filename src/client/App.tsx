import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { UpdateToast } from './components/UpdateToast';
import { queryClient } from './app/queryClient';
import { router } from './app/router';
import { useOutboxFlusher } from './lib/useOutboxFlusher';

function App() {
  useOutboxFlusher();
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <UpdateToast />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
