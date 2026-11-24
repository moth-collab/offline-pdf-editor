import { RIBBON } from '@/app/menus';
import { getCommand, runCommand } from '@/app/commands';
import { Tooltip } from '@/components/ui/controls';
import { cn } from '@/lib/utils';
import { useUi, type RibbonTab } from '@/stores/ui';
import { useActiveDoc } from '@/stores/documents';
import { useDocuments } from '@/stores/documents';
import { MODE_LABELS } from '@/types/editor';
import { tr } from '@/i18n';
import { useForms } from '@/features/forms/service';

const TABS: { id: RibbonTab; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'edit', label: 'Edit' },
  { id: 'organize', label: 'Organize' },
  { id: 'comment', label: 'Comment' },
  { id: 'forms', label: 'Forms' },
  { id: 'convert', label: 'Convert' },
  { id: 'protect', label: 'Protect' },
];

export function Ribbon() {
  const tab = useUi((s) => s.ribbonTab);
  const setTab = useUi((s) => s.setRibbonTab);
  const doc = useActiveDoc();
  // re-render when undo/redo/tool state changes
  useDocuments((s) => (s.activeId ? `${s.docs[s.activeId]?.tool}:${s.docs[s.activeId]?.undo.length}:${s.docs[s.activeId]?.redo.length}:${s.docs[s.activeId]?.selection.ids.length}` : ''));
  // …and when form data (fields present?) or the field highlight toggle changes
  useForms((s) => `${Object.keys(s.cache).length}:${s.highlight}`);
  const groups = RIBBON[tab] ?? [];
  const mode = doc ? tr(MODE_LABELS[doc.tool] ?? doc.tool) : null;
  const isDirect = doc?.tool === 'direct-text';
  const isOverlay = doc && ['add-text', 'add-image', 'shape-rect', 'shape-ellipse', 'shape-line', 'shape-arrow', 'add-link', 'edit-objects'].includes(doc.tool);

  return (
    <div className="shrink-0 border-b bg-ribbon">
      <div className="flex h-[30px] items-end gap-0.5 px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'relative h-[26px] rounded-t-md px-3 text-[12.5px] font-medium text-muted-foreground hover:text-foreground',
              tab === t.id && 'bg-background text-foreground shadow-[0_-1px_0_var(--border),1px_0_0_var(--border),-1px_0_0_var(--border)]',
            )}
            data-testid={`ribbon-tab-${t.id}`}
          >
            {tr(t.label)}
            {tab === t.id && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-primary" />}
          </button>
        ))}
        {doc && (
          <div className="ml-auto flex items-center gap-1.5 pb-1 text-[11.5px]">
            <span className="text-muted-foreground">{tr("Mode:")}</span>
            <div className="flex overflow-hidden rounded-md border bg-background">
              <button
                className={cn('px-2 py-[2px]', isDirect ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                onClick={() => runCommand('tool.direct-text')}
                title={tr("Edit existing text directly")}
              >
                {tr("Direct Edit")}
              </button>
              <button
                className={cn('border-l px-2 py-[2px]', isOverlay ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                onClick={() => runCommand('tool.add-text')}
                title={tr("Add new text and objects on top of the page")}
              >
                {tr("Add Text / Overlay")}
              </button>
            </div>
            <span className="min-w-[90px] rounded bg-accent px-2 py-[2px] font-medium text-accent-foreground" data-testid="current-mode">
              {mode}
            </span>
          </div>
        )}
      </div>
      <div className="flex h-[82px] items-stretch gap-0 overflow-x-auto bg-background px-1.5 py-1">
        {groups.map((g) => {
          const buttons = g.buttons.filter((b) => getCommand(b.cmd));
          if (!buttons.length) return null;
          return (
            <div key={g.label} className="flex flex-col border-r px-1.5 last:border-r-0">
              <div className="flex flex-1 items-start gap-0.5">
                <RibbonButtons buttons={buttons} />
              </div>
              <div className="text-center text-[10.5px] text-muted-foreground">{tr(g.label)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RibbonButtons({ buttons }: { buttons: (typeof RIBBON)['home'][number]['buttons'] }) {
  const big = buttons.filter((b) => b.big);
  const small = buttons.filter((b) => !b.big);
  const cols: (typeof small)[] = [];
  for (let i = 0; i < small.length; i += 3) cols.push(small.slice(i, i + 3));
  return (
    <>
      {big.map((b) => {
        const c = getCommand(b.cmd)!;
        const enabled = !c.enabled || c.enabled();
        const active = c.checked?.();
        const Icon = b.icon;
        return (
          <Tooltip key={b.cmd} content={`${tr(c.label)}${c.shortcut ? ` (${c.shortcut})` : ''}`}>
            <button
              disabled={!enabled}
              onClick={() => runCommand(b.cmd)}
              className={cn(
                'flex h-[52px] min-w-[54px] flex-col items-center justify-center gap-1 rounded-md px-1.5 text-[11.5px] hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent',
                active && 'bg-accent text-accent-foreground hover:bg-accent',
              )}
              data-testid={`rb-${b.cmd}`}
            >
              <Icon className="h-[22px] w-[22px]" strokeWidth={1.6} />
              <span className="leading-none">{tr(b.label ?? c.label)}</span>
            </button>
          </Tooltip>
        );
      })}
      {cols.map((col, i) => (
        <div key={i} className="flex flex-col justify-start gap-[1px]">
          {col.map((b) => {
            const c = getCommand(b.cmd)!;
            const enabled = !c.enabled || c.enabled();
            const active = c.checked?.();
            const Icon = b.icon;
            return (
              <Tooltip key={b.cmd} content={`${tr(c.label)}${c.shortcut ? ` (${c.shortcut})` : ''}`}>
                <button
                  disabled={!enabled}
                  onClick={() => runCommand(b.cmd)}
                  className={cn(
                    'flex h-[21px] items-center gap-1.5 rounded px-1.5 text-[11.5px] hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent',
                    active && 'bg-accent text-accent-foreground',
                  )}
                  data-testid={`rb-${b.cmd}`}
                >
                  <Icon className="h-[15px] w-[15px]" strokeWidth={1.7} />
                  <span>{tr(b.label ?? c.label)}</span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      ))}
    </>
  );
}
