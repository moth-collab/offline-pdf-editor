/* PDF.js setup: local worker + assets (no CDN), range based loading of large
 * documents, and a per-document cache of loaded revisions. */
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { bridge } from '@/lib/api';
import { tr } from '@/i18n';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjsLib };
export type { PDFDocumentProxy };

const base = () => new URL('./', document.baseURI).href;
const assetUrls = () => ({
  cMapUrl: `${base()}pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${base()}pdfjs/standard_fonts/`,
  wasmUrl: `${base()}pdfjs/wasm/`,
  iccUrl: `${base()}pdfjs/iccs/`,
});

const FIRST_CHUNK = 1024 * 1024; // 1 MB
const RANGE_CHUNK = 256 * 1024;

async function fetchRange(url: string, begin: number, endInclusive: number): Promise<{ data: Uint8Array; total: number }> {
  const res = await fetch(url, { headers: { Range: `bytes=${begin}-${endInclusive}` } });
  if (!res.ok && res.status !== 206) throw new Error(tr("Cannot read document data ({0})", res.status));
  const buf = new Uint8Array(await res.arrayBuffer());
  const cr = res.headers.get('Content-Range');
  const total = cr ? parseInt(cr.split('/')[1], 10) : buf.length;
  return { data: buf, total };
}

type LoadingTask = ReturnType<typeof pdfjsLib.getDocument>;

/** Load one revision of a document through the appdoc:// protocol. */
export async function loadRevision(docId: string, revision: number): Promise<LoadingTask> {
  const url = bridge().docUrl(docId, revision);
  const first = await fetchRange(url, 0, FIRST_CHUNK - 1);
  const common = {
    ...assetUrls(),
    isEvalSupported: false,
    enableXfa: false,
    useSystemFonts: false,
    fontExtraProperties: false,
  };
  if (first.total <= first.data.length) {
    return pdfjsLib.getDocument({ ...common, data: first.data });
  }
  const transport = new pdfjsLib.PDFDataRangeTransport(first.total, first.data);
  transport.requestDataRange = (begin: number, end: number) => {
    fetchRange(url, begin, end - 1)
      .then(({ data }) => transport.onDataRange(begin, data))
      .catch((e) => console.error('range request failed', e));
  };
  return pdfjsLib.getDocument({
    ...common,
    range: transport,
    rangeChunkSize: RANGE_CHUNK,
    disableAutoFetch: true,
    disableStream: true,
  });
}

interface CacheEntry {
  revision: number;
  promise: Promise<PDFDocumentProxy>;
  doc?: PDFDocumentProxy;
  task?: LoadingTask;
}

const cache = new Map<string, CacheEntry>();
const listeners = new Set<(docId: string) => void>();
/** documents that were closed: late render/thumbnail jobs must not reload them */
const closed = new Set<string>();

export function isClosed(docId: string): boolean {
  return closed.has(docId);
}

/** Get (and load if needed) the PDF.js document for the given revision. */
export function getPdf(docId: string, revision: number): Promise<PDFDocumentProxy> {
  if (closed.has(docId)) return Promise.reject(new Error(tr("Document is closed")));
  const cur = cache.get(docId);
  if (cur && cur.revision === revision) return cur.promise;
  const entry: CacheEntry = { revision, promise: null as unknown as Promise<PDFDocumentProxy> };
  const promise = loadRevision(docId, revision).then((task) => {
    entry.task = task;
    return task.promise;
  });
  entry.promise = promise;
  cache.set(docId, entry);
  promise
    .then((doc) => {
      entry.doc = doc;
      // destroy the previous revision once the new one is ready
      if (cur?.task && cur !== entry) setTimeout(() => cur.task?.destroy(), 1500);
      listeners.forEach((l) => l(docId));
    })
    .catch(() => {
      if (cache.get(docId) === entry) cache.delete(docId);
    });
  return promise;
}

export function peekPdf(docId: string): { revision: number; doc?: PDFDocumentProxy } | undefined {
  const e = cache.get(docId);
  return e ? { revision: e.revision, doc: e.doc } : undefined;
}

export function releasePdf(docId: string): void {
  closed.add(docId);
  const e = cache.get(docId);
  cache.delete(docId);
  e?.promise.then(() => e.task?.destroy()).catch(() => undefined);
}

export function onPdfLoaded(l: (docId: string) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
