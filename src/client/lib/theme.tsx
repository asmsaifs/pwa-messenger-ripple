import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'ripple-theme';

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // localStorage unavailable (private mode / blocked) — fall through to system default.
  }
  return 'system';
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyResolvedTheme(preference: ThemePreference): void {
  const dark = preference === 'dark' || (preference === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

type ThemeContextValue = { preference: ThemePreference; setPreference: (p: ThemePreference) => void };
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

// Three-state (light/dark/system) toggle, persisted per-device — applies a
// `.dark` class on <html> that src/client/index.css's `@custom-variant dark`
// targets. Not synced across devices (a Settings preference, not account
// data) — matches docs/04's "Settings" scope, which lists this alongside
// per-device concerns like Audio devices and Storage.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);

  useEffect(() => {
    applyResolvedTheme(preference);
    if (preference !== 'system' || typeof matchMedia !== 'function') return undefined;
    const mql = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyResolvedTheme('system');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // best-effort — a lost preference just falls back to 'system' next load
    }
  }, []);

  const value = useMemo(() => ({ preference, setPreference }), [preference, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
