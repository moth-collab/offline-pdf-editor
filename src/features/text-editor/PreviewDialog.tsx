import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Layers, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CheckRow, Label } from '@/components/ui/controls';
import { cn } from '@/lib/utils';
import { FontPicker } from '@/features/overlay-editor/OverlayProperties';
import { applyEdit, fallbackToOverlay, requestPreview, useTextEdit, type PendingEdit, type PreviewReport } from './service';
import { tr } from '@/i18n';

const STATUS: Record<string, string> = {
  embedded: 'Embedded',
  subset: 'Embedded subset',
  standard: 'Standard PDF font (not embedded)',
  missing: 'Not embedded',
  unsupported: 'Type 3 font',
  unknown: 'Unknown',
};

const PLAN: Record<string, string> = {
  original: 'Original embedded font (exact appearance)',
  local: 'Same font installed on this computer',
  substitute: 'Substitute font',
  fallback: 'Generic fallback font',
  user: 'Font you selected',
  none: '–',
};

export function TextEditPreviewDialog({ onClose, edit, preview }: { onClose: () => void; edit: PendingEdit; preview: { report: PreviewReport; before: string; after: string | null } }) {
  const r = preview.report;
  const [busy, setBusy] = useState(false);
  const [fontChoice, setFontChoice] = useState<string | null>(edit.font_family ?? null);
  const level = r.level;
  const deleting = !edit.newText.trim();
  const blockId = useTextEdit.getState().selected?.blockId;
  const block = Object.values(useTextEdit.getState().cache)
    .flatMap((c) => c.blocks)
    .find((b) => b.id === blockId && b.lines.map((l) => l.id).join() === edit.lineIds.join());

  const repreview = (patch: Partial<PendingEdit>) => {
    onClose();
    requestPreview({ ...edit, ...patch });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{deleting ? tr("Delete text – preview") : tr("Edit text – preview")}</DialogTitle>
          <DialogDescription>{tr("Review the change before it is written to the document. Your original file is not modified until you save.")}</DialogDescription>
        </DialogHeader>
        <div className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-[12.5px]', level === 'safe' ? 'border-success/40 bg-success/5' : level === 'caution' ? 'border-warning/40 bg-warning/5' : 'border-destructive/40 bg-destructive/5')} data-testid="edit-level">
          {level === 'safe' ? <CheckCircle2 className="h-4 w-4 text-success" /> : level === 'caution' ? <AlertTriangle className="h-4 w-4 text-warning" /> : <ShieldAlert className="h-4 w-4 text-destructive" />}
          <span className="font-medium">{level === 'safe' ? tr("Safe direct replacement") : level === 'caution' ? tr("Direct replacement possible – please review") : tr("Direct replacement is not supported for this text")}</span>
          <span className="ml-auto text-muted-foreground">{tr("Original glyphs are removed; backgrounds, images and graphics are kept.")}</span>
        </div>
        <div className="grid min-h-0 grid-cols-2 gap-3">
          <div className="min-w-0">
            <Label>{tr("Before")}</Label>
            <div className="mt-1 max-h-[34vh] overflow-auto rounded-md border bg-white"><img src={preview.before} alt={tr("Before")} className="h-auto w-full" /></div>
          </div>
          <div className="min-w-0">
            <Label>{tr("After")}</Label>
            <div className="mt-1 max-h-[34vh] overflow-auto rounded-md border bg-white" data-testid="preview-after">
              {preview.after ? <img src={preview.after} alt={tr("After")} className="h-auto w-full" /> : <div className="p-6 text-center text-[12px] text-muted-foreground">{tr("No preview available")}</div>}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 text-[12px]">
          <div className="space-y-1">
            <div className="font-semibold">{tr("Font")}</div>
            <div>{tr("Original:")} <b>{r.font.original}</b> <span className="text-muted-foreground">({tr(STATUS[r.font.status] ?? r.font.status)})</span></div>
            {!deleting && (
              <div>
                {tr("Used:")} <b>{r.font.used}</b> <span className="text-muted-foreground">– {tr(PLAN[r.font.plan] ?? r.font.plan)}</span>
              </div>
            )}
            {!deleting && (
              <div className="flex items-center gap-2 pt-1">
                <span className="shrink-0 text-muted-foreground">{tr("Use another font:")}</span>
                <div className="w-52"><FontPicker value={fontChoice ?? r.font.used ?? ''} onChange={(v) => setFontChoice(v)} /></div>
                {fontChoice && fontChoice !== r.font.used && <Button size="xs" variant="outline" onClick={() => repreview({ font_family: fontChoice })}>{tr("Preview")}</Button>}
              </div>
            )}
            {!deleting && r.layout.single_line && (
              <CheckRow checked={edit.fit === 'shrink'} onChange={(v) => repreview({ fit: v ? 'shrink' : 'overflow' })} label={tr("Shrink to fit the available space")} />
            )}
          </div>
          <div className="space-y-1">
            <div className="font-semibold">{tr("Checks")}</div>
            {r.warnings.length === 0 && <div className="text-success">{tr("No problems found.")}</div>}
            <ul className="space-y-1" data-testid="edit-warnings">
              {r.warnings.map((w, i) => (
                <li key={i} className="flex gap-1.5">
                  <AlertTriangle className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', w.level === 'unsupported' ? 'text-destructive' : w.level === 'caution' ? 'text-warning' : 'text-muted-foreground')} />
                  <span>{w.message}</span>
                </li>
              ))}
            </ul>
            {r.verification && 'ok' in r.verification && (
              <div className={r.verification.ok ? 'text-success' : 'text-destructive'}>
                {r.verification.ok ? tr("Verified: the new text is extractable and other text is intact.") : tr("Verification failed – applying is blocked.")}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          {!deleting && (
            <Button variant="outline" className="mr-auto" onClick={() => {
              onClose();
              fallbackToOverlay(edit, block, block?.lines[0].style);
            }} title={tr("Keep the original text and place the new text in an overlay text box above it")}>
              <Layers className="h-3.5 w-3.5" /> {tr("Use Overlay mode instead")}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button
            disabled={busy || level === 'unsupported' || (r.verification && r.verification.ok === false)}
            onClick={async () => {
              setBusy(true);
              const ok = await applyEdit(edit);
              setBusy(false);
              if (ok) onClose();
            }}
            data-testid="confirm-text-edit"
          >
            {level === 'caution' ? tr("Apply anyway") : deleting ? tr("Delete text") : tr("Apply change")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
