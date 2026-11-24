/**
 * Custom protocols.
 *
 *  app://bundle/...           renderer files (production build)
 *  appdoc://doc/<id>/<rev>    immutable working-copy revision of an open document
 *  appdoc://asset/<asset-id>  image assets inserted as overlay objects
 *
 * Both handlers only serve files from their dedicated folders (path traversal
 * is rejected) and support HTTP range requests so PDF.js can load large files
 * lazily.
 */
import { protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { appPaths } from './paths';

export const APP_ORIGIN = 'app://bundle';

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
    { scheme: 'appdoc', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.pdf': 'application/pdf',
};

function within(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && (origin === APP_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) ? origin : APP_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Cache-Control': 'no-store',
  };
}

function serveFile(file: string, req: Request, contentType: string): Response {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return notFound();
  }
  const headers: Record<string, string> = { ...corsHeaders(req.headers.get('origin')), 'Content-Type': contentType, 'Accept-Ranges': 'bytes' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const range = req.headers.get('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) return new Response('Bad range', { status: 416, headers });
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (!m[1] && m[2]) {
      start = Math.max(0, st.size - parseInt(m[2], 10));
      end = st.size - 1;
    }
    end = Math.min(end, st.size - 1);
    if (start > end || start >= st.size) return new Response('Bad range', { status: 416, headers: { ...headers, 'Content-Range': `bytes */${st.size}` } });
    const stream = fs.createReadStream(file, { start, end });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(st.size) } });
  const stream = fs.createReadStream(file);
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers: { ...headers, 'Content-Length': String(st.size) },
  });
}

export function registerProtocolHandlers(): void {
  const paths = appPaths();

  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    if (url.host !== 'bundle') return notFound();
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(paths.rendererDist, rel));
    if (!within(paths.rendererDist, file)) return notFound();
    const ext = path.extname(file).toLowerCase();
    const res = serveFile(file, req, MIME[ext] ?? 'application/octet-stream');
    if (ext === '.html') {
      res.headers.set(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: appdoc:",
          "font-src 'self' data:",
          "connect-src 'self' appdoc: data: blob:",
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
      );
    }
    return res;
  });

  protocol.handle('appdoc', (req) => {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.host === 'doc' && parts.length === 2) {
      const [docId, rev] = parts;
      if (!/^[0-9a-f]{32}$/.test(docId) || !/^\d{1,9}$/.test(rev)) return notFound();
      const file = path.join(paths.sessions, docId, `rev-${rev.padStart(6, '0')}.pdf`);
      if (!within(paths.sessions, file)) return notFound();
      return serveFile(file, req, 'application/pdf');
    }
    if (url.host === 'asset' && parts.length === 1) {
      const id = parts[0];
      const m = /^[0-9a-f]{40}\.(jpg|png|gif)$/.exec(id);
      if (!m) return notFound();
      const file = path.join(paths.assetsStore, id);
      if (!within(paths.assetsStore, file)) return notFound();
      return serveFile(file, req, MIME[`.${m[1]}`]);
    }
    return notFound();
  });
}
