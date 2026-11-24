/**
 * File access tokens.
 *
 * The renderer never handles raw filesystem paths for I/O. Paths are only
 * obtained through native dialogs, drag & drop (validated) or the recent
 * files list, and are exchanged for opaque tokens. Every backend operation
 * that touches the filesystem must present a token with the right mode.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FileRef } from '../../shared/types';

export type FileMode = 'read' | 'write' | 'dir';

interface Entry {
  path: string;
  mode: FileMode;
  created: number;
}

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const entries = new Map<string, Entry>();

export const PDF_EXT = ['.pdf'];
export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp'];

export function issue(p: string, mode: FileMode): FileRef {
  const token = randomBytes(18).toString('hex');
  const abs = path.resolve(p);
  entries.set(token, { path: abs, mode, created: Date.now() });
  let size: number | undefined;
  try {
    size = mode === 'read' ? fs.statSync(abs).size : undefined;
  } catch {
    size = undefined;
  }
  return { token, name: path.basename(abs), path: abs, size };
}

export function resolve(token: unknown, mode: FileMode): string {
  if (typeof token !== 'string' || !/^[0-9a-f]{36}$/.test(token)) {
    throw new Error('Invalid file token');
  }
  const e = entries.get(token);
  if (!e || Date.now() - e.created > TOKEN_TTL_MS) throw new Error('Unknown or expired file token');
  if (e.mode !== mode && !(mode === 'read' && e.mode === 'write' && fs.existsSync(e.path))) {
    throw new Error(`File token does not allow ${mode} access`);
  }
  return e.path;
}

export function hasMagic(p: string, kind: 'pdf' | 'image'): boolean {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n);
    if (kind === 'pdf') return head.includes(Buffer.from('%PDF-'));
    const sig = head.subarray(0, 12);
    return (
      sig.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || // png
      (sig[0] === 0xff && sig[1] === 0xd8) || // jpeg
      sig.subarray(0, 3).toString('latin1') === 'GIF' ||
      sig.subarray(0, 2).toString('latin1') === 'BM' ||
      sig.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || // tiff LE
      sig.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])) || // tiff BE
      (sig.subarray(0, 4).toString('latin1') === 'RIFF' && sig.subarray(8, 12).toString('latin1') === 'WEBP')
    );
  } catch {
    return false;
  }
}

/** Validate a path supplied via drag & drop / OS "open with". */
export function validateDropped(p: string): FileRef | null {
  if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) return null;
  const abs = path.resolve(p);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size === 0 || st.size > 4 * 1024 * 1024 * 1024) return null;
  const ext = path.extname(abs).toLowerCase();
  if (PDF_EXT.includes(ext) && hasMagic(abs, 'pdf')) return issue(abs, 'read');
  if (IMAGE_EXT.includes(ext) && hasMagic(abs, 'image')) return issue(abs, 'read');
  return null;
}

export function purgeExpired(): void {
  const now = Date.now();
  for (const [k, e] of entries) if (now - e.created > TOKEN_TTL_MS) entries.delete(k);
}
