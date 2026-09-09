import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

// https://vite.dev/config/
export default defineConfig({
  root: 'src/client',
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
      '/api': 'http://localhost:8787',
    },
  },
});
