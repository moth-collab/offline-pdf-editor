import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function uid(prefix = 'o'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Parse "1-3, 5, 8-10" (1-based) into sorted 0-based unique indices. */
export function parsePageRanges(input: string, pageCount: number): number[] | null {
  const out = new Set<number>();
  const parts = input
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) return null;
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (a < 1 || b < 1 || a > pageCount || b > pageCount) return null;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

export function formatRanges(pages: number[]): string {
  const s = [...new Set(pages)].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i] + 1}` : `${s[i] + 1}-${s[j] + 1}`);
    i = j + 1;
  }
  return out.join(', ');
}

export function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}
