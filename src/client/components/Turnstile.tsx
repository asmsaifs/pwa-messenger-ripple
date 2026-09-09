import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render(container: HTMLElement, options: { sitekey: string; callback: (token: string) => void }): string;
      remove(widgetId: string): void;
    };
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('failed to load Turnstile'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

// Rendered only when `VITE_TURNSTILE_SITE_KEY` is set at build time — the
// server-side captcha plugin only activates when `TURNSTILE_SECRET` is set
// (src/server/lib/auth.ts), so local dev/tests work without either.
export function Turnstile(props: { siteKey: string; onToken: (token: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onTokenRef = useRef(props.onToken);
  onTokenRef.current = props.onToken;

  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;

    void loadScript().then(() => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: props.siteKey,
        callback: (token) => onTokenRef.current(token),
      });
    });

    return () => {
      cancelled = true;
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [props.siteKey]);

  return <div ref={containerRef} />;
}
