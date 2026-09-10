/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  // Optional — the Turnstile widget (src/client/components/Turnstile.tsx)
  // only renders when this is set. The server's captcha plugin similarly
  // only activates when `TURNSTILE_SECRET` is set (src/server/lib/auth.ts).
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  // Optional — M12 push subscribe UX (src/client/lib/push.ts) only renders
  // when this is set. Public key only (docs/05 §5); the matching private key
  // never leaves the Worker (CLAUDE.md hard rule 6).
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
