/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  // Optional — the Turnstile widget (src/client/components/Turnstile.tsx)
  // only renders when this is set. The server's captcha plugin similarly
  // only activates when `TURNSTILE_SECRET` is set (src/server/lib/auth.ts).
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
