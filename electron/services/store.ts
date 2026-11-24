/** Local JSON persistence for settings and recent files (userData folder). */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type AppSettings, type RecentFile } from '../../shared/types';

function filePath(name: string): string {
  return path.join(app.getPath('userData'), name);
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, data: unknown): void {
  const p = filePath(name);
  const tmp = `${p}.tmp`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf-8');
  fs.renameSync(tmp, p);
}

let settingsCache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (!settingsCache) {
    const stored = readJson<Partial<AppSettings> | null>('settings.json', null);
    // first start: follow the Windows display language (Thai or English)
    const language = stored?.language ?? (app.getLocale().toLowerCase().startsWith('th') ? 'th' : 'en');
    settingsCache = { ...DEFAULT_SETTINGS, ...(stored ?? {}), language };
  }
  return settingsCache;
}

const SETTING_VALIDATORS: { [K in keyof AppSettings]: (v: unknown) => boolean } = {
  language: (v) => v === 'en' || v === 'th',
  theme: (v) => v === 'light' || v === 'dark' || v === 'system',
  defaultSaveDir: (v) => typeof v === 'string' && v.length < 4096,
  recentLimit: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 50,
  autosaveEnabled: (v) => typeof v === 'boolean',
  autosaveIntervalSec: (v) => Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 3600,
  makeBackups: (v) => typeof v === 'boolean',
  defaultFont: (v) => typeof v === 'string' && v.length < 200,
  defaultFontSize: (v) => typeof v === 'number' && v >= 1 && v <= 500,
  defaultTextColor: (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v),
  defaultEditMode: (v) => ['select', 'hand', 'direct-text', 'add-text'].includes(v as string),
  renderQuality: (v) => ['standard', 'high', 'maximum'].includes(v as string),
  cacheSizeMB: (v) => Number.isInteger(v) && (v as number) >= 32 && (v as number) <= 4096,
  maxRevisions: (v) => Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 500,
  cleanupTempOnExit: (v) => typeof v === 'boolean',
  recoveryRetentionDays: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 90,
  ocrLanguage: (v) => typeof v === 'string' && /^[a-z_+]{3,40}$/.test(v),
  ocrDpi: (v) => Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 600,
  confirmExternalLinks: (v) => typeof v === 'boolean',
  authorName: (v) => typeof v === 'string' && v.length <= 200,
};

export function setSettings(patch: Record<string, unknown>): AppSettings {
  const current = { ...getSettings() } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch ?? {})) {
    const validate = SETTING_VALIDATORS[k as keyof AppSettings];
    if (validate && validate(v)) current[k] = v;
  }
  settingsCache = current as unknown as AppSettings;
  writeJson('settings.json', settingsCache);
  return settingsCache;
}

export function getRecent(): RecentFile[] {
  const list = readJson<RecentFile[]>('recent.json', []);
  return Array.isArray(list) ? list.filter((r) => r && typeof r.path === 'string') : [];
}

export function addRecent(p: string): void {
  const limit = getSettings().recentLimit;
  if (limit === 0) return;
  const list = getRecent().filter((r) => r.path !== p);
  list.unshift({ path: p, name: path.basename(p), openedAt: Date.now() });
  writeJson('recent.json', list.slice(0, limit));
}

export function removeRecent(p: string): void {
  writeJson(
    'recent.json',
    getRecent().filter((r) => r.path !== p),
  );
}

export function clearRecent(): void {
  writeJson('recent.json', []);
}
