import { useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import type { FileRef, RecoverySession } from '@shared/types';
import { TooltipProvider } from '@/components/ui/controls';
import { TitleBar } from '@/components/layout/TitleBar';
import { Ribbon } from '@/components/layout/Ribbon';
import { DocumentTabs } from '@/components/layout/DocumentTabs';
import { Sidebar } from '@/components/layout/Sidebar';
import { PropertiesPanel } from '@/components/layout/PropertiesPanel';
import { StatusBar } from '@/components/layout/StatusBar';
import { StartScreen } from '@/components/layout/StartScreen';
import { BusyOverlay, PromptDialog, Toasts } from '@/components/dialogs/AppDialogs';
import { DialogHost } from '@/components/dialogs/DialogHost';
import { PdfViewer } from '@/features/viewer/PdfViewer';
import { PageOrganizer } from '@/features/page-organizer/dialogs';
import { bridge, call, droppedPaths } from '@/lib/api';
import { useActiveDoc } from '@/stores/documents';
import { toast, useUi } from '@/stores/ui';
import { closeAll, openFiles, refreshInfo, startAutosave } from '@/services/docService';
import { installShortcuts } from '@/app/shortcuts';
import { useDocuments } from '@/stores/documents';
import { setLanguage, tr } from '@/i18n';

function useTheme() {
  const theme = useUi((s) => s.settings.theme);
  const setResolved = useUi((s) => s.setResolvedTheme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches);
      document.documentElement.classList.toggle('dark', dark);
      setResolved(dark ? 'dark' : 'light');
      bridge().app.setTitleBarTheme(dark ? 'dark' : 'light');
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme, setResolved]);
}

function useAppLifecycle() {
  useEffect(() => {
    const api = bridge();
    const offs: (() => void)[] = [];
    api.settings.get().then((s) => {
      useUi.getState().setSettings(s);
      startAutosave();
    });
    api.app.info().then((i) => useUi.getState().setBackend(i.backend));
    offs.push(
      api.on('backend:status', (s) => {
        const prev = useUi.getState().backend.state;
        useUi.getState().setBackend(s);
        if (s.state === 'ready' && prev !== 'ready' && prev !== 'starting') {
          toast('warning', tr("The processing engine was restarted"), tr("Your open documents were reloaded from their local working copies."));
        }
        if (s.reattached) for (const id of useDocuments.getState().order) refreshInfo(id).catch(() => undefined);
        if (s.state === 'ready' && prev === 'starting') checkRecovery();
        if (s.state === 'failed') toast('error', tr("The processing engine stopped"), s.message);
      }),
    );
    offs.push(api.on('app:open-files', (refs: FileRef[]) => openFiles(refs)));
    offs.push(
      api.on('app:close-requested', async () => {
        const ok = await closeAll();
        if (ok) api.app.readyToClose();
      }),
    );
    offs.push(installShortcuts());
    // in case the engine was already ready before we subscribed
    api.app.info().then((i) => {
      if (i.backend.state === 'ready') checkRecovery();
    });
    return () => offs.forEach((o) => o());
  }, []);
}

let recoveryChecked = false;
async function checkRecovery() {
  if (recoveryChecked) return;
  recoveryChecked = true;
  try {
    const r = await call<{ sessions: RecoverySession[] }>('recovery.list');
    if (r.sessions.length) useUi.getState().openDialog('recovery', { sessions: r.sessions });
    else call('maintenance.cleanupAssets').catch(() => undefined);
  } catch {
    /* engine not ready */
  }
}

function DropZone({ children }: { children: React.ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className="relative flex min-h-0 flex-1"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOver(false);
      }}
      onDrop={async (e) => {
        setOver(false);
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        const paths = droppedPaths(e.dataTransfer.files);
        const refs = await bridge().files.registerDropped(paths);
        if (refs.length < paths.length) toast('warning', tr("Some files were ignored"), tr("Only PDF documents and images can be opened."));
        if (refs.length) openFiles(refs);
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5">
          <div className="flex items-center gap-2 rounded-lg bg-background px-4 py-2 text-[13px] font-medium shadow">
            <Upload className="h-4 w-4 text-primary" /> {tr("Drop PDF or image files to open")}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  useTheme();
  useAppLifecycle();
  const doc = useActiveDoc();
  const organizer = useUi((s) => s.organizerOpen);
  // Language is applied before children render; the keyed subtree re-mounts
  // so every label is re-evaluated (document state lives in the stores).
  const language = useUi((s) => s.settings.language);
  setLanguage(language === 'th' ? 'th' : 'en');
  return (
    <TooltipProvider key={language} delayDuration={500}>
      <div className="flex h-full flex-col">
        <TitleBar />
        <Ribbon />
        <DocumentTabs />
        <DropZone>
          {doc ? (
            <>
              <Sidebar doc={doc} />
              <main className="relative min-w-0 flex-1">{organizer ? <PageOrganizer /> : <PdfViewer key={doc.id} doc={doc} />}</main>
              <PropertiesPanel doc={doc} />
            </>
          ) : (
            <main className="min-w-0 flex-1">
              <StartScreen />
            </main>
          )}
        </DropZone>
        <StatusBar />
      </div>
      <DialogHost />
      <PromptDialog />
      <BusyOverlay />
      <Toasts />
    </TooltipProvider>
  );
}
