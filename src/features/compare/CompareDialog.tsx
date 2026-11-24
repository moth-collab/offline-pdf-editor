/* Compare two versions of a document. */
import { useState } from 'react';
import type { DocumentInfo, FileRef } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label, Select } from '@/components/ui/controls';
import { bridge, call, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useDocuments } from '@/stores/documents';
import { toast, useUi } from '@/stores/ui';
import { addOpened } from '@/services/docService';
import { goToPage } from '@/app/commands';
import { prepareForSave } from '@/features/overlay-editor/model';
import { tr } from '@/i18n';

interface Change {
  kind: 'insert' | 'delete' | 'replace';
  old: string;
  new: string;
  page: number;
}
interface Comparison {
  changes: Change[];
  stats: { inserted: number; deleted: number; replaced: number; changes: number; identical_text: boolean };
}

type Source = { kind: 'doc'; id: string } | { kind: 'file'; ref: FileRef } | null;

function SourcePicker({ label, value, onChange, testid }: { label: string; value: Source; onChange: (s: Source) => void; testid: string }) {
  const order = useDocuments((s) => s.order);
  const all = useDocuments((s) => s.docs);
  const docs = order.map((id) => all[id]).filter(Boolean);
  const fileOpt = value?.kind === 'file' ? [{ value: 'file', label: value.ref.name, raw: true }] : [];
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <Select
            value={value?.kind === 'doc' ? value.id : value?.kind === 'file' ? 'file' : ''}
            onValueChange={(v) => v !== 'file' && onChange({ kind: 'doc', id: v })}
            placeholder={tr('Choose a document')}
            options={[...docs.map((d) => ({ value: d.id, label: d.info.display_name, raw: true })), ...fileOpt]}
          />
        </div>
        <Button
          variant="outline"
          data-testid={testid}
          onClick={async () => {
            const refs = await bridge().dialog.open('pdf', tr('Choose a PDF file'));
            if (refs[0]) onChange({ kind: 'file', ref: refs[0] });
          }}
        >
          {tr('Browse…')}
        </Button>
      </div>
    </div>
  );
}

export function CompareDialog({ onClose }: { onClose: () => void }) {
  const activeId = useDocuments((s) => s.activeId);
  const order = useDocuments((s) => s.order);
  // one open document: it is the newer version, compared with an older file;
  // several: the active one against the next open document
  const other = order.find((id) => id !== activeId);
  const [older, setOlder] = useState<Source>(activeId && other ? { kind: 'doc', id: activeId } : null);
  const [newer, setNewer] = useState<Source>(() => (other && activeId ? { kind: 'doc', id: other } : activeId ? { kind: 'doc', id: activeId } : null));
  const [result, setResult] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState(false);

  const payload = (prefix: 'old' | 'new', s: Source): Record<string, unknown> => {
    if (!s) return {};
    if (s.kind === 'file') return { [`${prefix}_token`]: s.ref.token };
    const d = useDocuments.getState().docs[s.id];
    return { [`${prefix}_doc_id`]: s.id, ...(d?.overlays.length ? { [`${prefix}_overlays`]: prepareForSave(d.overlays) } : {}) };
  };

  const run = async () => {
    setBusy(true);
    useUi.getState().setBusy({ label: tr('Comparing documents…') });
    try {
      const info = await call<DocumentInfo & { comparison: Comparison }>('doc.compare', { ...payload('old', older), ...payload('new', newer) });
      addOpened(info);
      setResult(info.comparison);
      if (info.comparison.stats.identical_text) toast('info', tr('No text differences'), tr('The text of both documents is the same.'));
    } catch (e) {
      toast('error', tr('Comparison failed'), errorMessage(e));
    } finally {
      setBusy(false);
      useUi.getState().setBusy(null);
    }
  };

  const same = older && newer && older.kind === 'doc' && newer.kind === 'doc' && older.id === newer.id;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{tr('Compare documents')}</DialogTitle>
          <DialogDescription>{tr('Finds text that was added, removed or changed between two versions. The result opens as a new side-by-side document: removed text is red on the left, new text green on the right.')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <SourcePicker label={tr('Older version')} value={older} onChange={(s) => { setOlder(s); setResult(null); }} testid="cmp-old-file" />
          <SourcePicker label={tr('Newer version')} value={newer} onChange={(s) => { setNewer(s); setResult(null); }} testid="cmp-new-file" />
        </div>
        {same && <div className="text-[12px] text-warning">{tr('Choose two different documents')}</div>}
        {result && (
          <div className="space-y-2" data-testid="cmp-result">
            <div className="flex gap-4 text-[12px]">
              <span>{tr('{0} changes', result.stats.changes)}</span>
              <span className="text-success">{tr('{0} words added', result.stats.inserted)}</span>
              <span className="text-destructive">{tr('{0} words removed', result.stats.deleted)}</span>
              <span>{tr('{0} passages changed', result.stats.replaced)}</span>
            </div>
            <div className="max-h-[260px] overflow-auto rounded-md border text-[12px]">
              {!result.changes.length && <div className="p-3 text-muted-foreground">{tr('No text differences')}</div>}
              {result.changes.map((c, i) => (
                <button
                  key={i}
                  data-testid="cmp-change"
                  className="flex w-full items-start gap-2 border-b px-2 py-1 text-left last:border-0 hover:bg-muted"
                  onClick={() => goToPage(c.page)}
                >
                  <span className="w-10 shrink-0 text-muted-foreground">{tr('p. {0}', c.page + 1)}</span>
                  <span className="min-w-0 flex-1">
                    {c.old && <span className={cn('mr-1 rounded-sm bg-red-100 px-0.5 text-red-800 line-through dark:bg-red-950 dark:text-red-200')}>{c.old}</span>}
                    {c.new && <span className="rounded-sm bg-green-100 px-0.5 text-green-800 dark:bg-green-950 dark:text-green-200">{c.new}</span>}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tr('Close')}
          </Button>
          <Button onClick={run} disabled={busy || !older || !newer || !!same} data-testid="cmp-run">
            {tr('Compare')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
