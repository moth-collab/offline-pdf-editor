/* Select / move / resize existing annotations of a page (Select tool). */
import { useEffect, useRef, useState } from 'react';
import type { PageInfo } from '@shared/types';
import { useDocuments, type DocState } from '@/stores/documents';
import { rectToView, viewRectToPdf, type PageSlot } from '@/features/viewer/geometry';
import { cn } from '@/lib/utils';
import { annotKey, loadAnnots, updateAnnot, useAnnots, TYPE_LABEL, type Annot } from './service';
import { tr } from '@/i18n';

interface Props {
  doc: DocState;
  pageIndex: number;
  info: PageInfo;
  zoom: number;
  slot: PageSlot;
}

type Drag = { mode: 'move' | 'resize'; handle?: string; x: number; y: number; a: Annot; active: boolean };

export function AnnotationLayer(props: Props) {
  const { doc } = props;
  const active = doc.tool === 'select' || doc.selection.kind === 'annotation';
  if (!active) return null;
  return <Inner {...props} />;
}

function Inner({ doc, pageIndex, info, zoom }: Props) {
  const key = annotKey(doc.id, doc.info.revision, pageIndex);
  const annots = useAnnots((s) => s.cache[key]);
  const update = useDocuments((s) => s.update);
  const [delta, setDelta] = useState<{ dx: number; dy: number; dw: number; dh: number; id: string } | null>(null);
  const drag = useRef<Drag | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const selected = doc.selection.kind === 'annotation' && doc.selection.page === pageIndex ? new Set(doc.selection.ids) : new Set<string>();
  const interactive = doc.tool === 'select';
  const editable = doc.info.owner_authenticated !== false || !!doc.info.permissions?.annotate;

  useEffect(() => {
    loadAnnots(doc.id, doc.info.revision, pageIndex).catch(() => undefined);
  }, [doc.id, doc.info.revision, pageIndex]);
  if (!annots?.length) return null;

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.active) {
      if (Math.hypot(dx, dy) < 4) return;
      d.active = true;
      layerRef.current?.setPointerCapture(e.pointerId);
    }
    if (d.mode === 'move') setDelta({ dx, dy, dw: 0, dh: 0, id: d.a.id });
    else setDelta({ dx: d.handle!.includes('w') ? dx : 0, dy: d.handle!.includes('n') ? dy : 0, dw: d.handle!.includes('e') ? dx : d.handle!.includes('w') ? -dx : 0, dh: d.handle!.includes('s') ? dy : d.handle!.includes('n') ? -dy : 0, id: d.a.id });
  };
  const onUp = () => {
    const d = drag.current;
    const dl = delta;
    drag.current = null;
    setDelta(null);
    if (!d || !d.active || !dl) return;
    const box = rectToView(info, zoom, d.a.rect);
    const l = box.left + dl.dx;
    const t = box.top + dl.dy;
    const w = Math.max(6, box.width + dl.dw);
    const h = Math.max(6, box.height + dl.dh);
    const norm = viewRectToPdf(info, zoom, l, t, l + w, t + h);
    updateAnnot(doc.id, pageIndex, d.a.xref, { rect: norm }, d.mode === 'move' ? tr("Move comment") : tr("Resize comment"));
  };

  return (
    <div ref={layerRef} className="absolute inset-0 z-[4]" style={{ pointerEvents: 'none' }} onPointerMove={onMove} onPointerUp={onUp}>
      {annots.map((a) => {
        if (a.type === 'widget' || a.type === 'link') return null;
        const r = rectToView(info, zoom, a.rect);
        const isSel = selected.has(a.id);
        const dl = delta && delta.id === a.id ? delta : null;
        const canMove = editable && a.editable;
        return (
          <div
            key={a.id}
            data-annot-id={a.id}
            title={`${tr(TYPE_LABEL[a.type] ?? a.type)}${a.author ? ` – ${a.author}` : ''}${a.contents ? `\n${a.contents}` : ''}`}
            className={cn('absolute rounded-[1px]', isSel ? 'outline outline-2 outline-offset-1 outline-[var(--selection)]' : interactive && 'hover:outline hover:outline-1 hover:outline-primary/60')}
            style={{
              left: r.left + (dl?.dx ?? 0),
              top: r.top + (dl?.dy ?? 0),
              width: Math.max(6, r.width + (dl?.dw ?? 0)),
              height: Math.max(6, r.height + (dl?.dh ?? 0)),
              pointerEvents: interactive ? 'auto' : 'none',
              cursor: interactive ? (isSel && canMove ? 'move' : 'pointer') : undefined,
              background: dl ? 'rgba(37,99,235,0.08)' : undefined,
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || !interactive) return;
              e.stopPropagation();
              if (!isSel) {
                update(doc.id, { selection: { kind: 'annotation', ids: [a.id], page: pageIndex }, currentPage: pageIndex });
                return;
              }
              if (canMove) drag.current = { mode: 'move', x: e.clientX, y: e.clientY, a, active: false };
            }}
          >
            {isSel && canMove && !dl && ['nw', 'ne', 'se', 'sw'].map((h) => (
              <div
                key={h}
                className="absolute h-2 w-2 border border-[var(--selection)] bg-white"
                style={{ left: h.includes('w') ? -5 : undefined, right: h.includes('e') ? -5 : undefined, top: h.includes('n') ? -5 : undefined, bottom: h.includes('s') ? -5 : undefined, cursor: h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize' }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  drag.current = { mode: 'resize', handle: h, x: e.clientX, y: e.clientY, a, active: true };
                  layerRef.current?.setPointerCapture(e.pointerId);
                }}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
