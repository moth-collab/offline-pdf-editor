/* Forms tab: fill, design and manage interactive form fields. */
import { bridge } from '@/lib/api';
import { activeDoc } from '@/stores/documents';
import { toast } from '@/stores/ui';
import type { ToolId } from '@/types/editor';
import { currentForms, flattenForm, resetForm, useForms } from '@/features/forms/service';
import { register, setTool } from './commands';
import { tr } from '@/i18n';

const canEditForm = () => {
  const d = activeDoc();
  return !!d && d.info.owner_authenticated !== false;
};
const hasFields = () => {
  const d = activeDoc();
  return !!d && !!currentForms(d.id)?.fields.length;
};
const formTool = (id: ToolId, label: string) => ({
  id: `tool.${id}`,
  label,
  run: () => setTool(id),
  enabled: canEditForm,
  checked: () => activeDoc()?.tool === id,
});

register([
  {
    id: 'form.fill',
    label: 'Fill In Form',
    run: () => {
      setTool('select');
      useForms.getState().setHighlight(true);
    },
    enabled: () => !!activeDoc(),
  },
  {
    id: 'form.highlight',
    label: 'Highlight Fields',
    run: () => useForms.getState().setHighlight(!useForms.getState().highlight),
    enabled: () => !!activeDoc(),
    checked: () => useForms.getState().highlight,
  },
  formTool('form-edit', 'Edit Form Fields'),
  formTool('form-text', 'Text Field'),
  formTool('form-checkbox', 'Check Box'),
  formTool('form-radio', 'Radio Button'),
  formTool('form-combo', 'Dropdown List'),
  formTool('form-list', 'List Box'),
  formTool('form-signature', 'Signature Field'),
  {
    id: 'form.reset',
    label: 'Reset Form…',
    run: async () => {
      const d = activeDoc();
      if (!d) return;
      const choice = await bridge().dialog.message({
        type: 'question',
        title: tr('Reset form'),
        message: tr('Clear all values entered in this form?'),
        detail: tr('You can undo this with Ctrl+Z until you close the document.'),
        buttons: [tr('Reset'), tr('Cancel')],
        defaultId: 1,
        cancelId: 1,
      });
      if (choice === 0) await resetForm(d.id);
    },
    enabled: hasFields,
  },
  {
    id: 'form.flatten',
    label: 'Flatten Form…',
    run: async () => {
      const d = activeDoc();
      if (!d) return;
      const choice = await bridge().dialog.message({
        type: 'warning',
        title: tr('Flatten form'),
        message: tr('Turn all form fields into normal page content?'),
        detail: tr('The current values stay visible and print as they are, but they can no longer be changed in any PDF reader. You can undo this until you close the document.'),
        buttons: [tr('Flatten'), tr('Cancel')],
        defaultId: 1,
        cancelId: 1,
      });
      if (choice === 0) {
        const res = await flattenForm(d.id);
        if (res) toast('success', tr('Form flattened'), tr('Save the document to keep the change.'));
      }
    },
    enabled: () => canEditForm() && hasFields(),
  },
]);
