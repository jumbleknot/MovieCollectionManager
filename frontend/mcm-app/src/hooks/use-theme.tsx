/**
 * Device-local theme preference (feature 015 — design system).
 *
 * Dark is the default; users can switch to light; the choice is persisted
 * device-locally (AsyncStorage → localStorage on web, app storage on native).
 * No backend/profile involvement — this is UI state only.
 *
 * Implements FR-005 / SC-003 and the data-model Theme Preference + Contract 2.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemeName = 'dark' | 'light';

// Persisted external storage key — exempt from behavior-descriptive-identifier
// renaming (constitution: renaming would break the stored preference).
const THEME_STORAGE_KEY = 'mcm.theme';
const DEFAULT_THEME: ThemeName = 'dark';

function normalizeTheme(value: string | null): ThemeName {
  return value === 'light' ? 'light' : DEFAULT_THEME;
}

interface ThemeContextValue {
  theme: ThemeName;
  toggle: () => void;
  setTheme: (theme: ThemeName) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [theme, setThemeState] = useState<ThemeName>(DEFAULT_THEME);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(THEME_STORAGE_KEY)
      .then((stored) => {
        if (active) setThemeState(normalizeTheme(stored));
      })
      .catch(() => {
        /* unreadable storage → keep the dark default */
      });
    return () => {
      active = false;
    };
  }, []);

  const persist = useCallback((next: ThemeName) => {
    AsyncStorage.setItem(THEME_STORAGE_KEY, next).catch(() => {
      /* best-effort; in-memory state is still correct for this session */
    });
  }, []);

  const setTheme = useCallback(
    (next: ThemeName) => {
      setThemeState(next);
      persist(next);
    },
    [persist],
  );

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: ThemeName = prev === 'dark' ? 'light' : 'dark';
      persist(next);
      return next;
    });
  }, [persist]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, toggle, setTheme }),
    [theme, toggle, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
