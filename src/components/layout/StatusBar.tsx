import { useEffect, useState } from 'react';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Minus, Plus, ShieldCheck, WifiOff } from 'lucide-react';
import { goToPage, runCommand } from '@/app/commands';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/menus';
import { formatBytes } from '@/lib/utils';
import { isDirty, useActiveDoc, useDocuments } from '@/stores/documents';
import { useUi } from '@/stores/ui';
import { MODE_LABELS } from '@/types/editor';
import { tr } from '@/i18n';

function PageBox({ current, total }: { current: number; total: number }) {
  const [text, setText] = useState(String(current + 1));
  useEffect(() => setText(String(current + 1)), [current]);
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const n = parseInt(text, 10);
          if (n >= 1 && n <= total) goToPage(n - 1);
          else setText(String(current + 1));
          (e.target as HTMLInputElement).blur();
        }
      }}
      onBlur={() => setText(String(current + 1))}
      className="h-5 w-10 rounded border border-input bg-background text-center text-[11.5px] outline-none focus:border-ring"
      aria-label={tr("Current page")}
      data-testid="page-input"
    />
  );
}

export function StatusBar() {
  const doc = useActiveDoc();
  const backend = useUi((s) => s.backend);
  const update = useDocuments((s) => s.update);
  const btn = 'rounded p-0.5 hover:bg-muted disabled:opacity-35';
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-3 border-t bg-chrome px-3 text-[11.5px] text-muted-foreground" data-testid="status-bar" data-engine={backend.state}>
      <span className="flex items-center gap-1" title={tr("All processing happens on this computer. No document data is sent over the network.")}>
        <WifiOff className="h-3 w-3" /> {tr("Offline")}
      </span>
      <span className="flex items-center gap-1">
        <span className={backend.state === 'ready' ? 'h-1.5 w-1.5 rounded-full bg-success' : backend.state === 'failed' ? 'h-1.5 w-1.5 rounded-full bg-destructive' : 'h-1.5 w-1.5 animate-pulse rounded-full bg-warning'} />
        {backend.state === 'ready' ? tr("Engine ready") : backend.state === 'failed' ? tr("Engine stopped") : backend.state === 'restarting' ? tr("Engine restarting…") : tr("Starting engine…")}
      </span>
      {doc && (
        <>
          <span className="h-3 w-px bg-border" />
          <span data-testid="status-mode">{tr("Mode:")} {tr(MODE_LABELS[doc.tool] ?? doc.tool)}</span>
          <span data-testid="save-status" className={isDirty(doc) ? 'text-warning' : ''}>
            {isDirty(doc) ? tr("Unsaved changes") : doc.info.saved_revision === null ? tr("Not saved yet") : tr("All changes saved")}
          </span>
          <span>{formatBytes(doc.info.file_size)}</span>
          {doc.info.source_encrypted && (
            <span className="flex items-center gap-1" title={tr("The source document is encrypted")}>
              <ShieldCheck className="h-3 w-3" /> {tr("Secured")}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <button className={btn} onClick={() => goToPage(0)} disabled={doc.currentPage === 0} aria-label={tr("First page")}>
              <ChevronFirst className="h-3.5 w-3.5" />
            </button>
            <button className={btn} onClick={() => goToPage(doc.currentPage - 1)} disabled={doc.currentPage === 0} aria-label={tr("Previous page")}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <PageBox current={doc.currentPage} total={doc.info.page_count} />
            <span data-testid="page-count">/ {doc.info.page_count}</span>
            <button className={btn} onClick={() => goToPage(doc.currentPage + 1)} disabled={doc.currentPage >= doc.info.page_count - 1} aria-label={tr("Next page")}>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button className={btn} onClick={() => goToPage(doc.info.page_count - 1)} disabled={doc.currentPage >= doc.info.page_count - 1} aria-label={tr("Last page")}>
              <ChevronLast className="h-3.5 w-3.5" />
            </button>
            <span className="mx-1 h-3 w-px bg-border" />
            <button className={btn} onClick={() => runCommand('view.zoomOut')} aria-label={tr("Zoom out")}>
              <Minus className="h-3.5 w-3.5" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger className="w-14 rounded px-1 py-[1px] text-center hover:bg-muted" data-testid="zoom-level">
                {Math.round(doc.zoom * 100)}%
              </DropdownMenuTrigger>
              <DropdownMenuContent className="min-w-[8rem]">
                {[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((z) => (
                  <DropdownMenuItem key={z} onSelect={() => update(doc.id, { zoom: z, zoomMode: 'custom' })}>
                    {z * 100}%
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => runCommand('view.fitWidth')}>{tr("Fit Width")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => runCommand('view.fitPage')}>{tr("Fit Page")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button className={btn} onClick={() => runCommand('view.zoomIn')} aria-label={tr("Zoom in")}>
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
