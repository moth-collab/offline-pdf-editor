/* Thumbnail rendering with a content-addressed cache.
 * Cache key = page content id (see DocState.pageVersions): reordering pages
 * or undoing never re-renders unchanged pages. */
import { getPdf, isClosed } from '@/features/viewer/pdfjs';
import { scheduleRender } from '@/features/viewer/renderQueue';

const cache = new Map<string, string>(); // key -> object URL
const inflight = new Map<string, Promise<string>>();
const MAX_ENTRIES = 1500;

function key(docId: string, contentId: number, width: number) {
  return `${docId}:${contentId}:${width}`;
}

export function peekThumb(docId: string, contentId: number, width: number): string | undefined {
  return cache.get(key(docId, contentId, width));
}

export function getThumb(docId: string, revision: number, pageIndex: number, contentId: number, width: number, rotation: number): Promise<string> {
  const k = key(docId, contentId, width);
  const hit = cache.get(k);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(k);
  if (pending) return pending;
  const p = (async () => {
    let url = '';
    const job = scheduleRender(1000 + pageIndex / 1000, async () => {
      if (isClosed(docId)) return;
      const pdf = await getPdf(docId, revision);
      const page = await pdf.getPage(pageIndex + 1);
      const base = page.getViewport({ scale: 1, rotation });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (width * dpr) / base.width, rotation });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d', { alpha: false })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport } as any).promise;
      const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), 'image/png'));
      canvas.width = canvas.height = 0;
      url = URL.createObjectURL(blob);
    });
    await job.promise;
    if (!url) throw new Error('thumbnail cancelled');
    cache.set(k, url);
    if (cache.size > MAX_ENTRIES) {
      const first = cache.keys().next().value as string;
      URL.revokeObjectURL(cache.get(first)!);
      cache.delete(first);
    }
    return url;
  })();
  inflight.set(k, p);
  p.finally(() => inflight.delete(k));
  return p;
}

export function dropThumbs(docId: string) {
  for (const [k, url] of cache) {
    if (k.startsWith(`${docId}:`)) {
      URL.revokeObjectURL(url);
      cache.delete(k);
    }
  }
}
