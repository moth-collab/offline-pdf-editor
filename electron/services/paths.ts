import { app } from 'electron';
import path from 'node:path';

export interface AppPaths {
  root: string;
  resources: string;
  assets: string;
  rendererDist: string;
  userData: string;
  sessions: string;
  cache: string;
  temp: string;
  assetsStore: string;
  backups: string;
}

let cached: AppPaths | null = null;

export function appPaths(): AppPaths {
  if (cached) return cached;
  const userData = app.getPath('userData');
  const root = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
  const resources = app.isPackaged ? process.resourcesPath : root;
  cached = {
    root,
    resources,
    assets: path.join(resources, 'assets'),
    rendererDist: app.isPackaged ? path.join(app.getAppPath(), 'dist') : path.join(root, 'dist'),
    userData,
    sessions: path.join(userData, 'sessions'),
    cache: path.join(userData, 'cache'),
    temp: path.join(userData, 'tmp'),
    assetsStore: path.join(userData, 'assets'),
    backups: path.join(userData, 'backups'),
  };
  return cached;
}
