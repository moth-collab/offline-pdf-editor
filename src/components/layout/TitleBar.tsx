import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import type { RecentFile } from '@shared/types';
import { MENUS, type MenuEntry } from '@/app/menus';
import { getCommand, runCommand } from '@/app/commands';
import {
  Menubar, MenubarCheckboxItem, MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator, MenubarSub, MenubarSubContent, MenubarSubTrigger, MenubarTrigger, Shortcut,
} from '@/components/ui/menus';
import { useActiveDoc, isDirty } from '@/stores/documents';
import { bridge } from '@/lib/api';
import { openDocument } from '@/services/docService';
import { tr } from '@/i18n';

function RecentSubmenu() {
  const [items, setItems] = useState<RecentFile[]>([]);
  return (
    <MenubarSub onOpenChange={(o) => o && bridge().recent.list().then(setItems)}>
      <MenubarSubTrigger>{tr("Open Recent")}</MenubarSubTrigger>
      <MenubarSubContent className="max-w-md">
        {items.length === 0 && <MenubarItem disabled>{tr("No recent files")}</MenubarItem>}
        {items.map((r) => (
          <MenubarItem
            key={r.path}
            disabled={!r.exists}
            onSelect={() => r.token && openDocument({ token: r.token, name: r.name, path: r.path })}
            title={r.path}
          >
            <span className="truncate">{r.name}</span>
            <span className="ml-auto max-w-[180px] truncate pl-4 text-[11px] text-muted-foreground">{r.path}</span>
          </MenubarItem>
        ))}
        {items.length > 0 && (
          <>
            <MenubarSeparator />
            <MenubarItem onSelect={() => bridge().recent.clear()}>{tr("Clear recent files")}</MenubarItem>
          </>
        )}
      </MenubarSubContent>
    </MenubarSub>
  );
}

function renderEntries(entries: MenuEntry[], key = ''): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let lastWasSep = true;
  entries.forEach((e, i) => {
    if ('sep' in e) {
      if (!lastWasSep) out.push(<MenubarSeparator key={`${key}s${i}`} />);
      lastWasSep = true;
      return;
    }
    if ('items' in e) {
      if (e.label === 'Open Recent') out.push(<RecentSubmenu key="recent" />);
      lastWasSep = false;
      return;
    }
    const c = getCommand(e.cmd);
    if (!c) return;
    const enabled = !c.enabled || c.enabled();
    lastWasSep = false;
    if (c.checked) {
      out.push(
        <MenubarCheckboxItem key={c.id} checked={c.checked()} disabled={!enabled} onSelect={() => runCommand(c.id)}>
          {tr(c.label)}
          {c.shortcut && <Shortcut>{c.shortcut}</Shortcut>}
        </MenubarCheckboxItem>,
      );
    } else {
      out.push(
        <MenubarItem key={c.id} disabled={!enabled} onSelect={() => runCommand(c.id)}>
          {tr(c.label)}
          {c.shortcut && <Shortcut>{c.shortcut}</Shortcut>}
        </MenubarItem>,
      );
    }
  });
  while (out.length && (out[out.length - 1] as any)?.type === MenubarSeparator) out.pop();
  return out;
}

export function TitleBar() {
  const doc = useActiveDoc();
  const [, force] = useState(0);
  useEffect(() => {
    const title = doc ? `${isDirty(doc) ? '● ' : ''}${doc.info.display_name} – Offline PDF Editor` : 'Offline PDF Editor';
    document.title = title;
  }, [doc]);
  return (
    <div className="drag-region flex h-[34px] shrink-0 items-center gap-1 border-b bg-chrome pl-2 pr-[150px]">
      <div className="flex items-center gap-1.5 pr-1">
        <div className="flex h-5 w-5 items-center justify-center rounded-[4px] bg-brand text-white">
          <FileText className="h-3.5 w-3.5" />
        </div>
      </div>
      <Menubar onValueChange={() => force((n) => n + 1)}>
        {MENUS.map((m) => (
          <MenubarMenu key={m.label}>
            <MenubarTrigger>{tr(m.label)}</MenubarTrigger>
            <MenubarContent>{renderEntries(m.items, m.label)}</MenubarContent>
          </MenubarMenu>
        ))}
      </Menubar>
      <div className="min-w-0 flex-1 truncate text-center text-[12px] text-muted-foreground">
        {doc ? `${isDirty(doc) ? '● ' : ''}${doc.info.display_name}` : tr("Offline PDF Editor")}
      </div>
    </div>
  );
}
