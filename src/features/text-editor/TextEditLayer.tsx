/* Direct Edit mode: select, edit, move and resize existing text of the page. */
import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, ScanText, Trash2, Type, X } from 'lucide-react';
import type { PageInfo } from '@shared/types';
import { Button } from '@/components/ui/button';
import { useDocuments, type DocState } from '@/stores/documents';
import { runCommand, setTool } from '@/app/commands';
import { rectToView, scaleOf, viewDeltaToPdf, type PageSlot } from '@/features/viewer/geometry';
import { cacheKey, loadTextObjects, requestPreview, useTextEdit, type PageTextObjects, type TextBlock } from './service';
import { cn } from '@/lib/utils';
import { tr } from '@/i18n';

interface Props {
  doc: DocState;
  pageIndex: number;
  info: PageInfo;
  zoom: number;
  slot: PageSlot;
}

function joinForReflow(lines: string[]): string {
  let out = '';
  for (const l of lines) {
    const t = l.trimEnd();
    if (!out) out = t;
    else {
      const thaiJoin = /[฀-๿]$/.test(out) && /^[฀-๿]/.test(t.trimStart());
      out += (thaiJoin ? '' : ' ') + t.trimStart();
    }
  }
  return out;
}

export function TextEditLayer(props: Props) {
  if (props.doc.tool !== 'direct-text') return null;
  return <TextEditLayerInner {...props} />;
}

function TextEditLayerInner({ doc, pageIndex, info, zoom }: Props) {
  const key = cacheKey(doc.id, doc.info.revision, pageIndex);
  const objs = useTextEdit((s) => s.cache[key]) as PageTextObjects | undefined;
  const selected = useTextEdit((s) => s.selected);
  const editing = useTextEdit((s) => s.editing);
  const draft = useTextEdit((s) => s.draft);
  const [hover, setHover] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ dx: number; dy: number; dw: number } | null>(null);
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; block: TextBlock; active: boolean } | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const editable = doc.info.owner_authenticated !== false;
  const s = scaleOf(zoom);

  useEffect(() => {
    let alive = true;
    loadTextObjects(doc.id, doc.info.revision, pageIndex).catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [doc.id, doc.info.revision, pageIndex]);

  const selBlock = selected && selected.docId === doc.id && selected.page === pageIndex ? objs?.blocks.find((b) => b.id === selected.blockId) : undefined;

  const select = (b: TextBlock) => {
    useTextEdit.getState().setSelected({ docId: doc.id, page: pageIndex, blockId: b.id, lineIds: b.lines.map((l) => l.id) });
    useDocuments.getState().update(doc.id, { selection: { kind: 'text', ids: b.lines.map((l) => l.id), page: pageIndex }, currentPage: pageIndex });
  };

  const startEdit = (b: TextBlock) => {
    if (!editable) return;
    select(b);
    useTextEdit.getState().setEditing(true, b.lines.map((l) => l.text.replace(/\s+$/, '')).join('\n'));
  };

  const submit = (b: TextBlock, text: string, extra: Record<string, unknown> = {}) => {
    useTextEdit.getState().setEditing(false);
    requestPreview({ docId: doc.id, page: pageIndex, lineIds: b.lines.map((l) => l.id), newText: text, originalText: b.text, ...extra });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.active) {
      // start dragging only after a small movement so double-clicks still work
      if (Math.hypot(dx, dy) < 4) return;
      d.active = true;
      layerRef.current?.setPointerCapture(e.pointerId);
    }
    if (d.mode === 'move') setGhost({ dx, dy, dw: 0 });
    else setGhost({ dx: 0, dy: 0, dw: dx });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    const g = ghost;
    setGhost(null);
    if (!d || !g || !d.active) return;
    void e;
    if (d.mode === 'move' && Math.hypot(g.dx, g.dy) > 3) {
      const [pdx, pdy] = viewDeltaToPdf(info, zoom, g.dx, g.dy);
      submit(d.block, d.block.lines.map((l) => l.text.replace(/\s+$/, '')).join('\n'), { offset: [pdx, pdy] });
    } else if (d.mode === 'resize' && Math.abs(g.dw) > 3) {
      const [pw] = viewDeltaToPdf(info, zoom, g.dw, 0);
      const [x0, y0, x1, y1] = d.block.bbox;
      const box: [number, number, number, number] = [x0, y0, Math.max(x0 + 20, x1 + pw), y1];
      submit(d.block, joinForReflow(d.block.lines.map((l) => l.text)), { box });
    }
  };

  if (error) return <div className="pointer-events-none absolute left-2 top-2 z-[7] rounded bg-destructive px-2 py-0.5 text-[11px] text-white">{error}</div>;
  if (!objs) return null;

  return (
    <div
      ref={layerRef}
      className="absolute inset-0 z-[5]"
      onPointerDown={(e) => {
        if ((e.target as Element) === layerRef.current) {
          useTextEdit.getState().setSelected(null);
          useDocuments.getState().update(doc.id, { selection: { kind: 'none', ids: [] } });
        }
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      data-testid={`text-edit-layer-${pageIndex}`}
    >
      {objs.scanned && (
        <div className="absolute inset-x-6 top-6 z-[8] rounded-lg border bg-background/95 p-3 text-[12px] shadow-lg" data-testid="scanned-banner">
          <div className="font-medium">{tr("This page is a scanned image – it contains no editable text.")}</div>
          <div className="mt-0.5 text-muted-foreground">{tr("Run OCR to recognise the text (makes it searchable), or add new text on top of the scan.")}</div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => runCommand('convert.ocr')}>
              <ScanText className="h-3.5 w-3.5" /> {tr("Run OCR…")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setTool('add-text')}>
              <Type className="h-3.5 w-3.5" /> {tr("Add text overlay")}
            </Button>
          </div>
        </div>
      )}
      {objs.blocks.map((b) => {
        const r = rectToView(info, zoom, b.bbox);
        const isSel = selBlock?.id === b.id;
        const invisible = b.lines.every((l) => l.invisible);
        if (isSel && editing) return null;
        return (
          <div
            key={b.id}
            data-text-block={b.id}
            className={cn(
              'absolute cursor-text rounded-[2px]',
              isSel ? 'outline outline-2 outline-[var(--selection)]' : hover === b.id ? 'bg-primary/5 outline outline-1 outline-primary/60' : '',
              invisible && 'outline-dashed outline-amber-500',
            )}
            style={{
              left: r.left - 2 + (isSel && ghost ? ghost.dx : 0),
              top: r.top - 2 + (isSel && ghost ? ghost.dy : 0),
              width: r.width + 4 + (isSel && ghost ? ghost.dw : 0),
              height: r.height + 4,
            }}
            title={invisible ? tr("Invisible text (OCR layer)") : tr("Click to select · double-click to edit · drag to move")}
            onPointerEnter={() => setHover(b.id)}
            onPointerLeave={() => setHover((h) => (h === b.id ? null : h))}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              if (!isSel) {
                select(b);
                return;
              }
              if (!editable) return;
              drag.current = { mode: 'move', x: e.clientX, y: e.clientY, block: b, active: false };
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startEdit(b);
            }}
          >
            {isSel && editable && !ghost && (
              <>
                <div
                  className="absolute -right-1.5 top-1/2 h-4 w-2 -translate-y-1/2 cursor-ew-resize rounded-sm border border-[var(--selection)] bg-white"
                  title={tr("Drag to change the paragraph width (text reflows)")}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    drag.current = { mode: 'resize', x: e.clientX, y: e.clientY, block: b, active: true };
                    layerRef.current?.setPointerCapture(e.pointerId);
                  }}
                />
                <div className="absolute left-full top-1/2 z-[9] ml-3 flex -translate-y-1/2 gap-1 rounded-md border bg-popover p-1 shadow-md" onPointerDown={(e) => e.stopPropagation()}>
                  <Button size="xs" onClick={() => startEdit(b)} data-testid="text-edit-btn"><Pencil className="h-3 w-3" /> {tr("Edit")}</Button>
                  <Button size="xs" variant="outline" onClick={() => submit(b, '')} data-testid="text-delete-btn"><Trash2 className="h-3 w-3" /> {tr("Delete")}</Button>
                </div>
              </>
            )}
          </div>
        );
      })}

      {selBlock && editing && (() => {
        const r = rectToView(info, zoom, selBlock.bbox);
        const st = selBlock.lines[0].style;
        const lh = selBlock.lines.length > 1 ? Math.abs(selBlock.lines[1].origin[1] - selBlock.lines[0].origin[1]) : st.size * 1.25;
        return (
          <div className="absolute z-[9]" style={{ left: r.left - 3, top: r.top - 3 }} onPointerDown={(e) => e.stopPropagation()}>
            <textarea
              autoFocus
              value={draft}
              spellCheck={false}
              data-testid="direct-text-editor"
              onChange={(e) => useTextEdit.getState().setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') useTextEdit.getState().setEditing(false);
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submit(selBlock, draft);
                }
              }}
              className="block resize-none rounded-[2px] bg-white/95 outline outline-2 outline-[var(--selection)]"
              style={{
                width: Math.max(r.width + 40, 120),
                height: Math.max(r.height + 8, lh * s * draft.split('\n').length + 8),
                fontFamily: `"${st.family}", ${st.serif ? 'serif' : st.mono ? 'monospace' : 'sans-serif'}`,
                fontSize: st.size * s,
                lineHeight: `${lh * s}px`,
                fontWeight: st.bold ? 700 : 400,
                fontStyle: st.italic ? 'italic' : 'normal',
                color: st.color,
                padding: '1px 2px',
                whiteSpace: 'pre',
                overflow: 'hidden',
              }}
            />
            <div className="mt-1 flex items-center gap-1 rounded-md border bg-popover p-1 shadow-md">
              <Button size="xs" onClick={() => submit(selBlock, draft)} data-testid="direct-text-apply"><Check className="h-3 w-3" /> {tr("Preview & apply")}</Button>
              <Button size="xs" variant="outline" onClick={() => useTextEdit.getState().setEditing(false)}><X className="h-3 w-3" /> {tr("Cancel")}</Button>
              <span className="px-1 text-[10.5px] text-muted-foreground">{tr("Ctrl+Enter to apply · Esc to cancel")}</span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
