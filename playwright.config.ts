import { defineConfig, devices } from '@playwright/test';

// Shared with e2e/support/auth.ts, which tails this file for verification
// email links.
export const WRANGLER_LOG_FILE = '.e2e-wrangler.log';

// docs/07-TESTING.md §5/§6: Playwright, chromium, 2 browser contexts, run
// against `wrangler dev` (local D1/R2/DO) rather than a mocked backend — the
// same Worker that serves prod, with `--local` storage. `pretest:e2e`
// (package.json) builds the SPA and applies local D1 migrations first; this
// config only starts the already-built Worker and waits for it to answer
// `/api/health`.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // shared local D1/DO state — specs seed their own users, but don't race the server's boot
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8787',
    trace: 'retain-on-failure',
    // docs/07 §4: fake media devices so any WebRTC-adjacent permission
    // prompts in shared layouts don't block — not exercised until M11/M13,
    // harmless to set now.
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Tee stdout to a file: no mail-catcher service exists yet (docs/07 §5
    // E2E #1 describes one conceptually; M6 doesn't own building it), and
    // `sendVerificationEmail` just `console.log`s the link (src/server/lib/mail.ts)
    // — e2e/support/auth.ts polls this file to recover it instead.
    command: `sh -c "wrangler dev --port 8787 > ${WRANGLER_LOG_FILE} 2>&1"`,
    url: 'http://localhost:8787/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
