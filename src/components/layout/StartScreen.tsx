import { useEffect, useState } from 'react';
import { Clock, FileText, FolderOpen, Images, Combine, Star, WifiOff, X } from 'lucide-react';
import type { RecentFile } from '@shared/types';
import { Button } from '@/components/ui/button';
import { bridge } from '@/lib/api';
import { openDocument, openWithDialog } from '@/services/docService';
import { runCommand } from '@/app/commands';
import { useUi } from '@/stores/ui';
import { tr } from '@/i18n';

/** Windows: suggest making this the default PDF app (the user confirms in Settings). */
function DefaultAppBanner() {
  const dismissed = useUi((s) => s.settings.defaultAppPromptDismissed);
  const [show, setShow] = useState(false);
  useEffect(() => {
    bridge().app.defaultPdfApp().then((st) => setShow(st.supported && !st.isDefault)).catch(() => undefined);
  }, []);
  if (!show || dismissed) return null;
  const dismiss = async () => useUi.getState().setSettings(await bridge().settings.set({ defaultAppPromptDismissed: true }));
  return (
    <div className="mb-6 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3" data-testid="default-app-banner">
      <Star className="h-5 w-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{tr('Open PDF files with Offline PDF Editor')}</div>
        <div className="text-[11.5px] text-muted-foreground">{tr('Double-click any PDF to open it here. Windows asks you to confirm the choice once in Settings.')}</div>
      </div>
      <Button size="sm" onClick={() => bridge().app.makeDefaultPdfApp()}>{tr('Set as default')}</Button>
      <Button size="sm" variant="ghost" onClick={dismiss}>{tr('Not now')}</Button>
    </div>
  );
}

export function StartScreen() {
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const load = () => bridge().recent.list().then(setRecent).catch(() => setRecent([]));
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="flex h-full items-start justify-center overflow-auto bg-workspace p-10" data-testid="start-screen">
      <div className="w-full max-w-3xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand text-white shadow">
            <FileText className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-[20px] font-semibold">{tr("Offline PDF Editor")}</h1>
            <p className="flex items-center gap-1 text-[12px] text-muted-foreground">
              <WifiOff className="h-3 w-3" /> {tr("Your documents never leave this computer.")}
            </p>
          </div>
        </div>
        <DefaultAppBanner />
        <div className="mb-6 grid grid-cols-3 gap-3">
          <button className="flex items-center gap-3 rounded-lg border bg-background p-4 text-left shadow-sm hover:border-primary" onClick={openWithDialog} data-testid="start-open">
            <FolderOpen className="h-6 w-6 text-primary" />
            <div>
              <div className="text-[13px] font-medium">{tr("Open PDF")}</div>
              <div className="text-[11.5px] text-muted-foreground">{tr("Ctrl+O, or drop files here")}</div>
            </div>
          </button>
          <button className="flex items-center gap-3 rounded-lg border bg-background p-4 text-left shadow-sm hover:border-primary" onClick={() => runCommand('doc.merge')}>
            <Combine className="h-6 w-6 text-primary" />
            <div>
              <div className="text-[13px] font-medium">{tr("Merge files")}</div>
              <div className="text-[11.5px] text-muted-foreground">{tr("Combine several PDFs")}</div>
            </div>
          </button>
          <button className="flex items-center gap-3 rounded-lg border bg-background p-4 text-left shadow-sm hover:border-primary" onClick={() => runCommand('file.createFromImages')}>
            <Images className="h-6 w-6 text-primary" />
            <div>
              <div className="text-[13px] font-medium">{tr("Images to PDF")}</div>
              <div className="text-[11.5px] text-muted-foreground">{tr("JPG, PNG, TIFF…")}</div>
            </div>
          </button>
        </div>
        <div className="rounded-lg border bg-background shadow-sm">
          <div className="flex items-center gap-2 border-b px-4 py-2 text-[12.5px] font-semibold">
            <Clock className="h-3.5 w-3.5" /> {tr("Recent files")}
            {recent.length > 0 && (
              <Button size="xs" variant="ghost" className="ml-auto" onClick={() => bridge().recent.clear().then(load)}>
                {tr("Clear")}
              </Button>
            )}
          </div>
          {recent.length === 0 && <p className="p-6 text-center text-[12px] text-muted-foreground">{tr("Files you open will appear here.")}</p>}
          {recent.map((r) => (
            <div key={r.path} className="group flex items-center gap-3 border-b px-4 py-2 last:border-0 hover:bg-muted/60">
              <FileText className="h-4 w-4 shrink-0 text-brand" />
              <button
                className="min-w-0 flex-1 text-left disabled:opacity-50"
                disabled={!r.exists}
                onClick={() => r.token && openDocument({ token: r.token, name: r.name, path: r.path })}
                data-testid="recent-item"
              >
                <div className="truncate text-[12.5px]">{r.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">{r.exists ? r.path : tr("{0} (missing)", r.path)}</div>
              </button>
              <span className="text-[11px] text-muted-foreground">{new Date(r.openedAt).toLocaleDateString()}</span>
              <button className="invisible rounded p-1 hover:bg-background group-hover:visible" onClick={() => bridge().recent.remove(r.path).then(load)} aria-label={tr("Remove from list")}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
