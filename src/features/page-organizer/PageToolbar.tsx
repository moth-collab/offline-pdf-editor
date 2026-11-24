/* Page actions above the thumbnails (and in the organizer): insert, delete,
 * rotate, duplicate, extract – one click, without opening a menu. */
import { Copy, FileInput, FileOutput, FilePlus2, ImagePlus, RotateCcw, RotateCw, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/controls';
import { cn } from '@/lib/utils';
import { getCommand, runCommand } from '@/app/commands';
import { useDocuments } from '@/stores/documents';
import { tr } from '@/i18n';

const ACTIONS: { cmd: string; icon: LucideIcon; danger?: boolean; sep?: boolean }[] = [
  { cmd: 'page.insertImages', icon: ImagePlus },
  { cmd: 'page.insertFile', icon: FileInput },
  { cmd: 'page.insertBlank', icon: FilePlus2 },
  { cmd: 'page.duplicate', icon: Copy, sep: true },
  { cmd: 'page.rotateLeft', icon: RotateCcw },
  { cmd: 'page.rotateRight', icon: RotateCw },
  { cmd: 'doc.extract', icon: FileOutput, sep: true },
  { cmd: 'page.delete', icon: Trash2, danger: true },
];

export function PageToolbar({ className }: { className?: string }) {
  // re-render when the selection or the document changes (enabled states)
  useDocuments((s) => (s.activeId ? `${s.docs[s.activeId]?.selectedPages.length}:${s.docs[s.activeId]?.info.revision}` : ''));
  return (
    <div className={cn('flex items-center gap-0.5', className)} data-testid="page-toolbar">
      {ACTIONS.map(({ cmd, icon: Icon, danger, sep }) => {
        const c = getCommand(cmd);
        if (!c) return null;
        const enabled = !c.enabled || c.enabled();
        return (
          <span key={cmd} className="flex items-center">
            {sep && <span className="mx-0.5 h-4 w-px bg-border" />}
            <Tooltip content={`${tr(c.label).replace('…', '')}${c.shortcut ? ` (${c.shortcut})` : ''}`}>
              <button
                type="button"
                data-testid={`pt-${cmd}`}
                aria-label={tr(c.label)}
                disabled={!enabled}
                onClick={() => runCommand(cmd)}
                className={cn(
                  'rounded p-1 hover:bg-muted disabled:pointer-events-none disabled:opacity-35',
                  danger && 'text-destructive',
                  cmd === 'page.insertImages' && 'text-primary',
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            </Tooltip>
          </span>
        );
      })}
    </div>
  );
}
