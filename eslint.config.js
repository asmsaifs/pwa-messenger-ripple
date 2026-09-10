import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

// Layering rules (docs/01 §5, docs/07 §1, CLAUDE.md hard rules 1-2):
// only src/server/repos/** may import drizzle or touch env.DB directly.
// This is the ESLint half of the "no-drizzle-outside-repos" guard; the CI grep
// in docs/07 §2 (route-must-import-policy) lands with the policy layer in M2.
const noDrizzleOutsideRepos = {
  name: 'drizzle-orm',
  message:
    'Only src/server/repos/** may import drizzle-orm or touch env.DB — see docs/01 §5.',
};

export default tseslint.config(
  {
    ignores: [
      'dist',
      '.wrangler',
      'node_modules',
      'coverage',
      'worker-configuration.d.ts',
      // Static assets served as-is by Static Assets/the PWA — not part of any
      // tsconfig project, so typescript-eslint's projectService can't parse them.
      'public/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Client (React)
  {
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-restricted-imports': ['error', { paths: [noDrizzleOutsideRepos] }],
    },
  },

  // Server / Durable Objects (Workers runtime) — drizzle allowed only under repos/
  {
    files: ['src/server/**/*.ts', 'src/durable/**/*.ts'],
    ignores: ['src/server/repos/**'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.worker,
    },
    rules: {
      'no-restricted-imports': ['error', { paths: [noDrizzleOutsideRepos] }],
    },
  },

  // Service worker (src/sw.ts) — its own global scope, not the client bundle
  // or the API Worker's.
  {
    files: ['src/sw.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.serviceworker,
    },
  },

  // Shared (isomorphic — no DOM, no Worker globals assumed)
  {
    files: ['src/shared/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
    },
  },

  // Config / tooling files run under Node, not typechecked against the app tsconfigs.
  // `disableTypeChecked` carries its own `languageOptions` key, so it must be
  // spread *before* this block's own `languageOptions` — spreading it after
  // (the original ordering here) silently discarded the `globals.node`
  // below, since object spread replaces a whole key rather than merging it.
  {
    files: ['*.config.{ts,js}', 'eslint.config.js', 'scripts/**/*.{js,mjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },

  {
    files: ['**/*.test.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // Playwright e2e specs/support (docs/07 §5-6) — Node process, Playwright's
  // own DOM-shaped fixtures (`page`), not this repo's client/worker globals.
  {
    files: ['e2e/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
