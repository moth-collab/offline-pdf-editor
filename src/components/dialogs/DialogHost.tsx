/* Renders the currently open application dialog. Features register their
 * dialog components here by type. */
import type { ComponentType } from 'react';
import { useUi } from '@/stores/ui';
import { AboutDialog, GotoDialog, PrivacyDialog, PropertiesDialog, RecoveryDialog, SettingsDialog, ShortcutsDialog } from './AppDialogs';
import { CropDialog, ExtractDialog, ImagesToPdfDialog, InsertBlankDialog, MergeDialog, MovePagesDialog, ResizeDialog, SplitDialog } from '@/features/page-organizer/dialogs';

const REGISTRY: Record<string, ComponentType<any>> = {
  about: AboutDialog,
  privacy: PrivacyDialog,
  shortcuts: ShortcutsDialog,
  settings: SettingsDialog,
  properties: PropertiesDialog,
  goto: GotoDialog,
  recovery: RecoveryDialog,
  'insert-blank': InsertBlankDialog,
  'move-pages': MovePagesDialog,
  crop: CropDialog,
  resize: ResizeDialog,
  extract: ExtractDialog,
  merge: MergeDialog,
  split: SplitDialog,
  'images-to-pdf': ImagesToPdfDialog,
};

export function registerDialogs(entries: Record<string, ComponentType<any>>) {
  Object.assign(REGISTRY, entries);
}

export function DialogHost() {
  const dialog = useUi((s) => s.dialog);
  const close = useUi((s) => s.closeDialog);
  if (!dialog) return null;
  const C = REGISTRY[dialog.type];
  if (!C) return null;
  return <C key={dialog.type} onClose={close} {...(dialog.props ?? {})} />;
}
