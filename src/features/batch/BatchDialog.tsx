/* Batch processing: apply one action to many PDF files at once. */
import { useState } from 'react';
import { CheckCircle2, FolderOpen, Trash2, XCircle } from 'lucide-react';
import type { FileRef } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CheckRow, Input, Label, NumberInput, RadioGroup, Select, Slider } from '@/components/ui/controls';
import { bridge, errorMessage } from '@/lib/api';
import { toast, useUi } from '@/stores/ui';
import { JobCancelled, disposeJob, runJob } from '@/services/jobs';
import { getLanguage, tr } from '@/i18n';

type Action = 'ocr' | 'compress' | 'header-footer' | 'watermark' | 'protect' | 'sanitize' | 'flatten' | 'docx';

interface BatchResult {
  action: Action;
  results: { file: string; status: 'ok' | 'error'; output: string | null; message: string }[];
  ok: number;
  failed: number;
  cancelled: boolean;
}

export function BatchDialog({ onClose }: { onClose: () => void }) {
  const settings = useUi((s) => s.settings);
  const th = getLanguage() === 'th';
  const [files, setFiles] = useState<FileRef[]>([]);
  const [action, setAction] = useState<Action>('compress');
  const [folder, setFolder] = useState<FileRef | null>(null);
  const [language, setLanguage] = useState(settings.ocrLanguage || 'tha+eng');
  const [preset, setPreset] = useState('recommended');
  const [footer, setFooter] = useState(th ? 'หน้า {page} จาก {total}' : 'Page {page} of {total}');
  const [useBates, setUseBates] = useState(false);
  const [bates, setBates] = useState({ prefix: '', start: 1, digits: 6, suffix: '' });
  const [wmText, setWmText] = useState(th ? 'ลับ' : 'CONFIDENTIAL');
  const [wmOpacity, setWmOpacity] = useState(0.2);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [result, setResult] = useState<BatchResult | null>(null);

  const addFiles = async () => {
    const refs = await bridge().dialog.open('pdfs', tr('Choose PDF files'));
    const known = new Set(files.map((f) => f.path));
    setFiles([...files, ...refs.filter((r) => !known.has(r.path))]);
    setResult(null);
  };

  const options = (): Record<string, unknown> => {
    switch (action) {
      case 'ocr':
        return { language, dpi: settings.ocrDpi || 300, only_scanned: true };
      case 'compress':
        return { preset };
      case 'header-footer':
        return useBates ? { 'bottom-right': '{bates}', bates } : { 'bottom-center': footer, font: th ? 'Sarabun' : settings.defaultFont };
      case 'watermark':
        return { text: wmText, opacity: wmOpacity, rotation: 45, position: 'center', size: 60 };
      case 'protect':
        return { user_password: pw };
      default:
        return {};
    }
  };

  const invalid =
    !files.length ||
    !folder ||
    (action === 'protect' && (pw.length < 1 || pw !== pw2)) ||
    (action === 'watermark' && !wmText.trim()) ||
    (action === 'header-footer' && !useBates && !footer.trim());

  const run = async () => {
    if (!folder) return;
    try {
      const j = await runJob<BatchResult>('batch', tr('Processing files'), undefined, {
        mode: action,
        files_in_tokens: files.map((f) => f.token),
        output_dir_token: folder.token,
        options: options(),
      });
      disposeJob(j.job_id);
      setResult(j.result);
      toast(j.result.failed ? 'warning' : 'success', tr('Batch finished'), tr('{0} succeeded, {1} failed', j.result.ok, j.result.failed));
    } catch (e) {
      if (!(e instanceof JobCancelled)) toast('error', tr('Batch processing failed'), errorMessage(e));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{tr('Batch processing')}</DialogTitle>
          <DialogDescription>{tr('Apply one action to many PDF files. Results are saved as new files in the folder you choose; the original files are never changed.')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[1fr_1fr] gap-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{tr('Files ({0})', files.length)}</Label>
              <Button size="sm" variant="outline" onClick={addFiles} data-testid="batch-add">
                {tr('Add files…')}
              </Button>
            </div>
            <div className="h-[220px] overflow-auto rounded-md border text-[12px]" data-testid="batch-files">
              {!files.length && <div className="p-3 text-muted-foreground">{tr('No files added yet.')}</div>}
              {files.map((f) => {
                const r = result?.results.find((x) => x.file === f.name);
                return (
                  <div key={f.token} className="flex items-center gap-2 border-b px-2 py-1 last:border-0">
                    {r && (r.status === 'ok' ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" /> : <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />)}
                    <div className="min-w-0 flex-1">
                      <div className="truncate" title={f.path}>
                        {f.name}
                      </div>
                      {r && <div className="truncate text-[11px] text-muted-foreground">{r.status === 'ok' ? `→ ${r.output}` : tr(r.message)}</div>}
                    </div>
                    <button className="rounded p-0.5 hover:bg-muted" onClick={() => setFiles(files.filter((x) => x !== f))} aria-label={tr('Remove from list')}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="space-y-1">
              <Label>{tr('Save results to')}</Label>
              <div className="flex gap-2">
                <Input readOnly value={folder?.path ?? ''} placeholder={tr('Choose a folder')} />
                <Button variant="outline" onClick={async () => setFolder((await bridge().dialog.folder(tr('Choose the output folder'))) ?? folder)} data-testid="batch-folder">
                  {tr('Browse…')}
                </Button>
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{tr('Action')}</Label>
            <RadioGroup
              value={action}
              onValueChange={(v) => {
                setAction(v as Action);
                setResult(null);
              }}
              options={[
                { value: 'compress', label: tr('Compress') },
                { value: 'ocr', label: tr('Make scanned files searchable (OCR)') },
                { value: 'header-footer', label: tr('Add page numbers or Bates numbers') },
                { value: 'watermark', label: tr('Add a watermark') },
                { value: 'protect', label: tr('Protect with a password') },
                { value: 'sanitize', label: tr('Remove hidden information') },
                { value: 'flatten', label: tr('Flatten forms and comments') },
                { value: 'docx', label: tr('Convert to Word') },
              ]}
            />
            <div className="rounded-md border p-2" data-testid="batch-options">
              {action === 'compress' && (
                <Select
                  value={preset}
                  onValueChange={setPreset}
                  options={[
                    { value: 'low', label: tr('Low compression') },
                    { value: 'recommended', label: tr('Recommended') },
                    { value: 'high', label: tr('High compression') },
                  ]}
                />
              )}
              {action === 'ocr' && (
                <div className="space-y-1">
                  <Select
                    value={language}
                    onValueChange={setLanguage}
                    options={[
                      { value: 'tha+eng', label: tr('Thai + English') },
                      { value: 'tha', label: tr('Thai') },
                      { value: 'eng', label: tr('English') },
                    ]}
                  />
                  <div className="text-[11px] text-muted-foreground">{tr('Only pages without text are recognised.')}</div>
                </div>
              )}
              {action === 'header-footer' && (
                <div className="space-y-2">
                  <CheckRow checked={useBates} onChange={setUseBates} label={tr('Bates numbers that continue across all files')} />
                  {useBates ? (
                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-1">
                        <Label>{tr('Prefix')}</Label>
                        <Input value={bates.prefix} onChange={(e) => setBates({ ...bates, prefix: e.target.value })} placeholder="CASE-" />
                      </div>
                      <div className="space-y-1">
                        <Label>{tr('First number')}</Label>
                        <NumberInput value={bates.start} onChange={(v) => setBates({ ...bates, start: Math.max(0, Math.round(v)) })} min={0} />
                      </div>
                      <div className="space-y-1">
                        <Label>{tr('Digits')}</Label>
                        <NumberInput value={bates.digits} onChange={(v) => setBates({ ...bates, digits: Math.min(12, Math.max(1, Math.round(v))) })} min={1} max={12} />
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <Label>{tr('Footer text')}</Label>
                      <Input value={footer} onChange={(e) => setFooter(e.target.value)} />
                    </div>
                  )}
                </div>
              )}
              {action === 'watermark' && (
                <div className="space-y-2">
                  <Input value={wmText} onChange={(e) => setWmText(e.target.value)} placeholder={tr('Watermark text')} />
                  <div className="flex items-center gap-2">
                    <Label className="w-20">{tr('Opacity')}</Label>
                    <Slider value={[wmOpacity]} min={0.05} max={1} step={0.05} onValueChange={([v]) => setWmOpacity(v)} />
                  </div>
                </div>
              )}
              {action === 'protect' && (
                <div className="space-y-1">
                  <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={tr('Password')} data-testid="batch-pw" />
                  <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder={tr('Confirm password')} data-testid="batch-pw2" />
                  {pw2 && pw !== pw2 && <div className="text-[11.5px] text-warning">{tr('The passwords do not match')}</div>}
                </div>
              )}
              {['sanitize', 'flatten', 'docx'].includes(action) && <div className="text-[12px] text-muted-foreground">{tr('No options.')}</div>}
            </div>
          </div>
        </div>
        {result && (
          <div className="rounded-md bg-muted/50 p-2 text-[12px]" data-testid="batch-summary">
            {tr('{0} succeeded, {1} failed', result.ok, result.failed)}
            {result.cancelled ? ` · ${tr('Cancelled')}` : ''}
          </div>
        )}
        <DialogFooter>
          {result && folder && (
            <Button variant="outline" onClick={() => bridge().app.showItemInFolder(folder.token)}>
              <FolderOpen className="mr-1 h-3.5 w-3.5" /> {tr('Open folder')}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            {tr('Close')}
          </Button>
          <Button onClick={run} disabled={invalid} data-testid="batch-run">
            {tr('Start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
