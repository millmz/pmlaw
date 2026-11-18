import { useSyncExternalStore } from 'react';

/**
 * Display preferences — theme, text size, Hurricane mode. One small store,
 * kept in this browser, so the user menu and the Settings page are two
 * views of the same switches and a change in one shows in the other.
 */

export type Theme = 'light' | 'dark' | 'system';
export interface Prefs {
  theme: Theme;
  largeText: boolean;
  canes: boolean;
}

const read = (): Prefs => {
  const t = localStorage.getItem('pam-theme');
  return {
    theme: t === 'light' || t === 'dark' ? t : 'system',
    largeText: localStorage.getItem('pam-ts') === 'lg',
    canes: localStorage.getItem('pam-canes') === '1',
  };
};

let current: Prefs = read();
const subscribers = new Set<() => void>();

/** Stamp the preferences on the document; every stylesheet rule keys off these. */
export function applyPrefs(p: Prefs = current): void {
  const root = document.documentElement;
  if (p.theme === 'system') delete root.dataset['theme'];
  else root.dataset['theme'] = p.theme;
  root.dataset['ts'] = p.largeText ? 'lg' : '';
  document.body.dataset['ts'] = p.largeText ? 'lg' : '';
  document.body.dataset['canes'] = p.canes ? '1' : '';
}

export function setPrefs(patch: Partial<Prefs>): void {
  current = { ...current, ...patch };
  if (current.theme === 'system') localStorage.removeItem('pam-theme');
  else localStorage.setItem('pam-theme', current.theme);
  localStorage.setItem('pam-ts', current.largeText ? 'lg' : '');
  localStorage.setItem('pam-canes', current.canes ? '1' : '0');
  applyPrefs();
  subscribers.forEach((f) => f());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (f) => {
      subscribers.add(f);
      return () => subscribers.delete(f);
    },
    () => current,
  );
}
