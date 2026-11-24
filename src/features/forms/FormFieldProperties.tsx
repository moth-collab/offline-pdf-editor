/* Properties of the selected form field (design mode). */
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CheckRow, Input, Label, NumberInput, Select, Textarea } from '@/components/ui/controls';
import type { DocState } from '@/stores/documents';
import { tr } from '@/i18n';
import { deleteWidgets, fieldByName, FIELD_TYPE_LABEL, formsKey, updateField, useForms, type FormField } from './service';

export function FormFieldProperties({ doc }: { doc: DocState }) {
  const data = useForms((s) => s.cache[formsKey(doc.id, doc.info.revision)]);
  const sel = doc.selection;
  const field = sel.kind === 'form' && sel.field ? fieldByName(data, sel.field) : undefined;
  const widget = sel.kind === 'form' ? data?.widgets.find((w) => w.id === sel.ids[0]) : undefined;
  if (!field || !widget) return null;
  return <Editor key={`${field.name}:${doc.info.revision}`} doc={doc} field={field} widgetId={widget.id} exportValue={widget.export} canEdit={!!data?.can_edit} />;
}

function Editor({ doc, field, widgetId, exportValue, canEdit }: { doc: DocState; field: FormField; widgetId: string; exportValue: string | null; canEdit: boolean }) {
  const shortName = field.name.split('.').pop() ?? field.name;
  const [name, setName] = useState(shortName);
  const [tooltip, setTooltip] = useState(field.tooltip);
  const [options, setOptions] = useState(field.options.map(([e]) => e).join('\n'));
  useEffect(() => setName(shortName), [shortName]);
  const set = (props: Record<string, unknown>) => updateField(doc.id, field.name, props);
  const isText = field.type === 'text';
  const isChoice = field.type === 'combo' || field.type === 'list';
  const fontEditable = isText || isChoice;
  return (
    <div className="space-y-2.5 p-3 text-[12px]" data-testid="form-field-properties">
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] font-medium">{tr(FIELD_TYPE_LABEL[field.type])}</div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-destructive"
          disabled={!canEdit}
          title={tr('Delete form field')}
          onClick={() => deleteWidgets(doc.id, [widgetId])}
          data-testid="form-field-delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="space-y-1">
        <Label>{field.type === 'radio' ? tr('Group name') : tr('Field name')}</Label>
        <Input
          value={name}
          disabled={!canEdit}
          data-testid="form-field-name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== shortName && set({ name: name.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </div>
      {exportValue && (
        <div className="text-muted-foreground">
          {tr('Value when selected:')} <b className="text-foreground">{exportValue}</b>
        </div>
      )}
      <div className="space-y-1">
        <Label>{tr('Tooltip')}</Label>
        <Input
          value={tooltip}
          disabled={!canEdit}
          placeholder={tr('Shown when the pointer rests on the field')}
          onChange={(e) => setTooltip(e.target.value)}
          onBlur={() => tooltip !== field.tooltip && set({ tooltip })}
        />
      </div>
      {isChoice && (
        <div className="space-y-1">
          <Label>{tr('Options (one per line)')}</Label>
          <Textarea
            rows={5}
            value={options}
            disabled={!canEdit}
            data-testid="form-field-options"
            onChange={(e) => setOptions(e.target.value)}
            onBlur={() => {
              const list = options.split('\n').map((s) => s.trim()).filter(Boolean);
              if (list.length && list.join('\n') !== field.options.map(([e]) => e).join('\n')) set({ options: list });
            }}
          />
        </div>
      )}
      {fontEditable && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label>{tr('Font size')}</Label>
            <NumberInput value={field.font_size} onChange={(v) => set({ font_size: v })} min={0} max={72} step={1} suffix="pt" />
            <div className="text-[10.5px] text-muted-foreground">{tr('0 = automatic')}</div>
          </div>
          {field.type !== 'list' && (
            <div className="space-y-1">
              <Label>{tr('Alignment')}</Label>
              <Select
                value={field.align}
                onValueChange={(v) => set({ align: v })}
                options={[
                  { value: 'left', label: tr('Left') },
                  { value: 'center', label: tr('Center') },
                  { value: 'right', label: tr('Right') },
                ]}
              />
            </div>
          )}
        </div>
      )}
      {isText && (
        <div className="space-y-1">
          <Label>{tr('Maximum characters')}</Label>
          <NumberInput value={field.maxlen} onChange={(v) => set({ maxlen: Math.max(0, Math.round(v)) })} min={0} max={10000} step={1} />
        </div>
      )}
      <div className="space-y-1.5 border-t pt-2">
        <CheckRow checked={field.required} onChange={(v) => set({ required: v })} label={tr('Required')} disabled={!canEdit} />
        <CheckRow checked={field.readonly} onChange={(v) => set({ readonly: v })} label={tr('Read-only')} disabled={!canEdit} />
        {isText && (
          <>
            <CheckRow checked={field.multiline} onChange={(v) => set({ multiline: v })} label={tr('Multiple lines')} disabled={!canEdit} />
            <CheckRow checked={field.password} onChange={(v) => set({ password: v })} label={tr('Password (hide the text)')} disabled={!canEdit} />
            <CheckRow
              checked={field.comb}
              onChange={(v) => set({ comb: v })}
              label={tr('Spread characters into boxes')}
              hint={field.maxlen ? undefined : tr('Needs a maximum number of characters')}
              disabled={!canEdit || !field.maxlen}
            />
          </>
        )}
        {field.type === 'combo' && <CheckRow checked={field.editable} onChange={(v) => set({ editable: v })} label={tr('Allow custom text')} disabled={!canEdit} />}
        {field.type === 'list' && <CheckRow checked={field.multiselect} onChange={(v) => set({ multiselect: v })} label={tr('Allow several selections')} disabled={!canEdit} />}
      </div>
      {field.type === 'radio' && (
        <p className="text-[11px] text-muted-foreground">{tr('To add another choice to this group, keep it selected and click on the page with the Radio Button tool.')}</p>
      )}
    </div>
  );
}
