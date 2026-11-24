/* Menubar, dropdown and context menu primitives (shadcn/ui style). */
import * as React from 'react';
import * as MenubarPrimitive from '@radix-ui/react-menubar';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import * as ContextPrimitive from '@radix-ui/react-context-menu';
import { Check, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

const contentCls =
  'z-50 min-w-[13rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg';
const itemCls =
  'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-[5px] text-[12.5px] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5';

export function Shortcut({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto pl-6 text-[11px] tracking-wide text-muted-foreground">{children}</span>;
}

// ---- Menubar --------------------------------------------------------------
export const Menubar = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Root>
>(({ className, ...props }, ref) => <MenubarPrimitive.Root ref={ref} className={cn('flex items-center gap-0.5', className)} {...props} />);
Menubar.displayName = 'Menubar';
export const MenubarMenu = MenubarPrimitive.Menu;
export const MenubarTrigger = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <MenubarPrimitive.Trigger
    ref={ref}
    className={cn('no-drag rounded-sm px-2.5 py-1 text-[12.5px] outline-none data-[state=open]:bg-muted hover:bg-muted', className)}
    {...props}
  />
));
MenubarTrigger.displayName = 'MenubarTrigger';
export const MenubarContent = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Content>
>(({ className, align = 'start', sideOffset = 4, ...props }, ref) => (
  <MenubarPrimitive.Portal>
    <MenubarPrimitive.Content ref={ref} align={align} sideOffset={sideOffset} className={cn(contentCls, className)} {...props} />
  </MenubarPrimitive.Portal>
));
MenubarContent.displayName = 'MenubarContent';
export const MenubarItem = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Item>
>(({ className, ...props }, ref) => <MenubarPrimitive.Item ref={ref} className={cn(itemCls, className)} {...props} />);
MenubarItem.displayName = 'MenubarItem';
export const MenubarSeparator = () => <MenubarPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
export const MenubarSub = MenubarPrimitive.Sub;
export const MenubarSubTrigger = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <MenubarPrimitive.SubTrigger ref={ref} className={cn(itemCls, 'data-[state=open]:bg-accent', className)} {...props}>
    {children}
    <ChevronRight className="ml-auto" />
  </MenubarPrimitive.SubTrigger>
));
MenubarSubTrigger.displayName = 'MenubarSubTrigger';
export const MenubarSubContent = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <MenubarPrimitive.Portal>
    <MenubarPrimitive.SubContent ref={ref} className={cn(contentCls, className)} {...props} />
  </MenubarPrimitive.Portal>
));
MenubarSubContent.displayName = 'MenubarSubContent';
export const MenubarCheckboxItem = React.forwardRef<
  React.ElementRef<typeof MenubarPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <MenubarPrimitive.CheckboxItem ref={ref} className={cn(itemCls, 'pl-7', className)} {...props}>
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <MenubarPrimitive.ItemIndicator>
        <Check />
      </MenubarPrimitive.ItemIndicator>
    </span>
    {children}
  </MenubarPrimitive.CheckboxItem>
));
MenubarCheckboxItem.displayName = 'MenubarCheckboxItem';

// ---- Dropdown --------------------------------------------------------------
export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownPrimitive.Portal>
    <DropdownPrimitive.Content ref={ref} sideOffset={sideOffset} className={cn(contentCls, className)} {...props} />
  </DropdownPrimitive.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';
export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item>
>(({ className, ...props }, ref) => <DropdownPrimitive.Item ref={ref} className={cn(itemCls, className)} {...props} />);
DropdownMenuItem.displayName = 'DropdownMenuItem';
export const DropdownMenuSeparator = () => <DropdownPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
export const DropdownMenuLabel = ({ children }: { children: React.ReactNode }) => (
  <DropdownPrimitive.Label className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</DropdownPrimitive.Label>
);

// ---- Context menu ------------------------------------------------------------
export const ContextMenu = ContextPrimitive.Root;
export const ContextMenuTrigger = ContextPrimitive.Trigger;
export const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextPrimitive.Portal>
    <ContextPrimitive.Content ref={ref} className={cn(contentCls, className)} {...props} />
  </ContextPrimitive.Portal>
));
ContextMenuContent.displayName = 'ContextMenuContent';
export const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextPrimitive.Item>
>(({ className, ...props }, ref) => <ContextPrimitive.Item ref={ref} className={cn(itemCls, className)} {...props} />);
ContextMenuItem.displayName = 'ContextMenuItem';
export const ContextMenuSeparator = () => <ContextPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
