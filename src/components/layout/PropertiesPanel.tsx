/* Context sensitive properties panel. Feature panels register themselves by
 * selection kind / tool; the document summary is the fallback. */
import { FileText, X } from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import { useUi } from '@/stores/ui';
import type { DocState } from '@/stores/documents';
import { OverlayProperties } from '@/features/overlay-editor/OverlayProperties';
import { AnnotationProperties, AnnotationToolDefaults } from '@/features/annotations/AnnotationProperties';
import { TextProperties } from '@/features/text-editor/TextProperties';
import { MODE_LABELS } from '@/types/editor';
import { tr } from '@/i18n';
import { FormFieldProperties } from '@/features/forms/FormFieldProperties';

function DocumentSummary({ doc }: { doc: DocState }) {
  const p = doc.info.pages[doc.currentPage];
  const rows: [string, string][] = [
    [tr('Pages'), String(doc.info.page_count)],
    [tr('Current page'), `${doc.currentPage + 1}`],
    [tr('Page size'), p ? `${p.width.toFixed(0)} × ${p.height.toFixed(0)} pt` : '–'],
    [tr('Rotation'), p ? `${p.rotation}°` : '–'],
    [tr('File size'), formatBytes(doc.info.file_size)],
    [tr('Objects added'), String(doc.overlays.length)],
    [tr('Undo steps'), String(doc.undo.length)],
  ];
  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-brand" />
        <span className="truncate text-[12.5px] font-medium">{doc.info.display_name}</span>
      </div>
      <table className="w-full text-[12px]">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="py-0.5 text-muted-foreground">{k}</td>
              <td className="py-0.5 text-right">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        {tr("Select an object, comment or text block to see its properties here. Current mode:")} <b>{tr(MODE_LABELS[doc.tool] ?? doc.tool)}</b>.
      </p>
    </div>
  );
}

export function PropertiesPanel({ doc }: { doc: DocState }) {
  const open = useUi((s) => s.propertiesOpen);
  const toggle = useUi((s) => s.toggleProperties);
  if (!open) return null;
  let content: React.ReactNode = null;
  if (doc.selection.kind === 'overlay' && doc.selection.ids.length) content = <OverlayProperties doc={doc} />;
  else if (doc.selection.kind === 'annotation' && doc.selection.ids.length) content = <AnnotationProperties doc={doc} />;
  else if (doc.selection.kind === 'text' && doc.tool === 'direct-text') content = <TextProperties doc={doc} />;
  else if (doc.selection.kind === 'form' && doc.selection.ids.length) content = <FormFieldProperties doc={doc} />;
  else if (doc.tool === 'form-edit' || doc.tool.startsWith('form-')) content = <p className="p-3 text-[12px] text-muted-foreground">{tr('Drag on the page to place a new field, or select a field to change its name, options and behaviour.')}</p>;
  else if (['add-text', 'shape-rect', 'shape-ellipse', 'shape-line', 'shape-arrow'].includes(doc.tool)) content = <OverlayProperties doc={doc} defaultsOnly />;
  else if (doc.tool.startsWith('annot-') || doc.tool === 'redact-area') content = <AnnotationToolDefaults tool={doc.tool} />;
  return (
    <div className="flex w-[248px] shrink-0 flex-col border-l bg-panel" data-testid="properties-panel">
      <div className="flex h-8 items-center border-b px-3 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {tr("Properties")}
        <button className="ml-auto rounded p-0.5 hover:bg-muted" onClick={() => toggle(false)} aria-label={tr("Close properties")}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{content ?? <DocumentSummary doc={doc} />}</div>
    </div>
  );
}
