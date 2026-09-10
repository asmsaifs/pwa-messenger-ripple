import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
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
export default defineConfig({
  root: 'src/client',
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
});
