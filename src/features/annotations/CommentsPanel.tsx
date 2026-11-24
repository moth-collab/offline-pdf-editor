/* Sidebar list of all comments/annotations of the document. */
import { useEffect, useState } from 'react';
import { Highlighter, MessageSquare, PenLine, Shapes, Square, Stamp, Trash2, Type } from 'lucide-react';
import { Input } from '@/components/ui/controls';
import { call } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useDocuments, type DocState } from '@/stores/documents';
import { viewerBus } from '@/features/viewer/viewerBus';
import { deleteAnnots, TYPE_LABEL, type Annot } from './service';
import { tr } from '@/i18n';

const ICON: Record<string, typeof MessageSquare> = {
  highlight: Highlighter, underline: Highlighter, strikeout: Highlighter, squiggly: Highlighter, note: MessageSquare, freetext: Type,
  ink: PenLine, rect: Square, circle: Shapes, line: Shapes, stamp: Stamp, redact: Square,
};

export function CommentsPanel({ doc }: { doc: DocState }) {
  const [items, setItems] = useState<Annot[] | null>(null);
  const [filter, setFilter] = useState('');
  const update = useDocuments((s) => s.update);
  useEffect(() => {
    let alive = true;
    call<{ annotations: Annot[] }>('annot.all', { doc_id: doc.id })
      .then((r) => alive && setItems(r.annotations.filter((a) => !['widget', 'link', 'popup'].includes(a.type))))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [doc.id, doc.info.revision]);
  const editable = doc.info.owner_authenticated !== false || !!doc.info.permissions?.annotate;
  const q = filter.trim().toLowerCase();
  const shown = (items ?? []).filter((a) => !q || `${a.contents} ${a.author} ${tr(TYPE_LABEL[a.type] ?? a.type)}`.toLowerCase().includes(q));
  let lastPage = -1;
  return (
    <div className="flex h-full flex-col" data-testid="comments-panel">
      <div className="space-y-1.5 border-b p-2">
        <div className="text-[11.5px] font-semibold">{tr("Comments")} {items ? `(${items.length})` : ''}</div>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={tr("Filter comments…")} />
      </div>
      <div className="flex-1 overflow-auto">
        {items && !shown.length && <p className="px-3 py-4 text-center text-[11.5px] text-muted-foreground">{items.length ? tr("No matching comments.") : tr("No comments yet. Use the Comment tab to add some.")}</p>}
        {shown.map((a) => {
          const Icon = ICON[a.type] ?? MessageSquare;
          const header = a.page !== lastPage;
          lastPage = a.page;
          const sel = doc.selection.kind === 'annotation' && doc.selection.ids.includes(a.id);
          return (
            <div key={`${a.page}-${a.id}`}>
              {header && <div className="bg-muted/60 px-2 py-0.5 text-[10.5px] font-semibold text-muted-foreground">{tr("Page")} {a.page + 1}</div>}
              <div
                className={cn('group flex cursor-pointer gap-2 border-b px-2 py-1.5 hover:bg-muted', sel && 'bg-accent')}
                onClick={() => {
                  update(doc.id, { currentPage: a.page, selection: { kind: 'annotation', ids: [a.id], page: a.page }, tool: 'select' });
                  viewerBus.scrollTo({ docId: doc.id, page: a.page, rect: a.rect });
                }}
                data-testid="comment-item"
              >
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: a.stroke ?? undefined }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground">{tr(TYPE_LABEL[a.type] ?? a.type)}</span>
                    {a.author && <span className="truncate">· {a.author}</span>}
                  </div>
                  {(a.contents || a.stamp) && <div className="line-clamp-3 text-[12px]">{a.contents || a.stamp}</div>}
                </div>
                {editable && (
                  <button className="invisible rounded p-0.5 hover:bg-background group-hover:visible" onClick={(e) => {
                    e.stopPropagation();
                    deleteAnnots(doc.id, a.page, [a.xref]);
                  }} aria-label={tr("Delete comment")}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
