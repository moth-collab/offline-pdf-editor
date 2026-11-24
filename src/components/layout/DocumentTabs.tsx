import { FileText, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isDirty, useDocuments } from '@/stores/documents';
import { closeDocument, openWithDialog } from '@/services/docService';
import { tr } from '@/i18n';

export function DocumentTabs() {
  const order = useDocuments((s) => s.order);
  const docs = useDocuments((s) => s.docs);
  const activeId = useDocuments((s) => s.activeId);
  const setActive = useDocuments((s) => s.setActive);
  const moveTab = useDocuments((s) => s.moveTab);
  if (!order.length) return null;
  return (
    <div className="flex h-[30px] shrink-0 items-end gap-[1px] overflow-x-auto border-b bg-chrome px-1" role="tablist">
      {order.map((id, idx) => {
        const d = docs[id];
        if (!d) return null;
        const dirty = isDirty(d);
        return (
          <div
            key={id}
            role="tab"
            aria-selected={id === activeId}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/x-pdfed-tab', id)}
            onDragOver={(e) => e.dataTransfer.types.includes('application/x-pdfed-tab') && e.preventDefault()}
            onDrop={(e) => {
              const src = e.dataTransfer.getData('application/x-pdfed-tab');
              if (src) moveTab(src, idx);
            }}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeDocument(id);
              }
            }}
            onClick={() => setActive(id)}
            title={d.info.original_path ?? d.info.display_name}
            className={cn(
              'group flex h-[26px] max-w-[240px] cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-[12px]',
              id === activeId ? 'border-border bg-background' : 'border-transparent text-muted-foreground hover:bg-muted',
            )}
            data-testid="doc-tab"
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-brand" />
            <span className="truncate">{d.info.display_name}</span>
            {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" title={tr("Unsaved changes")} />}
            {d.busy && <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />}
            <button
              className="ml-0.5 rounded-sm p-0.5 opacity-50 hover:bg-muted hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                closeDocument(id);
              }}
              aria-label={tr("Close tab")}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button className="mb-0.5 ml-1 rounded p-1 text-muted-foreground hover:bg-muted" onClick={openWithDialog} aria-label={tr("Open document")} title={tr("Open (Ctrl+O)")}>
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
