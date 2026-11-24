import { describe, expect, it } from 'vitest';
import { extractKeys } from '../../scripts/i18n-extract.mjs';
import { TH } from '../../src/i18n/th';

describe('Thai UI catalogue', () => {
  const keys = extractKeys();

  it('translates every UI string found in the source', () => {
    const missing = keys.filter((k) => TH[k] === undefined);
    expect(missing).toEqual([]);
  });

  it('keeps placeholders consistent', () => {
    for (const [k, v] of Object.entries(TH)) {
      const inKey = new Set(k.match(/\{\d+\}/g) ?? []);
      for (const p of v.match(/\{\d+\}/g) ?? []) expect(inKey.has(p), `${k} → ${v}`).toBe(true);
    }
  });

  it('has no empty translations', () => {
    expect(Object.entries(TH).filter(([, v]) => !v.trim())).toEqual([]);
  });
});

describe('tr()', () => {
  it('falls back to English and formats placeholders', async () => {
    (globalThis as any).document = { documentElement: {} };
    const { tr, setLanguage } = await import('../../src/i18n/index');
    expect(tr('Open…')).toBe('Open…');
    expect(tr('Page {0}', 3)).toBe('Page 3');
    setLanguage('th');
    expect(tr('Open…')).toBe('เปิด…');
    expect(tr('Page {0}', 3)).toBe('หน้า 3');
    expect(tr('Some brand new string')).toBe('Some brand new string');
    setLanguage('en');
  });
});
