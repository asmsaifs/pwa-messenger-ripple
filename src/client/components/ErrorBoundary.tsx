import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui/button';

// docs/04 §4: "global boundary sends to Sentry with a Reload CTA." Sentry
// wiring is a M15 deliverable — this is the boundary shape it plugs into.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
