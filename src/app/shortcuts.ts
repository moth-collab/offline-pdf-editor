/* Global keyboard shortcuts derived from the command registry. */
import { getCommand, runCommand } from './commands';

// Order matters where a key is shared: the first *enabled* command wins
// (Ctrl+D duplicates selected objects, otherwise opens Document Properties).
const SHORTCUT_IDS = () => [
  'edit.duplicate',
  'file.open', 'file.save', 'file.saveAs', 'file.close', 'file.print', 'file.properties',
  'edit.undo', 'edit.redo', 'edit.find', 'edit.preferences', 'edit.copy', 'edit.cut', 'edit.paste', 'edit.delete', 'edit.selectAll',
  'view.zoomIn', 'view.zoomOut', 'view.actualSize', 'view.fitWidth', 'view.fitPage', 'view.sidebar', 'view.properties',
  'nav.next', 'nav.prev', 'nav.first', 'nav.last', 'nav.goto',
  'tool.select', 'tool.hand', 'tool.direct-text', 'tool.add-text', 'tool.escape',
  'page.organizer', 'page.delete', 'page.rotateLeft', 'page.rotateRight', 'doc.addBookmark',
  'overlay.front', 'overlay.back', 'overlay.forward', 'overlay.backward', 'tool.edit-objects',
];

function normalize(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  if (k === '+') k = '=';
  if (k === '_') k = '-';
  if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const combo = normalize(e);
    const typing = isTyping(e.target);
    // inside a dialog, only let the dialog handle keys
    if (document.querySelector('[role="dialog"]')) return;
    for (const id of SHORTCUT_IDS()) {
      const c = getCommand(id);
      if (!c?.shortcut) continue;
      if (id === 'edit.delete') continue;
      const alts = c.shortcut.split(' / ');
      if (!alts.some((a) => a.toUpperCase() === combo.toUpperCase())) continue;
      if (id === 'edit.duplicate' && c.enabled && !c.enabled()) continue;
      const plainKey = !combo.includes('Ctrl') && !combo.includes('Alt');
      if (typing && (plainKey || ['edit.copy', 'edit.cut', 'edit.paste', 'edit.selectAll', 'edit.undo', 'edit.redo', 'edit.delete', 'edit.duplicate'].includes(id))) return;
      e.preventDefault();
      runCommand(id);
      return;
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
