/* Virtualised PDF viewer: only pages near the viewport are mounted. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useDocuments, type DocState } from '@/stores/documents';
import { getPdf, onPdfLoaded, peekPdf } from './pdfjs';
import { clampZoom, computeLayout, firstVisibleSlot, fitZoom, rectToView } from './geometry';
import { PageView } from './PageView';
import { viewerBus } from './viewerBus';
import { cn } from '@/lib/utils';
import { tr } from '@/i18n';

function usePdfDocument(docId: string, revision: number): { pdf: PDFDocumentProxy | null; error: string | null } {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(() => peekPdf(docId)?.doc ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getPdf(docId, revision)
      .then((d) => {
        if (alive) {
          setPdf(d);
          setError(null);
        }
      })
      .catch((e) => alive && setError(String(e?.message ?? e)));
    const off = onPdfLoaded((id) => {
      if (id === docId) {
        const p = peekPdf(docId);
        if (p?.doc && p.revision === revision && alive) setPdf(p.doc);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [docId, revision]);
  return { pdf, error };
}

const TEXT_TOOLS = new Set(['select', 'annot-highlight', 'annot-underline', 'annot-strikeout', 'annot-squiggly']);

export function PdfViewer({ doc }: { doc: DocState }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 800 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const update = useDocuments((s) => s.update);
  const { pdf, error } = usePdfDocument(doc.id, doc.info.revision);
  const pages = doc.info.pages;
  const pan = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const anchor = useRef<{ page: number; fx: number; fy: number; px: number; py: number } | null>(null);

  // container size
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // fit modes
  useEffect(() => {
    if (doc.zoomMode === 'custom' || !pages.length) return;
    const z = fitZoom(pages, doc.zoomMode, size.w, size.h, doc.currentPage, doc.viewMode);
    if (Math.abs(z - doc.zoom) > 0.002) update(doc.id, { zoom: z });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.zoomMode, size.w, size.h, pages, doc.viewMode, doc.id]);

  const layout = useMemo(() => computeLayout(pages, doc.zoom, doc.viewMode, size.w, doc.currentPage), [pages, doc.zoom, doc.viewMode, size.w, doc.viewMode === 'single' ? doc.currentPage : 0]);

  // keep the point under the cursor stable when zooming
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    anchor.current = null;
    const slot = layout.slots.find((s) => s.index === a.page);
    if (!slot) return;
    el.scrollLeft = slot.left + a.fx * slot.width - a.px;
    el.scrollTop = slot.top + a.fy * slot.height - a.py;
  }, [layout]);

  const setZoomAround = useCallback(
    (z: number, clientX?: number, clientY?: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const px = clientX !== undefined ? clientX - rect.left : el.clientWidth / 2;
      const py = clientY !== undefined ? clientY - rect.top : el.clientHeight / 2;
      const y = el.scrollTop + py;
      const x = el.scrollLeft + px;
      const i = firstVisibleSlot(layout.slots, y);
      const slot = layout.slots[i];
      if (slot) anchor.current = { page: slot.index, fx: (x - slot.left) / slot.width, fy: (y - slot.top) / slot.height, px, py };
      update(doc.id, { zoom: clampZoom(z), zoomMode: 'custom' });
    },
    [layout, doc.id, update],
  );

  // ctrl + wheel zoom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0022);
      const cur = useDocuments.getState().docs[doc.id]?.zoom ?? 1;
      setZoomAround(cur * factor, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [doc.id, setZoomAround]);

  // scroll requests
  useEffect(
    () =>
      viewerBus.on((r) => {
        if (r.docId !== doc.id) return;
        const el = scrollRef.current;
        if (!el) return;
        const d = useDocuments.getState().docs[doc.id];
        if (d.viewMode === 'single') {
          update(doc.id, { currentPage: r.page });
          requestAnimationFrame(() => {
            if (r.rect) {
              const box = rectToView(pages[r.page], d.zoom, r.rect);
              el.scrollTo({ top: Math.max(0, box.top - el.clientHeight / 3), left: Math.max(0, box.left - 40) });
            } else el.scrollTo({ top: 0 });
          });
          return;
        }
        const slot = layout.slots.find((s) => s.index === r.page);
        if (!slot) return;
        let top = slot.top - 10;
        let left = el.scrollLeft;
        if (r.rect) {
          const box = rectToView(pages[r.page], d.zoom, r.rect);
          const absTop = slot.top + box.top;
          if (absTop > el.scrollTop + 40 && absTop + box.height < el.scrollTop + el.clientHeight - 40) return; // already visible
          top = absTop - el.clientHeight / 3;
          const absLeft = slot.left + box.left;
          if (absLeft < el.scrollLeft || absLeft + box.width > el.scrollLeft + el.clientWidth) left = absLeft - 40;
        }
        el.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior: r.smooth ? 'smooth' : 'auto' });
      }),
    [doc.id, layout, pages, update],
  );

  // scroll -> current page
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScroll({ top: el.scrollTop, left: el.scrollLeft });
    if (doc.viewMode === 'single') return;
    const probe = el.scrollTop + el.clientHeight * 0.3;
    const i = firstVisibleSlot(layout.slots, probe);
    const idx = layout.slots[i]?.index ?? 0;
    if (idx !== useDocuments.getState().docs[doc.id]?.currentPage) update(doc.id, { currentPage: idx });
  };

  // single page mode: wheel at the edge flips pages
  const onWheelSingle = (e: React.WheelEvent) => {
    if (doc.viewMode !== 'single' || e.ctrlKey) return;
    const el = scrollRef.current!;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    const atTop = el.scrollTop <= 0;
    if (e.deltaY > 0 && atBottom && doc.currentPage < pages.length - 1) {
      update(doc.id, { currentPage: doc.currentPage + 1 });
      el.scrollTop = 0;
    } else if (e.deltaY < 0 && atTop && doc.currentPage > 0) {
      update(doc.id, { currentPage: doc.currentPage - 1 });
      requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
    }
  };

  // hand tool panning
  const onPointerDown = (e: React.PointerEvent) => {
    // clicking outside objects clears the object selection
    const t = e.target as Element;
    if (doc.selection.kind === 'overlay' && doc.selection.ids.length && !t.closest('[data-overlay-id],[data-handle]')) {
      update(doc.id, { selection: { kind: 'none', ids: [] } });
    }
    if (doc.tool !== 'hand' && e.button !== 1) return;
    const el = scrollRef.current!;
    pan.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (!p) return;
    const el = scrollRef.current!;
    el.scrollLeft = p.sl - (e.clientX - p.x);
    el.scrollTop = p.st - (e.clientY - p.y);
  };
  const onPointerUp = () => {
    pan.current = null;
  };

  // which slots to mount
  const buffer = size.h * 1.0;
  const visTop = scroll.top - buffer;
  const visBottom = scroll.top + size.h + buffer;
  const first = firstVisibleSlot(layout.slots, visTop);
  const mounted = [];
  for (let i = first; i < layout.slots.length; i++) {
    const s = layout.slots[i];
    if (s.top > visBottom) break;
    mounted.push(s);
  }
  const textLayer = TEXT_TOOLS.has(doc.tool);
  const center = scroll.top + size.h / 2;

  return (
    <div
      ref={scrollRef}
      className={cn('relative h-full w-full overflow-auto bg-workspace', doc.tool === 'hand' && 'cursor-grab active:cursor-grabbing')}
      onScroll={onScroll}
      onWheel={onWheelSingle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      data-testid="pdf-viewer"
      tabIndex={-1}
    >
      {error && !pdf && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-destructive">{tr("Cannot display the document:")} {error}</div>
      )}
      <div className="relative" style={{ width: layout.totalWidth, height: layout.totalHeight }}>
        {mounted.map((slot) => {
          const vis = {
            x: Math.max(0, scroll.left - slot.left),
            y: Math.max(0, scroll.top - slot.top),
            w: Math.min(slot.width, scroll.left + size.w - slot.left) - Math.max(0, scroll.left - slot.left),
            h: Math.min(slot.height, scroll.top + size.h - slot.top) - Math.max(0, scroll.top - slot.top),
          };
          const isVisible = vis.w > 0 && vis.h > 0;
          return (
            <PageView
              key={`${slot.index}`}
              doc={doc}
              pdf={pdf}
              slot={slot}
              info={pages[slot.index]}
              zoom={doc.zoom}
              priority={Math.abs(slot.top + slot.height / 2 - center) / Math.max(1, size.h)}
              textLayer={textLayer}
              visibleRect={isVisible ? vis : null}
              hiddenLayers={doc.hiddenLayers}
            />
          );
        })}
      </div>
    </div>
  );
}
