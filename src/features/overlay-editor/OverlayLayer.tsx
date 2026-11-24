/* Interactive overlay objects for one page. */
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { PageInfo } from '@shared/types';
import { bridge } from '@/lib/api';
import { useDocuments, type DocState } from '@/stores/documents';
import { commitOverlays, setOverlaysTransient } from '@/services/docService';
import type { ImageOverlay, LineOverlay, OverlayObject, Point, TextOverlay } from '@/types/editor';
import { normRotation, objectFrame, pdfToView, rotatePoint, scaleOf, viewDeltaToPdf, viewToPdf, type PageSlot } from '@/features/viewer/geometry';
import { bboxOf, center, neededTextHeight, rotatedBounds, size, snapMove, textCss, translate, type Guide } from './model';
import { tr } from '@/i18n';

export const OVERLAY_INTERACTIVE = new Set(['select', 'edit-objects', 'add-text', 'edit-images', 'add-image', 'add-link']);

interface OverlayUi {
  editingId: string | null;
  /** overlay list before the current text edit started (history "before") */
  editBefore: OverlayObject[] | null;
  guides: { page: number; guides: Guide[] } | null;
  setEditing: (id: string | null, before?: OverlayObject[] | null) => void;
  setGuides: (g: OverlayUi['guides']) => void;
}

export const useOverlayUi = create<OverlayUi>((set) => ({
  editingId: null,
  editBefore: null,
  guides: null,
  setEditing: (editingId, before = null) => set({ editingId, editBefore: editingId ? before : null }),
  setGuides: (guides) => set({ guides }),
}));

interface Props {
  doc: DocState;
  pageIndex: number;
  info: PageInfo;
  zoom: number;
  slot: PageSlot;
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: { id: Handle; x: number; y: number; cursor: string }[] = [
  { id: 'nw', x: -0.5, y: -0.5, cursor: 'nwse-resize' },
  { id: 'n', x: 0, y: -0.5, cursor: 'ns-resize' },
  { id: 'ne', x: 0.5, y: -0.5, cursor: 'nesw-resize' },
  { id: 'e', x: 0.5, y: 0, cursor: 'ew-resize' },
  { id: 'se', x: 0.5, y: 0.5, cursor: 'nwse-resize' },
  { id: 's', x: 0, y: 0.5, cursor: 'ns-resize' },
  { id: 'sw', x: -0.5, y: 0.5, cursor: 'nesw-resize' },
  { id: 'w', x: -0.5, y: 0, cursor: 'ew-resize' },
];

type Drag =
  | { mode: 'move'; start: Point; before: OverlayObject[]; ids: string[]; moved: boolean }
  | { mode: 'resize'; handle: Handle; before: OverlayObject[]; id: string; shift: boolean }
  | { mode: 'rotate'; before: OverlayObject[]; id: string }
  | { mode: 'point'; index: 0 | 1; before: OverlayObject[]; id: string };

export function OverlayLayer({ doc, pageIndex, info, zoom }: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const editingId = useOverlayUi((s) => s.editingId);
  const guides = useOverlayUi((s) => (s.guides?.page === pageIndex ? s.guides.guides : null));
  const update = useDocuments((s) => s.update);
  const objs = doc.overlays.filter((o) => o.page === pageIndex);
  const interactive = OVERLAY_INTERACTIVE.has(doc.tool) && doc.info.owner_authenticated !== false;
  const selected = new Set(doc.selection.kind === 'overlay' ? doc.selection.ids : []);
  const s = scaleOf(zoom);
  if (!objs.length && !guides) return null;

  const localPoint = (e: { clientX: number; clientY: number }): Point => {
    const r = layerRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const current = () => useDocuments.getState().docs[doc.id];

  const select = (id: string, additive: boolean) => {
    const cur = current();
    const ids = cur.selection.kind === 'overlay' ? cur.selection.ids : [];
    const next = additive ? (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]) : ids.includes(id) ? ids : [id];
    update(doc.id, { selection: { kind: 'overlay', ids: next, page: pageIndex } });
    return next;
  };

  const begin = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation();
    e.preventDefault();
    drag.current = d;
    layerRef.current!.setPointerCapture(e.pointerId);
  };

  const onObjectDown = (e: React.PointerEvent, o: OverlayObject) => {
    if (!interactive || e.button !== 0 || editingId === o.id) return;
    if (o.locked) {
      select(o.id, e.shiftKey || e.ctrlKey);
      e.stopPropagation();
      return;
    }
    const ids = select(o.id, e.shiftKey || e.ctrlKey);
    begin(e, { mode: 'move', start: localPoint(e), before: current().overlays, ids, moved: false });
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = localPoint(e);
    const cur = current();
    if (d.mode === 'move') {
      const [dx0, dy0] = viewDeltaToPdf(info, zoom, p[0] - d.start[0], p[1] - d.start[1]);
      if (!d.moved && Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) < 3) return;
      d.moved = true;
      const ids = new Set(d.ids);
      const moving = d.before.filter((o) => ids.has(o.id));
      const bounds = bboxOf(moving.flatMap((o) => {
        const b = rotatedBounds(translate(o, dx0, dy0));
        return [[b[0], b[1]] as Point, [b[2], b[3]] as Point];
      }));
      const others = d.before.filter((o) => o.page === pageIndex && !ids.has(o.id)).map(rotatedBounds);
      const snap = e.altKey ? { dx: 0, dy: 0, guides: [] } : snapMove(bounds, others, info, 6 / s);
      setOverlaysTransient(doc.id, d.before.map((o) => (ids.has(o.id) ? translate(o, dx0 + snap.dx, dy0 + snap.dy) : o)));
      useOverlayUi.getState().setGuides(snap.guides.length ? { page: pageIndex, guides: snap.guides } : null);
      return;
    }
    const orig = d.before.find((o) => o.id === d.id);
    if (!orig) return;
    if (d.mode === 'point' && (orig.kind === 'line' || orig.kind === 'arrow')) {
      let pt = viewToPdf(info, zoom, p[0], p[1]);
      const other = orig.points[d.index === 0 ? 1 : 0];
      if (e.shiftKey) {
        // constrain to 45° steps
        const ang = Math.round(Math.atan2(pt[1] - other[1], pt[0] - other[0]) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(pt[0] - other[0], pt[1] - other[1]);
        pt = [other[0] + len * Math.cos(ang), other[1] + len * Math.sin(ang)];
      }
      const points: [Point, Point] = d.index === 0 ? [pt, other] : [other, pt];
      setOverlaysTransient(doc.id, cur.overlays.map((o) => (o.id === d.id ? ({ ...o, points, rect: bboxOf(points) } as LineOverlay) : o)));
      return;
    }
    const f = objectFrame(info, zoom, orig.rect, orig.rotation);
    if (d.mode === 'rotate') {
      let ang = (Math.atan2(p[1] - f.cy, p[0] - f.cx) * 180) / Math.PI + 90;
      ang -= normRotation(info.rotation);
      if (e.shiftKey) ang = Math.round(ang / 15) * 15;
      else for (const t of [0, 90, 180, 270, 360]) if (Math.abs(((ang % 360) + 360) % 360 - t) < 3) ang = t;
      ang = ((ang % 360) + 360) % 360;
      setOverlaysTransient(doc.id, cur.overlays.map((o) => (o.id === d.id ? { ...o, rotation: Math.round(ang * 10) / 10 } : o)));
      return;
    }
    if (d.mode === 'resize') {
      const [lx, ly] = rotatePoint(p[0], p[1], f.cx, f.cy, -f.angle).map((v, i) => v - (i === 0 ? f.cx : f.cy));
      let l = -f.w / 2;
      let r = f.w / 2;
      let t = -f.h / 2;
      let b = f.h / 2;
      const h = d.handle;
      if (h.includes('w')) l = Math.min(lx, r - 4);
      if (h.includes('e')) r = Math.max(lx, l + 4);
      if (h.includes('n')) t = Math.min(ly, b - 4);
      if (h.includes('s')) b = Math.max(ly, t + 4);
      const corner = h.length === 2;
      const keepAspect = corner && (orig.kind === 'image' ? !e.shiftKey : e.shiftKey);
      if (keepAspect && f.w > 0 && f.h > 0) {
        const ratio = f.w / f.h;
        const nw = r - l;
        const nh = b - t;
        if (nw / nh > ratio) {
          const w2 = nh * ratio;
          if (h.includes('w')) l = r - w2;
          else r = l + w2;
        } else {
          const h2 = nw / ratio;
          if (h.includes('n')) t = b - h2;
          else b = t + h2;
        }
      }
      const lc: Point = [(l + r) / 2, (t + b) / 2];
      const [vcx, vcy] = rotatePoint(f.cx + lc[0], f.cy + lc[1], f.cx, f.cy, f.angle);
      const [pcx, pcy] = viewToPdf(info, zoom, vcx, vcy);
      const wPt = (r - l) / s;
      const hPt = (b - t) / s;
      // page rotation 90/270: the object's local width runs along the page x axis already (see objectFrame)
      setOverlaysTransient(doc.id, cur.overlays.map((o) => (o.id === d.id ? ({ ...o, rect: [pcx - wPt / 2, pcy - hPt / 2, pcx + wPt / 2, pcy + hPt / 2] } as OverlayObject) : o)));
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    useOverlayUi.getState().setGuides(null);
    if (!d) return;
    const after = current().overlays;
    if (after === d.before || (d.mode === 'move' && !d.moved)) return;
    const label = d.mode === 'move' ? tr('Move object') : d.mode === 'rotate' ? tr('Rotate object') : tr('Resize object');
    commitOverlays(doc.id, label, after, d.before);
  };

  const lines = objs.filter((o): o is LineOverlay => o.kind === 'line' || o.kind === 'arrow');
  return (
    <div
      ref={layerRef}
      className="absolute inset-0 z-[6]"
      style={{ pointerEvents: drag.current ? 'auto' : 'none' }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {/* lines & arrows */}
      {lines.length > 0 && (
        <svg className="absolute inset-0 h-full w-full overflow-visible" style={{ pointerEvents: 'none' }}>
          <defs>
            {lines.map((o) => (
              <marker key={o.id} id={`ah-${o.id}`} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse" viewBox="0 0 10 10">
                <path d="M0,0 L10,5 L0,10 z" fill={o.stroke} />
              </marker>
            ))}
          </defs>
          {lines.map((o) => {
            const a = pdfToView(info, zoom, ...o.points[0]);
            const b = pdfToView(info, zoom, ...o.points[1]);
            const sw = Math.max(1, o.strokeWidth * s);
            return (
              <g key={o.id} opacity={o.opacity}>
                <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={o.stroke} strokeWidth={sw} strokeDasharray={o.dash?.map((v) => v * s).join(' ')} strokeLinecap="round"
                  markerEnd={o.kind === 'arrow' ? `url(#ah-${o.id})` : undefined} />
                <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="transparent" strokeWidth={Math.max(10, sw + 8)}
                  style={{ pointerEvents: interactive ? 'stroke' : 'none', cursor: 'move' }} data-overlay-id={o.id}
                  onPointerDown={(e) => onObjectDown(e as unknown as React.PointerEvent, o)} />
              </g>
            );
          })}
        </svg>
      )}

      {objs.map((o) => {
        if (o.kind === 'line' || o.kind === 'arrow') return null;
        const f = objectFrame(info, zoom, o.rect, o.rotation);
        const isSel = selected.has(o.id);
        return (
          <div
            key={o.id}
            data-overlay-id={o.id}
            className="absolute"
            style={{
              left: f.cx - f.w / 2,
              top: f.cy - f.h / 2,
              width: f.w,
              height: f.h,
              transform: `rotate(${f.angle}deg)`,
              pointerEvents: interactive ? 'auto' : 'none',
              cursor: interactive ? (o.locked ? 'default' : 'move') : undefined,
              outline: isSel ? '1px solid var(--selection)' : interactive && o.kind === 'text' && !o.text ? '1px dashed #94a3b8' : undefined,
            }}
            onPointerDown={(e) => onObjectDown(e, o)}
            onDoubleClick={(e) => {
              if (!interactive || o.kind !== 'text' || o.locked) return;
              e.stopPropagation();
              useOverlayUi.getState().setEditing(o.id, useDocuments.getState().docs[doc.id].overlays);
            }}
          >
            <ObjectBody o={o} scale={s} editing={editingId === o.id} docId={doc.id} interactive={interactive} />
          </div>
        );
      })}

      {/* selection handles (single selection) */}
      {interactive && selected.size === 1 && objs.filter((o) => selected.has(o.id) && !o.locked && editingId !== o.id).map((o) => {
        if (o.kind === 'line' || o.kind === 'arrow') {
          return o.points.map((pt, i) => {
            const v = pdfToView(info, zoom, ...pt);
            return (
              <div key={`${o.id}-${i}`} data-handle className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--selection)] bg-white"
                style={{ left: v[0], top: v[1], pointerEvents: 'auto', cursor: 'crosshair' }}
                onPointerDown={(e) => begin(e, { mode: 'point', index: i as 0 | 1, before: current().overlays, id: o.id })} />
            );
          });
        }
        const f = objectFrame(info, zoom, o.rect, o.rotation);
        return (
          <div key={`h-${o.id}`} className="absolute" style={{ left: f.cx - f.w / 2, top: f.cy - f.h / 2, width: f.w, height: f.h, transform: `rotate(${f.angle}deg)`, pointerEvents: 'none' }}>
            {HANDLES.map((h) => (
              <div key={h.id} data-handle className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 border border-[var(--selection)] bg-white"
                style={{ left: `${(h.x + 0.5) * 100}%`, top: `${(h.y + 0.5) * 100}%`, cursor: h.cursor, pointerEvents: 'auto' }}
                onPointerDown={(e) => begin(e, { mode: 'resize', handle: h.id, before: current().overlays, id: o.id, shift: e.shiftKey })} />
            ))}
            {o.kind !== 'link' && (
              <>
                <div className="absolute left-1/2 top-[-22px] h-[16px] w-px bg-[var(--selection)]" />
                <div data-handle title={tr("Rotate (Shift: 15° steps)")} className="absolute left-1/2 top-[-28px] h-3 w-3 -translate-x-1/2 rounded-full border border-[var(--selection)] bg-white"
                  style={{ cursor: 'grab', pointerEvents: 'auto' }}
                  onPointerDown={(e) => begin(e, { mode: 'rotate', before: current().overlays, id: o.id })} />
              </>
            )}
          </div>
        );
      })}

      {guides?.map((g, i) => {
        if (g.axis === 'x') {
          const v = pdfToView(info, zoom, g.value, info.cropbox[1]);
          const v2 = pdfToView(info, zoom, g.value, info.cropbox[3]);
          return <div key={i} className="absolute bg-fuchsia-500" style={{ left: Math.min(v[0], v2[0]), top: Math.min(v[1], v2[1]), width: Math.max(1, Math.abs(v2[0] - v[0])), height: Math.max(1, Math.abs(v2[1] - v[1])) }} />;
        }
        const v = pdfToView(info, zoom, info.cropbox[0], g.value);
        const v2 = pdfToView(info, zoom, info.cropbox[2], g.value);
        return <div key={i} className="absolute bg-fuchsia-500" style={{ left: Math.min(v[0], v2[0]), top: Math.min(v[1], v2[1]), width: Math.max(1, Math.abs(v2[0] - v[0])), height: Math.max(1, Math.abs(v2[1] - v[1])) }} />;
      })}
    </div>
  );
}

function ObjectBody({ o, scale, editing, docId, interactive }: { o: OverlayObject; scale: number; editing: boolean; docId: string; interactive: boolean }) {
  if (o.kind === 'text') return <TextBody o={o} scale={scale} editing={editing} docId={docId} />;
  if (o.kind === 'image') return <ImageBody o={o} scale={scale} />;
  if (o.kind === 'link')
    return <div className="h-full w-full" style={{ border: interactive ? '1px dashed #2563eb' : undefined, background: interactive ? 'rgba(37,99,235,0.08)' : undefined }} title={o.target.type === 'url' ? o.target.url : tr("Page {0}", o.target.page + 1)} />;
  if (o.kind === 'rect' || o.kind === 'ellipse') {
    const sw = o.strokeWidth * scale;
    return (
      <svg className="h-full w-full overflow-visible" style={{ opacity: o.opacity }}>
        {o.kind === 'rect' ? (
          <rect x={sw / 2} y={sw / 2} style={{ width: `calc(100% - ${sw}px)`, height: `calc(100% - ${sw}px)` }}
            fill={o.fill ?? 'none'} fillOpacity={o.fillOpacity} stroke={o.strokeWidth > 0 ? o.stroke ?? 'none' : 'none'} strokeWidth={sw} strokeDasharray={o.dash?.map((v) => v * scale).join(' ')} />
        ) : (
          <ellipse cx="50%" cy="50%" style={{ rx: `calc(50% - ${sw / 2}px)`, ry: `calc(50% - ${sw / 2}px)` } as React.CSSProperties}
            fill={o.fill ?? 'none'} fillOpacity={o.fillOpacity} stroke={o.strokeWidth > 0 ? o.stroke ?? 'none' : 'none'} strokeWidth={sw} strokeDasharray={o.dash?.map((v) => v * scale).join(' ')} />
        )}
      </svg>
    );
  }
  return null;
}

function TextBody({ o, scale, editing, docId }: { o: TextOverlay; scale: number; editing: boolean; docId: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const css = textCss(o, scale);
  const box: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    background: o.background ?? 'transparent',
    border: o.borderColor && o.borderWidth > 0 ? `${o.borderWidth * scale}px solid ${o.borderColor}` : undefined,
    opacity: o.opacity,
    boxSizing: 'border-box',
  };
  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(o.text.length, o.text.length);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  if (!editing) {
    return (
      <div style={box}>
        <div style={{ ...css, width: '100%', height: '100%', boxSizing: 'border-box', border: undefined }}>{o.text}</div>
      </div>
    );
  }
  const finish = () => {
    const before = useOverlayUi.getState().editBefore;
    useOverlayUi.getState().setEditing(null);
    const doc = useDocuments.getState().docs[docId];
    const cur = doc.overlays.find((x) => x.id === o.id) as TextOverlay | undefined;
    if (!cur || !before) return;
    const prev = before.find((x) => x.id === o.id) as TextOverlay | undefined;
    if (!cur.text.trim()) {
      // an empty box is removed; a box that was just created leaves no history entry
      const next = doc.overlays.filter((x) => x.id !== o.id);
      if (prev && prev.text.trim()) commitOverlays(docId, tr("Delete text box"), next, before);
      else setOverlaysTransient(docId, next);
      useDocuments.getState().update(docId, { selection: { kind: 'none', ids: [] } });
      return;
    }
    if (!prev || prev.text !== cur.text || prev.rect !== cur.rect) commitOverlays(docId, prev ? tr("Edit text") : tr("Add text"), doc.overlays, before);
  };
  return (
    <div style={box}>
      <textarea
        ref={ref}
        value={o.text}
        data-testid="overlay-text-editor"
        spellCheck={false}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const doc = useDocuments.getState().docs[docId];
          let next = { ...o, text: e.target.value } as TextOverlay;
          const need = neededTextHeight(next);
          const [, h] = size(next.rect);
          if (need > h + 0.5) {
            const dh = need - h;
            const [cx, cy] = center(next.rect);
            const t = (next.rotation * Math.PI) / 180;
            const ncx = cx - (dh / 2) * Math.sin(t);
            const ncy = cy - (dh / 2) * Math.cos(t);
            const [w] = size(next.rect);
            next = { ...next, rect: [ncx - w / 2, ncy - need / 2, ncx + w / 2, ncy + need / 2] };
          }
          setOverlaysTransient(docId, doc.overlays.map((x) => (x.id === o.id ? next : x)));
        }}
        onBlur={finish}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
        }}
        style={{ ...css, width: '100%', height: '100%', boxSizing: 'border-box', resize: 'none', background: 'transparent', outline: 'none', border: 'none', overflow: 'hidden', display: 'block', caretColor: o.color }}
      />
    </div>
  );
}

function ImageBody({ o, scale: _scale }: { o: ImageOverlay; scale: number }) {
  const [l, t, r, b] = o.crop;
  const visW = 1 - l - r;
  const visH = 1 - t - b;
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ opacity: o.opacity, outline: o.borderColor && o.borderWidth ? `${o.borderWidth * _scale}px solid ${o.borderColor}` : undefined, outlineOffset: o.borderColor ? `-${(o.borderWidth * _scale) / 2}px` : undefined }}>
      <img
        src={bridge().assetUrl(o.assetId)}
        alt=""
        draggable={false}
        className="absolute max-w-none select-none"
        style={{
          width: `${100 / visW}%`,
          height: `${100 / visH}%`,
          left: `${(-l / visW) * 100}%`,
          top: `${(-t / visH) * 100}%`,
          transform: `scale(${o.flipH ? -1 : 1}, ${o.flipV ? -1 : 1})`,
        }}
      />
    </div>
  );
}
