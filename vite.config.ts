import { execSync } from 'node:child_process';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import pkg from './package.json' with { type: 'json' };

// Settings' About section (docs/04) wants a build sha, which npm/package.json
// alone can't give — read from git at build time, falling back to 'dev' for
// a checkout with no git history (a downloaded tarball, some CI caches).
function buildSha(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // `root: 'src/client'` below means Vite's default envDir (same as root)
  // would look for .env.local inside src/client/ — but docs/08-DEPLOYMENT.md
  // and .env.local.example both put it at the repo root, so envDir is
  // pointed there explicitly. Without this, a bare `pnpm build` silently
  // ships a client bundle with no VITE_VAPID_PUBLIC_KEY baked in —
  // pushSupported() then reports "Not supported in this browser" in every
  // browser, with no build error to catch it (this bit staging once already).
  const envDir = __dirname;
  const env = loadEnv(mode, envDir, 'VITE_');
  if (command === 'build' && !env.VITE_VAPID_PUBLIC_KEY) {
    throw new Error(
      'VITE_VAPID_PUBLIC_KEY is not set. Push notifications will silently report ' +
        '"Not supported in this browser" for every user if this build ships. Set it in ' +
        '.env.local, or export it in the shell running `pnpm build` — see docs/08-DEPLOYMENT.md.',
    );
  }

  return {
    root: 'src/client',
    envDir,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __APP_BUILD_SHA__: JSON.stringify(buildSha()),
    },
    publicDir: path.resolve(__dirname, 'public'),
    plugins: [
      react(),
      tailwindcss(),
      // injectManifest (not generateSW) per docs/01 §1 — we own src/sw.ts so it
      // can grow push/notificationclick/Background Sync handlers in later
      // milestones instead of being regenerated from a config object.
      VitePWA({
        strategies: 'injectManifest',
        srcDir: '../',
        filename: 'sw.ts',
        injectRegister: false,
        manifest: false,
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        },
        devOptions: { enabled: false },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/client'),
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      outDir: path.resolve(__dirname, 'dist/client'),
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: {
        // `ws: true` so the dev proxy forwards the ConversationDO WS upgrade
        // (docs/03 `/api/ws/conversation/:id`, M6) the same way it forwards
        // every other `/api/*` request — the string shorthand doesn't proxy
        // upgrades on its own.
        '/api': { target: 'http://localhost:8787', ws: true },
      },
    },
  };
});
