/* Header & footer, page numbers and Bates numbering. */
import { bridge, call } from '@/lib/api';
import { activeDoc } from '@/stores/documents';
import { toast, useUi } from '@/stores/ui';
import { runOp } from '@/services/docService';
import { registerDialogs } from '@/components/dialogs/DialogHost';
import { HeaderFooterDialog } from '@/features/header-footer/HeaderFooterDialog';
import { BatchDialog } from '@/features/batch/BatchDialog';
import { CompareDialog } from '@/features/compare/CompareDialog';
import { register } from './commands';
import { tr } from '@/i18n';

registerDialogs({ 'header-footer': HeaderFooterDialog, batch: BatchDialog, compare: CompareDialog });

const editable = () => {
  const d = activeDoc();
  return !!d && d.info.owner_authenticated !== false;
};
const open = (preset: 'page-numbers' | 'bates' | 'custom') => () => useUi.getState().openDialog('header-footer', { preset });

register([
  { id: 'tools.compare', label: 'Compare Documents…', run: () => useUi.getState().openDialog('compare') },
  { id: 'tools.batch', label: 'Batch Processing…', run: () => useUi.getState().openDialog('batch') },
  { id: 'doc.pageNumbers', label: 'Add Page Numbers…', run: open('page-numbers'), enabled: editable },
  { id: 'doc.headerFooter', label: 'Header & Footer…', run: open('custom'), enabled: editable },
  { id: 'doc.bates', label: 'Bates Numbering…', run: open('bates'), enabled: editable },
  {
    id: 'doc.headerFooterRemove',
    label: 'Remove Header & Footer',
    run: async () => {
      const d = activeDoc();
      if (!d) return;
      const state = await call<{ present: boolean }>('doc.headerFooterState', { doc_id: d.id }).catch(() => ({ present: false }));
      if (!state.present) {
        toast('info', tr('Nothing to remove'), tr('This document has no header or footer added by this application'));
        return;
      }
      const choice = await bridge().dialog.message({
        type: 'question',
        title: tr('Remove Header & Footer'),
        message: tr('Remove the headers, footers and page numbers added with this application?'),
        buttons: [tr('Remove'), tr('Cancel')],
        defaultId: 1,
        cancelId: 1,
      });
      if (choice === 0) await runOp(d.id, tr('Remove header & footer'), 'doc.headerFooterRemove', {});
    },
    enabled: editable,
  },
]);
