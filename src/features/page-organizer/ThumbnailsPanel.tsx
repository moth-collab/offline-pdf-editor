/* Thumbnails: lazy rendering, Ctrl/Shift multi-select, drag & drop reorder,
 * context menu with page operations. Also used (larger) by the organizer. */
import { memo, useEffect, useRef, useState } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/menus';
import { cn } from '@/lib/utils';
import { useDocuments, type DocState } from '@/stores/documents';
import { goToPage, runCommand } from '@/app/commands';
import { movePages } from '@/app/pageCommands';
import { viewSize } from '@/features/viewer/geometry';
import { getThumb, peekThumb } from './thumbnails';
import { tr } from '@/i18n';

interface ThumbProps {
  doc: DocState;
  index: number;
  width: number;
  selected: boolean;
  current: boolean;
  onSelect: (index: number, e: React.MouseEvent) => void;
  scanned: boolean;
}

const Thumb = memo(function Thumb({ doc, index, width, selected, current, onSelect, scanned }: ThumbProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const info = doc.info.pages[index];
  const contentId = doc.pageVersions[index];
  const [url, setUrl] = useState<string | undefined>(() => peekThumb(doc.id, contentId, width));
  const [visible, setVisible] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `p${index}` });
  const vs = viewSize(info, 1);
  const h = Math.round((width * vs.height) / vs.width);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const cached = peekThumb(doc.id, contentId, width);
    if (cached) {
      setUrl(cached);
      return;
    }
    if (!visible) return;
    let alive = true;
    getThumb(doc.id, doc.info.revision, index, contentId, width, info.rotation)
      .then((u) => alive && setUrl(u))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [visible, contentId, width, doc.id, doc.info.revision, index, info.rotation]);

  return (
    <div
      ref={(n) => {
        ref.current = n;
        setNodeRef(n);
      }}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="flex flex-col items-center gap-1 p-1"
      data-testid="thumbnail"
      data-page={index}
    >
      <div
        {...attributes}
        {...listeners}
        onClick={(e) => onSelect(index, e)}
        onDoubleClick={() => goToPage(index)}
        className={cn(
          'relative cursor-pointer bg-white shadow-sm outline-offset-2',
          selected ? 'outline outline-2 outline-primary' : current ? 'outline outline-1 outline-primary/50' : 'hover:outline hover:outline-1 hover:outline-border',
        )}
        style={{ width, height: h }}
      >
        {url ? <img src={url} alt={tr("Page {0}", index + 1)} draggable={false} className="h-full w-full" /> : <div className="h-full w-full animate-pulse bg-muted/60" />}
        {scanned && <span className="absolute right-1 top-1 rounded bg-black/55 px-1 text-[9px] text-white">{tr("SCAN")}</span>}
      </div>
      <span className={cn('text-[11px]', current ? 'font-semibold text-primary' : 'text-muted-foreground')}>{index + 1}</span>
    </div>
  );
});

export function ThumbnailGrid({ doc, width, columns }: { doc: DocState; width: number; columns?: boolean }) {
  const update = useDocuments((s) => s.update);
  const anchor = useRef<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const ids = doc.info.pages.map((_, i) => `p${i}`);
  const sel = new Set(doc.selectedPages);
  const scanned = new Set(doc.scannedPages);
  const editable = doc.info.owner_authenticated !== false;

  const onSelect = (i: number, e: React.MouseEvent) => {
    let next: number[];
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      const range = Array.from({ length: b - a + 1 }, (_, k) => a + k);
      next = e.ctrlKey || e.metaKey ? [...new Set([...doc.selectedPages, ...range])] : range;
    } else if (e.ctrlKey || e.metaKey) {
      next = sel.has(i) ? doc.selectedPages.filter((p) => p !== i) : [...doc.selectedPages, i];
      anchor.current = i;
    } else {
      next = [i];
      anchor.current = i;
      goToPage(i);
    }
    update(doc.id, { selectedPages: next.sort((x, y) => x - y) });
  };

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id || !editable) return;
    const from = parseInt(String(e.active.id).slice(1), 10);
    const to = parseInt(String(e.over.id).slice(1), 10);
    const moving = sel.has(from) ? doc.selectedPages : [from];
    const remainingBefore = Array.from({ length: to + (to > from ? 1 : 0) }, (_, k) => k).filter((k) => !moving.includes(k)).length;
    movePages(doc, moving, remainingBefore);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={rectSortingStrategy}>
              <div className={cn(columns ? 'flex flex-wrap content-start gap-2 p-3' : 'flex flex-col items-center py-2')}>
                {doc.info.pages.map((_, i) => (
                  <Thumb key={i} doc={doc} index={i} width={width} selected={sel.has(i)} current={i === doc.currentPage} onSelect={onSelect} scanned={scanned.has(i)} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => runCommand('page.rotateLeft')}>{tr("Rotate Left")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => runCommand('page.rotateRight')}>{tr("Rotate Right")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => runCommand('page.insertBlank')}>{tr("Insert Blank Page…")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => runCommand('page.insertFile')}>{tr("Insert from File…")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => runCommand('page.duplicate')}>{tr("Duplicate")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => runCommand('doc.extract')}>{tr("Extract…")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => runCommand('page.copy')}>{tr("Copy Pages")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => runCommand('page.paste')}>{tr("Paste Pages")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => runCommand('page.moveTo')}>{tr("Move To…")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => runCommand('page.crop')}>{tr("Crop…")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => runCommand('page.delete')} className="text-destructive">
          {tr("Delete…")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
