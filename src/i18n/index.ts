/* Lightweight UI localisation.
 *
 * English source strings are the keys (gettext style): a missing translation
 * falls back to English, so the UI never shows raw keys. Placeholders use
 * {0}, {1}, … and are filled from the extra arguments.
 * The active language is read on every call, so a re-render after
 * `setLanguage` updates the whole UI (App re-mounts on language change). */
import { TH } from './th';

export type Language = 'en' | 'th';

let current: Language = 'en';
const listeners = new Set<(l: Language) => void>();

export function getLanguage(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  if (lang === current) return;
  current = lang;
  document.documentElement.lang = lang;
  listeners.forEach((l) => l(lang));
}

export function onLanguageChange(fn: (l: Language) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Best default for a first start: Thai when the OS/browser locale is Thai. */
export function detectLanguage(): Language {
  return (navigator.languages ?? [navigator.language]).some((l) => l?.toLowerCase().startsWith('th')) ? 'th' : 'en';
}

const format = (s: string, args: unknown[]) => (args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[+i] ?? '') : m)) : s);

/** Translate a UI string. Non-string input is returned unchanged. */
export function tr(key: string, ...args: unknown[]): string;
export function tr<T>(key: T): T;
export function tr(key: unknown, ...args: unknown[]): unknown {
  if (typeof key !== 'string') return key;
  if (current === 'th') {
    let hit = TH[key];
    // "Export…" can reuse the entry for "Export"
    if (hit === undefined && key.endsWith('…') && TH[key.slice(0, -1)] !== undefined) hit = TH[key.slice(0, -1)] + '…';
    if (hit !== undefined) return format(hit, args);
  }
  return format(key, args);
}
