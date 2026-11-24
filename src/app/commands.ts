/* Central command registry used by menus, ribbon and keyboard shortcuts. */
import { bridge } from '@/lib/api';
import { activeDoc, isDirty, useDocuments, type DocState } from '@/stores/documents';
import { useUi } from '@/stores/ui';
import { closeAll, closeDocument, openWithDialog, redo, save, saveAs, undo } from '@/services/docService';
import { clampZoom, stepZoom } from '@/features/viewer/geometry';
import { viewerBus } from '@/features/viewer/viewerBus';
import type { ToolId } from '@/types/editor';
import { printDocument } from '@/services/print';

export interface Command {
  id: string;
  label: string;
  shortcut?: string;
  run: () => unknown;
  enabled?: () => boolean;
  checked?: () => boolean;
}

const hasDoc = () => !!activeDoc();
const docEditable = () => {
  const d = activeDoc();
  return !!d && d.info.owner_authenticated !== false;
};
const withDoc = (fn: (d: DocState) => void | Promise<unknown>) => () => {
  const d = activeDoc();
  if (d) return fn(d);
};
const upd = (patch: Partial<DocState>) => {
  const d = activeDoc();
  if (d) useDocuments.getState().update(d.id, patch);
};

export function setTool(tool: ToolId) {
  const d = activeDoc();
  if (!d) return;
  // a selected form field stays selected in form design (and the radio tool adds to its group)
  const keep = d.selection.kind === 'form' && (tool === 'form-edit' || tool === 'form-radio');
  useDocuments.getState().update(d.id, { tool, selection: keep ? d.selection : { kind: 'none', ids: [] } });
  for (const l of toolListeners) l(tool);
}

const toolListeners = new Set<(tool: ToolId) => void>();
export function onToolChange(l: (tool: ToolId) => void) {
  toolListeners.add(l);
}

export function goToPage(page: number) {
  const d = activeDoc();
  if (!d) return;
  const p = Math.max(0, Math.min(d.info.page_count - 1, page));
  useDocuments.getState().update(d.id, { currentPage: p });
  viewerBus.scrollTo({ docId: d.id, page: p });
}

const registry = new Map<string, Command>();

export function register(cmds: Command[]) {
  for (const c of cmds) registry.set(c.id, c);
}

export function getCommand(id: string): Command | undefined {
  return registry.get(id);
}

export function runCommand(id: string) {
  const c = registry.get(id);
  if (!c) {
    console.warn('unknown command', id);
    return;
  }
  if (c.enabled && !c.enabled()) return;
  return c.run();
}

export function isEnabled(id: string): boolean {
  const c = registry.get(id);
  return !!c && (!c.enabled || c.enabled());
}

const dialog = (type: string, props?: Record<string, unknown>) => () => useUi.getState().openDialog(type, props);

register([
  // ---- File -------------------------------------------------------------------
  { id: 'file.open', label: 'Open…', shortcut: 'Ctrl+O', run: openWithDialog },
  { id: 'file.save', label: 'Save', shortcut: 'Ctrl+S', run: () => save(), enabled: hasDoc },
  { id: 'file.saveAs', label: 'Save As…', shortcut: 'Ctrl+Shift+S', run: () => saveAs(), enabled: hasDoc },
  { id: 'file.close', label: 'Close', shortcut: 'Ctrl+W', run: withDoc((d) => closeDocument(d.id)), enabled: hasDoc },
  { id: 'file.closeAll', label: 'Close All', run: () => closeAll(), enabled: hasDoc },
  {
    id: 'file.print',
    label: 'Print…',
    shortcut: 'Ctrl+P',
    run: withDoc((d) => printDocument(d)),
    enabled: () => {
      const d = activeDoc();
      return !!d && (d.info.owner_authenticated || d.info.permissions?.print !== false);
    },
  },
  { id: 'file.properties', label: 'Document Properties…', shortcut: 'Ctrl+D', run: dialog('properties'), enabled: hasDoc },
  { id: 'file.recover', label: 'Recover Unsaved Documents…', run: dialog('recovery') },
  { id: 'file.exit', label: 'Exit', run: () => window.close() },

  // ---- Edit -------------------------------------------------------------------
  { id: 'edit.undo', label: 'Undo', shortcut: 'Ctrl+Z', run: () => undo(), enabled: () => !!activeDoc()?.undo.length },
  { id: 'edit.redo', label: 'Redo', shortcut: 'Ctrl+Y', run: () => redo(), enabled: () => !!activeDoc()?.redo.length },
  { id: 'edit.find', label: 'Find…', shortcut: 'Ctrl+F', run: () => useUi.getState().setSidebarTab('search'), enabled: hasDoc },
  { id: 'edit.preferences', label: 'Preferences…', shortcut: 'Ctrl+K', run: dialog('settings') },

  // ---- Tools / modes ---------------------------------------------------------------
  { id: 'tool.select', label: 'Select', shortcut: 'V', run: () => setTool('select'), enabled: hasDoc, checked: () => activeDoc()?.tool === 'select' },
  { id: 'tool.hand', label: 'Hand Tool', shortcut: 'H', run: () => setTool('hand'), enabled: hasDoc, checked: () => activeDoc()?.tool === 'hand' },

  // ---- View -------------------------------------------------------------------
  { id: 'view.zoomIn', label: 'Zoom In', shortcut: 'Ctrl+=', run: withDoc((d) => upd({ zoom: stepZoom(d.zoom, 1), zoomMode: 'custom' })), enabled: hasDoc },
  { id: 'view.zoomOut', label: 'Zoom Out', shortcut: 'Ctrl+-', run: withDoc((d) => upd({ zoom: stepZoom(d.zoom, -1), zoomMode: 'custom' })), enabled: hasDoc },
  { id: 'view.actualSize', label: 'Actual Size', shortcut: 'Ctrl+0', run: () => upd({ zoom: 1, zoomMode: 'custom' }), enabled: hasDoc },
  { id: 'view.fitWidth', label: 'Fit Width', shortcut: 'Ctrl+2', run: () => upd({ zoomMode: 'fit-width' }), enabled: hasDoc, checked: () => activeDoc()?.zoomMode === 'fit-width' },
  { id: 'view.fitPage', label: 'Fit Page', shortcut: 'Ctrl+1', run: () => upd({ zoomMode: 'fit-page' }), enabled: hasDoc, checked: () => activeDoc()?.zoomMode === 'fit-page' },
  { id: 'view.single', label: 'Single Page', run: () => upd({ viewMode: 'single' }), enabled: hasDoc, checked: () => activeDoc()?.viewMode === 'single' },
  { id: 'view.continuous', label: 'Continuous', run: () => upd({ viewMode: 'continuous' }), enabled: hasDoc, checked: () => activeDoc()?.viewMode === 'continuous' },
  { id: 'view.twoPage', label: 'Two Pages', run: () => upd({ viewMode: 'two-page' }), enabled: hasDoc, checked: () => activeDoc()?.viewMode === 'two-page' },
  { id: 'view.sidebar', label: 'Navigation Panel', shortcut: 'F4', run: () => useUi.getState().toggleSidebar(), checked: () => useUi.getState().sidebarOpen },
  { id: 'view.properties', label: 'Properties Panel', shortcut: 'Ctrl+E', run: () => useUi.getState().toggleProperties(), checked: () => useUi.getState().propertiesOpen },
  {
    id: 'view.toggleTheme',
    label: 'Dark Theme',
    run: async () => {
      const s = useUi.getState();
      const next = s.resolvedTheme === 'dark' ? 'light' : 'dark';
      s.setSettings(await bridge().settings.set({ theme: next }));
    },
    checked: () => useUi.getState().resolvedTheme === 'dark',
  },
  { id: 'nav.next', label: 'Next Page', shortcut: 'PageDown', run: withDoc((d) => goToPage(d.currentPage + 1)), enabled: hasDoc },
  { id: 'nav.prev', label: 'Previous Page', shortcut: 'PageUp', run: withDoc((d) => goToPage(d.currentPage - 1)), enabled: hasDoc },
  { id: 'nav.first', label: 'First Page', shortcut: 'Home', run: () => goToPage(0), enabled: hasDoc },
  { id: 'nav.last', label: 'Last Page', shortcut: 'End', run: withDoc((d) => goToPage(d.info.page_count - 1)), enabled: hasDoc },
  { id: 'nav.goto', label: 'Go to Page…', shortcut: 'Ctrl+G', run: dialog('goto'), enabled: hasDoc },

  // ---- Help -------------------------------------------------------------------
  { id: 'help.about', label: 'About Offline PDF Editor', run: dialog('about') },
  { id: 'help.privacy', label: 'Privacy & Offline Operation', run: dialog('privacy') },
  { id: 'help.shortcuts', label: 'Keyboard Shortcuts', run: dialog('shortcuts') },
  { id: 'help.devtools', label: 'Developer Tools', run: () => bridge().app.openDevTools() },
]);

export { clampZoom, isDirty, docEditable, hasDoc };
