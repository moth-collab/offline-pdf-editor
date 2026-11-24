/* Convert / Protect commands (Phase 6). */
import type { DocumentInfo } from '@shared/types';
import { bridge, call, errorMessage } from '@/lib/api';
import { activeDoc, useDocuments } from '@/stores/documents';
import { toast, useUi } from '@/stores/ui';
import { askText } from '@/stores/prompt';
import { applyInfo } from '@/services/docService';
import { registerDialogs } from '@/components/dialogs/DialogHost';
import { CompressDialog, ConvertDialog, OcrDialog } from '@/features/conversion/dialogs';
import { ApplyRedactionsDialog, PasswordDialog, RedactSearchDialog, SanitizeDialog, WatermarkDialog } from '@/features/security/dialogs';
import { CreateIdDialog, DigitalSignDialog, SignatureDialog, ValidateDialog } from '@/features/signatures/dialogs';
import { register, setTool } from './commands';
import { tr } from '@/i18n';

registerDialogs({
  ocr: OcrDialog,
  convert: ConvertDialog,
  compress: CompressDialog,
  password: PasswordDialog,
  watermark: WatermarkDialog,
  'redact-search': RedactSearchDialog,
  'apply-redactions': ApplyRedactionsDialog,
  sanitize: SanitizeDialog,
  'fill-sign': SignatureDialog,
  'digital-sign': DigitalSignDialog,
  'create-id': CreateIdDialog,
  'validate-signatures': ValidateDialog,
});

const hasDoc = () => !!activeDoc();
const editable = () => {
  const d = activeDoc();
  return !!d && d.info.owner_authenticated !== false;
};
const dialog = (type: string, props?: Record<string, unknown>) => () => useUi.getState().openDialog(type, props);

register([
  { id: 'convert.word', label: 'PDF to Word…', run: dialog('convert', { mode: 'docx' }), enabled: hasDoc },
  { id: 'convert.excel', label: 'PDF to Excel…', run: dialog('convert', { mode: 'xlsx' }), enabled: hasDoc },
  { id: 'convert.powerpoint', label: 'PDF to PowerPoint…', run: dialog('convert', { mode: 'pptx' }), enabled: hasDoc },
  { id: 'convert.images', label: 'PDF to Images…', run: dialog('convert', { mode: 'images' }), enabled: hasDoc },
  { id: 'convert.text', label: 'Extract Text…', run: dialog('convert', { mode: 'text' }), enabled: hasDoc },
  { id: 'convert.extractImages', label: 'Extract Images…', run: dialog('convert', { mode: 'extract-images' }), enabled: hasDoc },
  { id: 'convert.ocr', label: 'Recognize Text (OCR)…', run: dialog('ocr'), enabled: editable },
  { id: 'doc.compress', label: 'Compress PDF…', run: dialog('compress'), enabled: hasDoc },
  { id: 'doc.fonts', label: 'Fonts in Document…', run: dialog('properties'), enabled: hasDoc },
  { id: 'protect.password', label: 'Password Protection…', run: dialog('password'), enabled: editable },
  {
    id: 'protect.removeSecurity',
    label: 'Remove Security…',
    run: async () => {
      const d = activeDoc();
      if (!d) return;
      const choice = await bridge().dialog.message({ type: 'warning', title: tr("Remove security"), message: tr("Remove the password protection from this document?"), detail: tr("The document is saved without encryption the next time you save it."), buttons: [tr("Remove"), tr("Cancel")], defaultId: 1, cancelId: 1 });
      if (choice !== 0) return;
      try {
        const info = await call<DocumentInfo>('security.remove', { doc_id: d.id });
        applyInfo(d.id, { ...info, page_map: null, modified_pages: [] }, undefined, d.pageVersions);
        useDocuments.getState().update(d.id, { savedRevision: -1 });
        toast('success', tr("Security removed"), tr("Save the document to write it without a password."));
      } catch (e) {
        toast('error', tr("Cannot remove security"), errorMessage(e));
      }
    },
    enabled: () => !!activeDoc()?.info.security,
  },
  {
    id: 'protect.unlock',
    label: 'Unlock Editing…',
    run: async () => {
      const d = activeDoc();
      if (!d) return;
      const pw = await askText({ title: tr("Unlock editing"), message: tr("Enter the permissions (owner) password of this document."), label: tr("Password"), password: true, okLabel: tr("Unlock") });
      if (!pw) return;
      try {
        const info = await call<DocumentInfo>('security.unlock', { doc_id: d.id, password: pw });
        applyInfo(d.id, { ...info, page_map: null, modified_pages: [] }, undefined, d.pageVersions);
        toast('success', tr("Editing unlocked"));
      } catch (e) {
        toast('error', tr("Cannot unlock"), errorMessage(e));
      }
    },
    enabled: () => activeDoc()?.info.owner_authenticated === false,
  },
  { id: 'protect.sign', label: 'Fill & Sign…', run: dialog('fill-sign'), enabled: editable },
  { id: 'protect.digitalSign', label: 'Sign with Digital ID…', run: dialog('digital-sign'), enabled: hasDoc },
  { id: 'protect.validate', label: 'Validate Signatures…', run: dialog('validate-signatures'), enabled: hasDoc },
  { id: 'protect.createId', label: 'Create Digital ID…', run: dialog('create-id') },
  { id: 'tool.redact-area', label: 'Mark for Redaction', run: () => setTool('redact-area'), enabled: editable, checked: () => activeDoc()?.tool === 'redact-area' },
  { id: 'protect.redactSearch', label: 'Search & Redact…', run: dialog('redact-search'), enabled: editable },
  { id: 'protect.applyRedactions', label: 'Apply Redactions…', run: dialog('apply-redactions'), enabled: editable },
  { id: 'protect.watermark', label: 'Watermark…', run: dialog('watermark'), enabled: editable },
  { id: 'protect.sanitize', label: 'Sanitize Document…', run: dialog('sanitize'), enabled: editable },
]);
