/**
 * "Default PDF app" support (Windows).
 *
 * Windows 10/11 do not let applications make themselves the default handler;
 * the user confirms the choice in Settings. The installer registers the app
 * under RegisteredApplications/Capabilities (assets/installer/installer.nsh),
 * so Settings can open directly on this app's page.
 */
import { shell } from 'electron';
import { execFile } from 'node:child_process';

export const PROG_ID = 'OfflinePDFEditor.pdf';
const APP_NAME = 'Offline PDF Editor';

export interface DefaultAppState {
  supported: boolean; // Windows build that was installed (not portable)
  isDefault: boolean;
  scope: 'user' | 'machine' | null;
}

function reg(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export async function defaultAppState(): Promise<DefaultAppState> {
  if (process.platform !== 'win32') return { supported: false, isDefault: false, scope: null };
  const user = await reg(['query', 'HKCU\\Software\\OfflinePDFEditor\\Capabilities', '/v', 'ApplicationName']);
  const machine = user ? null : await reg(['query', 'HKLM\\Software\\OfflinePDFEditor\\Capabilities', '/v', 'ApplicationName']);
  const scope = user ? 'user' : machine ? 'machine' : null;
  const choice = await reg(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice', '/v', 'ProgId']);
  const isDefault = !!choice && choice.includes(PROG_ID);
  return { supported: scope !== null, isDefault, scope };
}

/** Open Windows Settings on this app's "Default apps" page (fixed URIs only). */
export async function openDefaultAppSettings(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const state = await defaultAppState();
  const param = state.scope === 'machine' ? 'registeredAppMachine' : 'registeredAppUser';
  try {
    await shell.openExternal(`ms-settings:defaultapps?${param}=${encodeURIComponent(APP_NAME)}`);
    return true;
  } catch {
    try {
      await shell.openExternal('ms-settings:defaultapps'); // older Windows 10 builds
      return true;
    } catch {
      return false;
    }
  }
}
