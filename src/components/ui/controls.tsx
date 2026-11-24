/* Form controls and small primitives (shadcn/ui style). */
import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as SliderPrimitive from '@radix-ui/react-slider';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import * as RadioPrimitive from '@radix-ui/react-radio-group';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { tr } from '@/i18n';

// ---- Input / Label / Textarea -----------------------------------------------
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, type = 'text', ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      'flex h-7 w-full rounded-md border border-input bg-background px-2 py-1 text-[12.5px] shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-ring disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-16 w-full rounded-md border border-input bg-background px-2 py-1.5 text-[12.5px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-ring',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-[12px] font-medium text-foreground/90', className)} {...props} />;
}

export function Separator({ vertical, className }: { vertical?: boolean; className?: string }) {
  return <div role="separator" className={cn('shrink-0 bg-border', vertical ? 'mx-1 h-full w-px' : 'my-1 h-px w-full', className)} />;
}

// ---- Tooltip ----------------------------------------------------------------
export const TooltipProvider = TooltipPrimitive.Provider;
export function Tooltip({ content, children, side = 'bottom' }: { content: React.ReactNode; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return <>{children}</>;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={6} className="z-[60] max-w-xs rounded-md bg-foreground px-2 py-1 text-[11.5px] text-background shadow-md">
          {typeof content === 'string' ? tr(content) : content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// ---- Switch / Checkbox ----------------------------------------------------------
export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors data-[state=checked]:bg-primary data-[state=unchecked]:bg-input disabled:opacity-50',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block h-3.5 w-3.5 rounded-full bg-background shadow transition-transform data-[state=checked]:translate-x-3.5" />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';

export const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn('peer h-4 w-4 shrink-0 rounded-[3px] border border-input data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground', className)}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center">
      <Check className="h-3 w-3" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = 'Checkbox';

export function CheckRow({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; hint?: React.ReactNode; disabled?: boolean }) {
  const id = React.useId();
  return (
    <div className="flex items-start gap-2 py-0.5">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={disabled} className="mt-[1px]" />
      <label htmlFor={id} className={cn('flex flex-col text-[12.5px] leading-tight', disabled && 'opacity-50')}>
        <span>{label}</span>
        {hint && <span className="text-[11.5px] text-muted-foreground">{hint}</span>}
      </label>
    </div>
  );
}

// ---- Slider -----------------------------------------------------------------
export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root ref={ref} className={cn('relative flex h-4 w-full touch-none select-none items-center', className)} {...props}>
    <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-input">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="block h-3.5 w-3.5 rounded-full border-2 border-primary bg-background shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
  </SliderPrimitive.Root>
));
Slider.displayName = 'Slider';

// ---- Select -----------------------------------------------------------------
export function Select({
  value,
  onValueChange,
  options,
  className,
  disabled,
  placeholder,
}: {
  value: string;
  onValueChange: (v: string) => void;
  /** raw: show the label as is (e.g. language names in their own language) */
  options: { value: string; label: React.ReactNode; raw?: boolean }[];
  className?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-7 w-full items-center justify-between gap-1 rounded-md border border-input bg-background px-2 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50',
          className,
        )}
      >
        <span className="truncate">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className="z-[70] max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border bg-popover shadow-lg">
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                className="relative flex cursor-default select-none items-center rounded-sm py-1 pl-6 pr-2 text-[12.5px] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-1.5">
                  <Check className="h-3.5 w-3.5" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{o.raw ? o.label : tr(o.label)}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

// ---- Tabs -------------------------------------------------------------------
export const Tabs = TabsPrimitive.Root;
export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => <TabsPrimitive.List ref={ref} className={cn('inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5', className)} {...props} />);
TabsList.displayName = 'TabsList';
export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn('rounded-sm px-2.5 py-1 text-[12px] font-medium text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm', className)}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';
export const TabsContent = TabsPrimitive.Content;

// ---- Popover ----------------------------------------------------------------
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'start', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content ref={ref} align={align} sideOffset={sideOffset} className={cn('z-50 rounded-md border bg-popover p-3 text-popover-foreground shadow-lg outline-none', className)} {...props} />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = 'PopoverContent';

// ---- Progress ---------------------------------------------------------------
export function Progress({ value, className, indeterminate }: { value: number; className?: string; indeterminate?: boolean }) {
  return (
    <ProgressPrimitive.Root className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-muted', className)} value={value}>
      <ProgressPrimitive.Indicator
        className={cn('h-full bg-primary transition-[width] duration-200', indeterminate && 'w-1/3 animate-pulse')}
        style={indeterminate ? undefined : { width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </ProgressPrimitive.Root>
  );
}

// ---- Radio group ----------------------------------------------------------------
export function RadioGroup({ value, onValueChange, options, className }: { value: string; onValueChange: (v: string) => void; options: { value: string; label: React.ReactNode; hint?: React.ReactNode; disabled?: boolean }[]; className?: string }) {
  return (
    <RadioPrimitive.Root value={value} onValueChange={onValueChange} className={cn('flex flex-col gap-1.5', className)}>
      {options.map((o) => {
        const id = `rg-${o.value}`;
        return (
          <div key={o.value} className={cn('flex items-start gap-2', o.disabled && 'opacity-50')}>
            <RadioPrimitive.Item id={id} value={o.value} disabled={o.disabled} className="mt-[2px] flex h-3.5 w-3.5 items-center justify-center rounded-full border border-input data-[state=checked]:border-primary">
              <RadioPrimitive.Indicator className="h-1.5 w-1.5 rounded-full bg-primary" />
            </RadioPrimitive.Item>
            <label htmlFor={id} className="flex flex-col text-[12.5px] leading-tight">
              <span>{tr(o.label)}</span>
              {o.hint && <span className="text-[11.5px] text-muted-foreground">{tr(o.hint)}</span>}
            </label>
          </div>
        );
      })}
    </RadioPrimitive.Root>
  );
}

// ---- Color input --------------------------------------------------------------
const SWATCHES = ['#000000', '#434343', '#7f7f7f', '#ffffff', '#d92d20', '#f79009', '#fdb022', '#12b76a', '#2e90fa', '#2563eb', '#7a5af8', '#ee46bc'];

export function ColorInput({ value, onChange, allowNone, className }: { value: string | null; onChange: (v: string | null) => void; allowNone?: boolean; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={cn('flex h-7 items-center gap-1.5 rounded-md border border-input bg-background px-1.5 text-[12px]', className)}>
          <span className={cn('h-4 w-4 rounded-sm border', !value && 'checker')} style={value ? { background: value } : undefined} />
          <span className="font-mono text-[11px] text-muted-foreground">{value ?? 'none'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-2">
        <div className="grid grid-cols-6 gap-1.5">
          {SWATCHES.map((c) => (
            <button key={c} className="h-6 w-6 rounded-sm border hover:scale-110" style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input type="color" value={value ?? '#000000'} onChange={(e) => onChange(e.target.value)} className="h-7 w-10 cursor-pointer rounded border bg-transparent" />
          <Input value={value ?? ''} onChange={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && onChange(e.target.value)} placeholder="#000000" className="font-mono" />
        </div>
        {allowNone && (
          <button className="mt-2 w-full rounded-md border py-1 text-[12px] hover:bg-muted" onClick={() => onChange(null)}>
            {tr("No color")}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function NumberInput({ value, onChange, min, max, step = 1, suffix, className }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; className?: string }) {
  const [text, setText] = React.useState(String(round(value)));
  React.useEffect(() => setText(String(round(value))), [value]);
  const commit = () => {
    const v = parseFloat(text);
    if (Number.isFinite(v)) {
      const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
      onChange(c);
      setText(String(round(c)));
    } else setText(String(round(value)));
  };
  return (
    <div className={cn('relative', className)}>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const v = (parseFloat(text) || 0) + (e.key === 'ArrowUp' ? step : -step);
            const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
            onChange(c);
          }
        }}
        className={suffix ? 'pr-7' : undefined}
      />
      {suffix && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
