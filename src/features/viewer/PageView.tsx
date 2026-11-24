/* One rendered page: canvas (double buffered), optional high-res detail tile,
 * PDF.js text layer, and the interactive feature layers. */
import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { PageInfo } from '@shared/types';
import { pdfjsLib } from './pdfjs';
import { MAX_CANVAS_PIXELS, scheduleRender } from './renderQueue';
import { scaleOf, type PageSlot } from './geometry';
import { useUi } from '@/stores/ui';
import { PageLayers } from './PageLayers';
import type { DocState } from '@/stores/documents';
import { tr } from '@/i18n';

interface Props {
  doc: DocState;
  pdf: PDFDocumentProxy | null;
  slot: PageSlot;
  info: PageInfo;
  zoom: number;
  priority: number;
  textLayer: boolean;
  /** visible region of this page in page-view px, for the detail tile */
  visibleRect: { x: number; y: number; w: number; h: number } | null;
  hiddenLayers: string[];
}

function qualityFactor(q: string): number {
  const dpr = window.devicePixelRatio || 1;
  if (q === 'standard') return Math.min(dpr, 1.5);
  if (q === 'maximum') return Math.max(dpr, 1) * 1.5;
  return Math.max(dpr, 1.25);
}

/** Render params for hidden layers; pdf.js needs a real config promise or none at all. */
function layerParams(pdf: PDFDocumentProxy, hidden: string[]): Record<string, unknown> {
  if (!hidden.length) return {};
  const promise = pdf.getOptionalContentConfig().then((cfg) => {
    for (const [id] of cfg) {
      if (hidden.includes(id)) cfg.setVisibility(id, false);
    }
    return cfg;
  });
  return { optionalContentConfigPromise: promise };
}

export const PageView = memo(function PageView({ doc, pdf, slot, info, zoom, priority, textLayer, visibleRect, hiddenLayers }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const quality = useUi((s) => s.settings.renderQuality);
  const contentId = doc.pageVersions[slot.index];
  const hiddenKey = hiddenLayers.join('|');

  // ---- base canvas ------------------------------------------------------------
  useEffect(() => {
    if (!pdf) return;
    let task: RenderTask | null = null;
    let disposed = false;
    const job = scheduleRender(priority, async () => {
      if (disposed) return;
      let page: PDFPageProxy;
      try {
        page = await pdf.getPage(slot.index + 1);
      } catch (e) {
        if (!disposed) setError(String(e));
        return;
      }
      if (disposed) return;
      const cssScale = scaleOf(zoom);
      let scale = cssScale * qualityFactor(quality);
      const base = page.getViewport({ scale: 1, rotation: info.rotation });
      const pixels = base.width * base.height * scale * scale;
      if (pixels > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
      const viewport = page.getViewport({ scale, rotation: info.rotation });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      task = page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        annotationMode: pdfjsLib.AnnotationMode.ENABLE,
        ...layerParams(pdf, hiddenLayers),
      } as any);
      try {
        await task.promise;
      } catch (e) {
        if ((e as Error)?.name !== 'RenderingCancelledException' && !disposed) setError(String(e));
        return;
      }
      if (disposed || !hostRef.current) {
        canvas.width = canvas.height = 0;
        return;
      }
      const host = hostRef.current;
      const old = host.querySelector('canvas');
      host.appendChild(canvas);
      if (old) {
        old.width = old.height = 0; // release GPU memory
        old.remove();
      }
      setRendered(true);
      setError(null);
    });
    return () => {
      disposed = true;
      job.cancel();
      task?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, slot.index, zoom, info.rotation, quality, contentId, hiddenKey]);

  // release canvases on unmount
  useEffect(
    () => () => {
      hostRef.current?.querySelectorAll('canvas').forEach((c) => {
        c.width = c.height = 0;
      });
    },
    [],
  );

  // ---- high resolution detail tile when the full page exceeds the canvas cap ----
  const needsDetail = (() => {
    const s = scaleOf(zoom) * qualityFactor(quality);
    return slot.width * slot.height * (s / scaleOf(zoom)) ** 2 > MAX_CANVAS_PIXELS;
  })();
  const vrKey = visibleRect ? `${Math.round(visibleRect.x / 64)}:${Math.round(visibleRect.y / 64)}:${Math.round(visibleRect.w / 64)}:${Math.round(visibleRect.h / 64)}` : '';
  useEffect(() => {
    const canvas = detailRef.current;
    if (!pdf || !canvas) return;
    if (!needsDetail || !visibleRect) {
      canvas.width = canvas.height = 0;
      canvas.style.display = 'none';
      return;
    }
    let task: RenderTask | null = null;
    let disposed = false;
    const timer = window.setTimeout(() => {
      const job = scheduleRender(priority - 0.5, async () => {
        const page = await pdf.getPage(slot.index + 1);
        if (disposed) return;
        const q = qualityFactor(quality);
        const viewport = page.getViewport({ scale: scaleOf(zoom) * q, rotation: info.rotation });
        const pad = 64;
        const x = Math.max(0, visibleRect.x - pad);
        const y = Math.max(0, visibleRect.y - pad);
        const w = Math.min(slot.width - x, visibleRect.w + pad * 2);
        const h = Math.min(slot.height - y, visibleRect.h + pad * 2);
        const off = document.createElement('canvas');
        off.width = Math.floor(w * q);
        off.height = Math.floor(h * q);
        const ctx = off.getContext('2d', { alpha: false })!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, off.width, off.height);
        task = page.render({
          canvas: off,
          canvasContext: ctx,
          viewport,
          transform: [1, 0, 0, 1, -x * q, -y * q],
          annotationMode: pdfjsLib.AnnotationMode.ENABLE,
          ...layerParams(pdf, hiddenLayers),
        } as any);
        try {
          await task.promise;
        } catch {
          return;
        }
        if (disposed) return;
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext('2d')!.drawImage(off, 0, 0);
        off.width = off.height = 0;
        Object.assign(canvas.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      });
      void job.promise;
    }, 120);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      task?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, needsDetail, vrKey, zoom, contentId, info.rotation, quality, hiddenKey]);

  // ---- text layer (selection / copy) ----------------------------------------------------
  useEffect(() => {
    const div = textRef.current;
    if (!pdf || !div || !textLayer) return;
    let layer: InstanceType<typeof pdfjsLib.TextLayer> | null = null;
    let disposed = false;
    (async () => {
      const page = await pdf.getPage(slot.index + 1);
      if (disposed) return;
      const viewport = page.getViewport({ scale: scaleOf(zoom), rotation: info.rotation });
      div.replaceChildren();
      div.style.setProperty('--total-scale-factor', String(scaleOf(zoom)));
      div.style.setProperty('--scale-round-x', '1px');
      div.style.setProperty('--scale-round-y', '1px');
      layer = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true }), container: div, viewport });
      try {
        await layer.render();
      } catch {
        /* cancelled */
      }
    })();
    return () => {
      disposed = true;
      layer?.cancel();
      div.replaceChildren();
    };
  }, [pdf, slot.index, zoom, info.rotation, textLayer, contentId]);

  return (
    <div
      className="absolute bg-white shadow-[0_1px_4px_rgba(0,0,0,0.25)]"
      style={{ top: slot.top, left: slot.left, width: slot.width, height: slot.height, overflow: 'clip', overflowClipMargin: '28px' } as React.CSSProperties}
      data-page-index={slot.index}
    >
      <div ref={hostRef} className="absolute inset-0 overflow-hidden" />
      <canvas ref={detailRef} className="pointer-events-none absolute" style={{ display: 'none' }} />
      {!rendered && !error && <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-400">{tr("Loading page")} {slot.index + 1}…</div>}
      {error && <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-red-600">{tr("This page could not be rendered:")} {error}</div>}
      <div ref={textRef} className="textLayer" style={{ display: textLayer ? undefined : 'none' }} />
      <PageLayers doc={doc} pageIndex={slot.index} info={info} zoom={zoom} slot={slot} />
    </div>
  );
});
