import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, ShieldCheck, WifiOff, X, XCircle } from 'lucide-react';
import type { AppInfo, AppSettings, RecoverySession } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, NumberInput, Progress, Select, Switch, Tabs, TabsContent, TabsList, TabsTrigger, ColorInput } from '@/components/ui/controls';
import { bridge, call } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import { useActiveDoc } from '@/stores/documents';
import { usePrompt } from '@/stores/prompt';
import { toast, useUi } from '@/stores/ui';
import { goToPage, getCommand } from '@/app/commands';
import { recoverSession, startAutosave } from '@/services/docService';
import { tr } from '@/i18n';

// ---------------------------------------------------------------- prompt
const PERMISSION_LABELS: Record<string, string> = {
  print: 'Printing',
  print_high_quality: 'High-quality printing',
  copy: 'Copying text and images',
  modify: 'Changing the document',
  annotate: 'Commenting',
  fill_forms: 'Filling in forms',
  assemble: 'Page assembly',
  accessibility: 'Accessibility',
};

export function PromptDialog() {
  const cur = usePrompt((s) => s.current);
  const finish = usePrompt((s) => s.finish);
  const [value, setValue] = useState('');
  useEffect(() => setValue(cur?.initial ?? ''), [cur]);
  if (!cur) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && finish(null)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{cur.title}</DialogTitle>
          {cur.message && <DialogDescription>{cur.message}</DialogDescription>}
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            finish(value);
          }}
          className="space-y-1"
        >
          {cur.label && <Label>{cur.label}</Label>}
          <Input autoFocus type={cur.password ? 'password' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} data-testid="prompt-input" />
          <DialogFooter className="pt-3">
            <Button variant="outline" onClick={() => finish(null)}>{tr("Cancel")}</Button>
            <Button type="submit" data-testid="prompt-ok">{cur.okLabel ?? tr("OK")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- toasts / busy
export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-9 right-4 z-[80] flex w-[360px] flex-col gap-2">
      {toasts.map((t) => {
        const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? XCircle : t.kind === 'warning' ? AlertTriangle : Info;
        const color = t.kind === 'success' ? 'text-success' : t.kind === 'error' ? 'text-destructive' : t.kind === 'warning' ? 'text-warning' : 'text-primary';
        return (
          <div key={t.id} className="pointer-events-auto flex gap-2 rounded-lg border bg-popover p-3 shadow-lg" role="status" data-testid={`toast-${t.kind}`}>
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium">{t.title}</div>
              {t.detail && <div className="mt-0.5 break-words text-[11.5px] text-muted-foreground">{t.detail}</div>}
            </div>
            <button className="h-5 rounded p-0.5 hover:bg-muted" onClick={() => dismiss(t.id)} aria-label={tr("Dismiss")}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function BusyOverlay() {
  const busy = useUi((s) => s.busy);
  if (!busy) return null;
  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/20" data-testid="busy-overlay">
      <div className="w-[340px] rounded-lg border bg-popover p-4 shadow-2xl">
        <div className="flex items-center gap-2 text-[12.5px] font-medium">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> {busy.label}
        </div>
        <Progress className="mt-3" value={(busy.progress ?? 0) * 100} indeterminate={busy.progress === undefined || busy.progress === null} />
        {busy.cancel && (
          <div className="mt-3 flex justify-end">
            <Button size="sm" variant="outline" onClick={busy.cancel}>{tr("Cancel")}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- go to page
export function GotoDialog({ onClose }: { onClose: () => void }) {
  const doc = useActiveDoc();
  const [v, setV] = useState('');
  if (!doc) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>{tr("Go to page")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => {
          e.preventDefault();
          const n = parseInt(v, 10);
          if (n >= 1 && n <= doc.info.page_count) {
            goToPage(n - 1);
            onClose();
          }
        }}>
          <Input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder={`1 – ${doc.info.page_count}`} />
          <DialogFooter className="pt-3">
            <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
            <Button type="submit">{tr("Go")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- properties
export function PropertiesDialog({ onClose }: { onClose: () => void }) {
  const doc = useActiveDoc();
  const [fonts, setFonts] = useState<any[] | null>(null);
  useEffect(() => {
    if (doc) call<{ fonts: any[] }>('doc.fonts', { doc_id: doc.id }).then((r) => setFonts(r.fonts)).catch(() => setFonts([]));
  }, [doc?.id, doc?.info.revision]);
  if (!doc) return null;
  const i = doc.info;
  const p0 = i.pages[doc.currentPage];
  const rows: [string, React.ReactNode][] = [
    [tr('File'), i.original_path ?? tr('Not saved yet')],
    [tr('Title'), i.metadata.title ?? '–'],
    [tr('Author'), i.metadata.author ?? '–'],
    [tr('Subject'), i.metadata.subject ?? '–'],
    [tr('Creator'), i.metadata.creator ?? '–'],
    [tr('Producer'), i.metadata.producer ?? '–'],
    [tr('PDF version'), i.metadata.format ?? '–'],
    [tr('Pages'), i.page_count],
    [tr('Page size'), `${(p0.width / 72 * 25.4).toFixed(0)} × ${(p0.height / 72 * 25.4).toFixed(0)} mm (${p0.width.toFixed(0)} × ${p0.height.toFixed(0)} pt)`],
    [tr('File size'), formatBytes(i.file_size)],
    [tr('Security'), i.source_encrypted ? (i.owner_authenticated ? tr('Encrypted (full access)') : tr('Encrypted (restricted)')) : tr('None')],
    [tr('Signatures'), i.has_signatures ? tr('Contains signature fields') : tr('None')],
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{tr("Document properties")}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="desc">
          <TabsList>
            <TabsTrigger value="desc">{tr("Description")}</TabsTrigger>
            <TabsTrigger value="fonts">{tr("Fonts")}</TabsTrigger>
            <TabsTrigger value="security">{tr("Security")}</TabsTrigger>
          </TabsList>
          <TabsContent value="desc" className="mt-3">
            <table className="w-full text-[12.5px]">
              <tbody>
                {rows.map(([k, v]) => (
                  <tr key={k} className="border-b last:border-0">
                    <td className="w-32 py-1 pr-3 text-muted-foreground">{k}</td>
                    <td className="break-all py-1">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TabsContent>
          <TabsContent value="fonts" className="mt-3 max-h-[50vh] overflow-auto">
            {!fonts && <Loader2 className="h-4 w-4 animate-spin" />}
            {fonts && !fonts.length && <p className="text-[12px] text-muted-foreground">{tr("No fonts (image-only document).")}</p>}
            {fonts && fonts.length > 0 && (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1">{tr("Font")}</th><th>{tr("Type")}</th><th>{tr("Status")}</th><th>{tr("On this computer")}</th>
                  </tr>
                </thead>
                <tbody>
                  {fonts.map((f) => (
                    <tr key={f.xref} className="border-t">
                      <td className="py-1 pr-2">{f.name}</td>
                      <td className="pr-2">{f.type}</td>
                      <td className="pr-2">
                        <span className={f.status === 'missing' || f.status === 'unsupported' ? 'text-warning' : ''}>
                          {{ embedded: tr('Embedded'), subset: tr('Embedded subset'), standard: tr('Standard 14'), missing: tr('Not embedded'), unsupported: tr('Type 3 (not editable)') }[f.status as string] ?? f.status}
                        </span>
                      </td>
                      <td>{f.local_font ? f.local_font.family : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TabsContent>
          <TabsContent value="security" className="mt-3 text-[12.5px]">
            {!i.source_encrypted && <p>{tr("This document is not encrypted.")}</p>}
            {i.source_encrypted && i.permissions && (
              <ul className="space-y-1">
                {Object.entries(i.permissions).map(([k, v]) => (
                  <li key={k} className="flex justify-between border-b py-0.5"><span className="capitalize">{tr(PERMISSION_LABELS[k] ?? k.replace(/_/g, ' '))}</span><span>{v ? tr("Allowed") : tr("Not allowed")}</span></li>
                ))}
              </ul>
            )}
            {i.security && <p className="mt-2 text-muted-foreground">{tr("Password protection will be applied when you save.")}</p>}
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button onClick={onClose}>{tr("Close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- recovery
export function RecoveryDialog({ onClose, sessions: initial }: { onClose: () => void; sessions?: RecoverySession[] }) {
  const [sessions, setSessions] = useState<RecoverySession[] | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!initial) call<{ sessions: RecoverySession[] }>('recovery.list').then((r) => setSessions(r.sessions)).catch(() => setSessions([]));
  }, [initial]);
  const restore = async (ids: string[]) => {
    setBusy(true);
    for (const id of ids) await recoverSession(id);
    setBusy(false);
    setSessions((s) => s?.filter((x) => !ids.includes(x.session_id)) ?? null);
  };
  const discard = async (ids: string[]) => {
    for (const id of ids) await call('recovery.discard', { session_id: id }).catch(() => undefined);
    setSessions((s) => s?.filter((x) => !ids.includes(x.session_id)) ?? null);
  };
  useEffect(() => {
    if (sessions && sessions.length === 0 && initial) {
      call('maintenance.cleanupAssets').catch(() => undefined);
      onClose();
    }
  }, [sessions, initial, onClose]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{tr("Recover documents")}</DialogTitle>
          <DialogDescription>{tr("These documents were open when the application stopped unexpectedly. Their working copies are stored locally on this computer.")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-auto rounded-md border" data-testid="recovery-list">
          {sessions === null && <div className="p-4"><Loader2 className="h-4 w-4 animate-spin" /></div>}
          {sessions?.length === 0 && <p className="p-4 text-center text-[12px] text-muted-foreground">{tr("Nothing to recover.")}</p>}
          {sessions?.map((s) => (
            <div key={s.session_id} className="flex items-center gap-3 border-b px-3 py-2 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium">{s.display_name}</div>
                <div className="truncate text-[11px] text-muted-foreground">{s.original_path ?? tr("Never saved")} {tr("· last change")} {new Date(s.updated * 1000).toLocaleString()} {s.unsaved ? tr("· unsaved changes") : ''}</div>
              </div>
              <Button size="sm" disabled={busy} onClick={() => restore([s.session_id])}>{tr("Recover")}</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => discard([s.session_id])}>{tr("Discard")}</Button>
            </div>
          ))}
        </div>
        <DialogFooter>
          {!!sessions?.length && (
            <>
              <Button variant="outline" disabled={busy} onClick={() => discard(sessions.map((s) => s.session_id))}>{tr("Discard all")}</Button>
              <Button disabled={busy} onClick={() => restore(sessions.map((s) => s.session_id))}>{tr("Recover all")}</Button>
            </>
          )}
          <Button variant="ghost" onClick={onClose}>{tr("Close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- settings
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useUi((s) => s.settings);
  const setSettings = useUi((s) => s.setSettings);
  const [fonts, setFonts] = useState<{ family: string }[]>([]);
  const [caps, setCaps] = useState<any>(null);
  useEffect(() => {
    call<{ families: { family: string }[] }>('fonts.list').then((r) => setFonts(r.families)).catch(() => undefined);
    call('app.capabilities').then(setCaps).catch(() => undefined);
  }, []);
  const set = async (patch: Partial<AppSettings>) => {
    const next = await bridge().settings.set(patch);
    setSettings(next);
    if ('autosaveEnabled' in patch || 'autosaveIntervalSec' in patch) startAutosave();
  };
  const row = (label: string, control: React.ReactNode, hint?: string) => (
    <div className="flex items-center justify-between gap-4 border-b py-2 last:border-0">
      <div>
        <div className="text-[12.5px]">{label}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="w-56 shrink-0">{control}</div>
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide className="h-[560px]">
        <DialogHeader>
          <DialogTitle>{tr("Preferences")}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="self-start">
            <TabsTrigger value="general">{tr("General")}</TabsTrigger>
            <TabsTrigger value="editing">{tr("Editing")}</TabsTrigger>
            <TabsTrigger value="performance">{tr("Performance")}</TabsTrigger>
            <TabsTrigger value="privacy">{tr("Privacy")}</TabsTrigger>
            <TabsTrigger value="ocr">{tr("OCR")}</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-auto pt-2">
            <TabsContent value="general">
              {row(tr("Language"), <Select value={settings.language} onValueChange={(v) => set({ language: v as any })} options={[{ value: 'en', label: 'English', raw: true }, { value: 'th', label: 'ไทย (Thai)', raw: true }]} />, tr("Interface language"))}
              {row(tr("Author name"), <Input value={settings.authorName} onChange={(e) => set({ authorName: e.target.value })} />, tr("Shown on your comments"))}
              {row(tr("Theme"), <Select value={settings.theme} onValueChange={(v) => set({ theme: v as any })} options={[{ value: 'light', label: tr("Light") }, { value: 'dark', label: tr("Dark") }, { value: 'system', label: tr("Follow Windows") }]} />)}
              {row(tr("Default save folder"), (
                <div className="flex gap-1">
                  <Input value={settings.defaultSaveDir} readOnly placeholder={tr("Documents")} />
                  <Button size="sm" variant="outline" onClick={async () => {
                    const f = await bridge().dialog.folder(tr("Default save folder"));
                    if (f) set({ defaultSaveDir: f.path });
                  }}>…</Button>
                </div>
              ))}
              {row(tr("Recent files to remember"), <NumberInput value={settings.recentLimit} onChange={(v) => set({ recentLimit: Math.round(v) })} min={0} max={50} />, tr("0 disables the recent files list"))}
              {row(tr("Clear recent files"), <Button size="sm" variant="outline" onClick={() => bridge().recent.clear().then(() => toast('success', tr("Recent files cleared")))}>{tr("Clear now")}</Button>)}
              {row(tr("Autosave recovery data"), <Switch checked={settings.autosaveEnabled} onCheckedChange={(v) => set({ autosaveEnabled: v })} />, tr("Keeps unsaved work recoverable after a crash"))}
              {row(tr("Autosave interval"), <NumberInput value={settings.autosaveIntervalSec} onChange={(v) => set({ autosaveIntervalSec: Math.round(v) })} min={5} max={3600} suffix="s" />)}
              {row(tr("Keep backup when overwriting"), <Switch checked={settings.makeBackups} onCheckedChange={(v) => set({ makeBackups: v })} />, tr("The previous version is kept in the local backups folder"))}
            </TabsContent>
            <TabsContent value="editing">
              {row(tr("Default font"), <Select value={settings.defaultFont} onValueChange={(v) => set({ defaultFont: v })} options={(fonts.length ? fonts : [{ family: settings.defaultFont }]).map((f) => ({ value: f.family, label: f.family }))} />)}
              {row(tr("Default font size"), <NumberInput value={settings.defaultFontSize} onChange={(v) => set({ defaultFontSize: v })} min={1} max={500} suffix="pt" />)}
              {row(tr("Default text color"), <ColorInput value={settings.defaultTextColor} onChange={(v) => v && set({ defaultTextColor: v })} />)}
              {row(tr("Default editing mode"), <Select value={settings.defaultEditMode} onValueChange={(v) => set({ defaultEditMode: v as any })} options={[{ value: 'select', label: tr("Select") }, { value: 'hand', label: tr("Hand") }, { value: 'direct-text', label: tr("Direct Edit") }, { value: 'add-text', label: tr("Add Text / Overlay") }]} />)}
            </TabsContent>
            <TabsContent value="performance">
              {row(tr("Rendering quality"), <Select value={settings.renderQuality} onValueChange={(v) => set({ renderQuality: v as any })} options={[{ value: 'standard', label: tr("Standard (faster)") }, { value: 'high', label: tr("High") }, { value: 'maximum', label: tr("Maximum (sharpest)") }]} />)}
              {row(tr("Render cache size"), <NumberInput value={settings.cacheSizeMB} onChange={(v) => set({ cacheSizeMB: Math.round(v) })} min={32} max={4096} suffix="MB" />)}
              {row(tr("Undo history per document"), <NumberInput value={settings.maxRevisions} onChange={(v) => set({ maxRevisions: Math.round(v) })} min={5} max={500} />, tr("Working copies kept on disk; takes effect after restart"))}
            </TabsContent>
            <TabsContent value="privacy">
              <div className="mb-2 flex items-start gap-2 rounded-md border border-success/40 bg-success/5 p-3 text-[12px]">
                <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <div>
                  <div className="font-medium">{tr("Offline mode is always on")}</div>
                  <div className="text-muted-foreground">{tr("Documents are processed only on this computer. The application has no telemetry, no account and no cloud services. Network access from the interface is blocked.")}</div>
                </div>
              </div>
              {row(tr("Telemetry"), <span className="text-[12px] text-muted-foreground">{tr("Not included")}</span>)}
              {row(tr("Clean temporary files on exit"), <Switch checked={settings.cleanupTempOnExit} onCheckedChange={(v) => set({ cleanupTempOnExit: v })} />)}
              {row(tr("Keep recovery data for"), <NumberInput value={settings.recoveryRetentionDays} onChange={(v) => set({ recoveryRetentionDays: Math.round(v) })} min={1} max={90} suffix="days" />)}
              {row(tr("Ask before opening web links"), <Switch checked={settings.confirmExternalLinks} onCheckedChange={(v) => set({ confirmExternalLinks: v })} />)}
            </TabsContent>
            <TabsContent value="ocr">
              {row(tr("Default language"), <Select value={settings.ocrLanguage} onValueChange={(v) => set({ ocrLanguage: v })} options={[{ value: 'tha+eng', label: tr("Thai + English") }, { value: 'tha', label: tr("Thai") }, { value: 'eng', label: tr("English") }]} />)}
              {row(tr("OCR quality"), <Select value={String(settings.ocrDpi)} onValueChange={(v) => set({ ocrDpi: parseInt(v, 10) })} options={[{ value: '200', label: tr("Fast (200 dpi)") }, { value: '300', label: tr("Standard (300 dpi)") }, { value: '400', label: tr("Best (400 dpi)") }]} />)}
              {row(tr("Language data"), caps?.ocr ? (
                <div className="text-[12px]">
                  {caps.ocr.available ? <span className="flex items-center gap-1 text-success"><ShieldCheck className="h-3.5 w-3.5" /> {tr("Installed:")} {caps.ocr.languages?.join(', ')}</span> : <span className="text-warning">{tr("OCR engine not found")}</span>}
                  {caps.ocr.version && <div className="text-muted-foreground">{tr("Tesseract")} {caps.ocr.version}</div>}
                </div>
              ) : <Loader2 className="h-4 w-4 animate-spin" />)}
            </TabsContent>
          </div>
        </Tabs>
        <DialogFooter>
          <Button onClick={onClose}>{tr("Done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- about / privacy / shortcuts
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    bridge().app.info().then(setInfo);
  }, []);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{tr("Offline PDF Editor")}</DialogTitle>
          <DialogDescription>{tr("A professional PDF editor that works entirely on your computer.")}</DialogDescription>
        </DialogHeader>
        {info && (
          <div className="space-y-0.5 text-[12px]">
            <div>{tr("Version")} {info.version}</div>
            <div className="text-muted-foreground">{tr("Electron")} {info.electron} {tr("· Chromium")} {info.chrome} · {info.platform}</div>
            <div className="text-muted-foreground">{tr("Processing engine:")} {info.backend.state}</div>
            <div className="break-all text-muted-foreground">{tr("Local data:")} {info.userData}</div>
          </div>
        )}
        <p className="text-[11.5px] text-muted-foreground">{tr("Uses PDF.js, PyMuPDF/MuPDF, pikepdf/qpdf, pypdf, Pillow, HarfBuzz, fontTools, Tesseract OCR, pyHanko and open-source fonts. See the bundled licenses.")}</p>
        <div className="rounded-md border bg-muted/40 p-2 text-[11.5px]" data-testid="about-license">
          <p>Copyright © 2026 Offline PDF Editor contributors</p>
          <p className="mt-1">{tr("This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3 or (at your option) any later version.")}</p>
          <p className="mt-1">{tr("It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.")}</p>
          <p className="mt-1">{tr("The complete source code and the licence text are included with the program.")}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => bridge().app.showSourceCode()} data-testid="about-source">{tr("Source code & licence")}</Button>
          <Button onClick={onClose}>{tr("Close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PrivacyDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Privacy & offline operation")}</DialogTitle>
        </DialogHeader>
        <ul className="list-disc space-y-1.5 pl-5 text-[12.5px]">
          <li>{tr("All PDF processing (editing, OCR, conversion, compression, signing, redaction) runs locally.")}</li>
          <li>{tr("No document content, file names or usage data are sent anywhere. There is no telemetry and no account.")}</li>
          <li>{tr("The interface cannot make network requests; the processing engine only listens on this computer (127.0.0.1) and requires a secret key generated at each start.")}</li>
          <li>{tr("Working copies and recovery data are stored in your user profile and deleted when you close a document.")}</li>
          <li>{tr("Your original file is only changed when you save, using a safe atomic replace with a backup.")}</li>
          <li>{tr("Web links inside documents open only after you confirm.")}</li>
        </ul>
        <DialogFooter>
          <Button onClick={onClose}>{tr("Close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const ids = ['file.open', 'file.save', 'file.saveAs', 'file.print', 'file.close', 'edit.undo', 'edit.redo', 'edit.find', 'edit.copy', 'edit.paste', 'edit.delete', 'tool.select', 'tool.hand', 'tool.direct-text', 'tool.add-text', 'view.zoomIn', 'view.zoomOut', 'view.actualSize', 'view.fitPage', 'view.fitWidth', 'nav.next', 'nav.prev', 'nav.goto', 'view.sidebar', 'page.organizer', 'edit.preferences'];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Keyboard shortcuts")}</DialogTitle>
        </DialogHeader>
        <div className="grid max-h-[60vh] grid-cols-2 gap-x-6 overflow-auto text-[12px]">
          {ids.map((id) => getCommand(id)).filter((c) => c?.shortcut).map((c) => (
            <div key={c!.id} className="flex justify-between border-b py-1">
              <span>{tr(c!.label).replace('…', '')}</span>
              <kbd className="font-mono text-[11px] text-muted-foreground">{c!.shortcut}</kbd>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{tr("Close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
