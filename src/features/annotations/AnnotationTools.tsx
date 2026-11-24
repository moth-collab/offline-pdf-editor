/* Creation gestures for annotation tools. */
import { useEffect, useRef, useState } from 'react';
import type { PageInfo } from '@shared/types';
import type { DocState } from '@/stores/documents';
import { askText } from '@/stores/prompt';
import { normRect, viewToPdf, type PageSlot } from '@/features/viewer/geometry';
import type { Point } from '@/types/editor';
import { addAnnot, toolDefaults } from './service';
import { tr } from '@/i18n';

export const MARKUP_TOOLS = new Set(['annot-highlight', 'annot-underline', 'annot-strikeout', 'annot-squiggly']);

export function isAnnotTool(tool: string): boolean {
  return tool.startsWith('annot-');
}

interface Props {
  doc: DocState;
  pageIndex: number;
  info: PageInfo;
  zoom: number;
  slot: PageSlot;
}

export function AnnotationToolLayer(props: Props) {
  if (MARKUP_TOOLS.has(props.doc.tool)) return <MarkupListener {...props} />;
  return <DrawLayer {...props} />;
}

/** Text markup: native text-layer selection gives live feedback; on release
 * the start/end points are sent to the engine which computes the quads. */
function MarkupListener({ doc, pageIndex, info, zoom }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const pageEl = ref.current?.parentElement;
    if (!pageEl) return;
    let start: Point | null = null;
    const local = (e: PointerEvent): Point => {
      const r = pageEl.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const down = (e: PointerEvent) => {
      if (e.button === 0) start = local(e);
    };
    const up = (e: PointerEvent) => {
      if (!start) return;
      const end = local(e);
      const a = start;
      start = null;
      if (Math.hypot(end[0] - a[0], end[1] - a[1]) < 4) return;
      const tool = doc.tool;
      const d = toolDefaults(tool);
      const type = tool.replace('annot-', '');
      window.getSelection()?.removeAllRanges();
      addAnnot(doc.id, pageIndex, {
        type,
        start: viewToPdf(info, zoom, ...a),
        stop: viewToPdf(info, zoom, ...end),
        stroke: d.stroke,
        opacity: d.opacity,
      });
    };
    pageEl.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    return () => {
      pageEl.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
    };
  }, [doc.id, doc.tool, pageIndex, info, zoom]);
  return <span ref={ref} hidden />;
}

function DrawLayer({ doc, pageIndex, info, zoom }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [band, setBand] = useState<{ a: Point; b: Point } | null>(null);
  const [ink, setInk] = useState<Point[] | null>(null);
  const tool = doc.tool;
  const d = toolDefaults(tool);
  const pt = (e: { clientX: number; clientY: number }): Point => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const pdf = (p: Point) => viewToPdf(info, zoom, ...p);

  const finish = async (a: Point, b: Point, shift: boolean) => {
    const dragged = Math.hypot(b[0] - a[0], b[1] - a[1]) > 5;
    const pa = pdf(a);
    let pb = pdf(b);
    if (shift && (tool === 'annot-line' || tool === 'annot-arrow')) {
      const ang = Math.round(Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      pb = [pa[0] + len * Math.cos(ang), pa[1] + len * Math.sin(ang)];
    }
    const rect = normRect([pa[0], pa[1], pb[0], pb[1]]);
    const common = { stroke: d.stroke, opacity: d.opacity };
    switch (tool) {
      case 'annot-note':
        await addAnnot(doc.id, pageIndex, { type: 'note', point: pa, contents: '', icon: d.icon, ...common });
        break;
      case 'annot-freetext': {
        const text = await askText({ title: tr("Text comment"), label: tr("Comment text"), okLabel: tr("Add") });
        if (!text) return;
        const r = dragged ? rect : [pa[0], pa[1] - 40, pa[0] + 200, pa[1]];
        await addAnnot(doc.id, pageIndex, { type: 'freetext', rect: r, contents: text, font_size: d.font_size, text_color: '#000000', fill: d.fill, border_width: d.border_width, stroke: d.border_width ? d.stroke : null, opacity: d.opacity });
        break;
      }
      case 'annot-callout': {
        const text = await askText({ title: tr("Callout"), message: tr("The arrow points to where you pressed the mouse."), label: tr("Callout text"), okLabel: tr("Add") });
        if (!text) return;
        const box = [pb[0], pb[1] - 18, pb[0] + 170, pb[1] + 18];
        const knee: Point = [pb[0] - 20, pb[1]];
        await addAnnot(doc.id, pageIndex, { type: 'callout', rect: box, contents: text, font_size: d.font_size, callout: [pa, knee, [pb[0], pb[1]]], ...common });
        break;
      }
      case 'annot-rect':
      case 'annot-circle':
        if (!dragged) return;
        await addAnnot(doc.id, pageIndex, { type: tool === 'annot-rect' ? 'rect' : 'circle', rect, border_width: d.border_width, fill: d.fill, ...common });
        break;
      case 'annot-line':
      case 'annot-arrow':
        if (!dragged) return;
        await addAnnot(doc.id, pageIndex, { type: tool === 'annot-line' ? 'line' : 'arrow', points: [pa, pb], border_width: d.border_width, ...common });
        break;
      case 'annot-stamp': {
        const w = 170;
        const h = 48;
        const r = dragged ? rect : [pa[0] - w / 2, pa[1] - h / 2, pa[0] + w / 2, pa[1] + h / 2];
        await addAnnot(doc.id, pageIndex, { type: 'stamp', rect: r, stamp: d.stamp, opacity: d.opacity });
        break;
      }
      case 'redact-area':
        if (!dragged) return;
        await addAnnot(doc.id, pageIndex, { type: 'redact', rect }, tr("Mark for redaction"));
        break;
    }
  };

  return (
    <div
      ref={ref}
      className="absolute inset-0 z-[5]"
      style={{ cursor: tool === 'annot-ink' ? 'crosshair' : tool === 'annot-note' || tool === 'annot-stamp' ? 'copy' : 'crosshair' }}
      data-testid={`annot-tool-${pageIndex}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        ref.current!.setPointerCapture(e.pointerId);
        const p = pt(e);
        if (tool === 'annot-ink') setInk([p]);
        else setBand({ a: p, b: p });
      }}
      onPointerMove={(e) => {
        if (ink) setInk([...ink, pt(e)]);
        else if (band) setBand({ a: band.a, b: pt(e) });
      }}
      onPointerUp={(e) => {
        if (ink) {
          const pts = ink;
          setInk(null);
          if (pts.length < 2) return;
          const simplified = pts.filter((p, i) => i === 0 || i === pts.length - 1 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1.5);
          addAnnot(doc.id, pageIndex, { type: 'ink', strokes: [simplified.map(pdf)], stroke: d.stroke, opacity: d.opacity, border_width: d.border_width });
          return;
        }
        if (!band) return;
        const { a } = band;
        setBand(null);
        finish(a, pt(e), e.shiftKey);
      }}
    >
      {ink && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <polyline points={ink.map((p) => p.join(',')).join(' ')} fill="none" stroke={d.stroke} strokeWidth={Math.max(1, d.border_width * zoom * 1.333)} strokeLinecap="round" strokeLinejoin="round" opacity={d.opacity} />
        </svg>
      )}
      {band && (tool === 'annot-line' || tool === 'annot-arrow' || tool === 'annot-callout' ? (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <line x1={band.a[0]} y1={band.a[1]} x2={band.b[0]} y2={band.b[1]} stroke={d.stroke} strokeWidth={1.5} strokeDasharray="4 3" />
        </svg>
      ) : (
        <div
          className={tool === 'redact-area' ? 'pointer-events-none absolute border-2 border-red-600 bg-black/30' : 'pointer-events-none absolute border border-dashed'}
          style={{ left: Math.min(band.a[0], band.b[0]), top: Math.min(band.a[1], band.b[1]), width: Math.abs(band.b[0] - band.a[0]), height: Math.abs(band.b[1] - band.a[1]), borderColor: tool === 'redact-area' ? undefined : d.stroke }}
        />
      ))}
    </div>
  );
}
