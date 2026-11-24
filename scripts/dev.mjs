// Development runner: Vite dev server + esbuild watch + Electron.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { build } from 'esbuild';

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];
await new Promise((r) => {
  const p = spawn(process.execPath, ['scripts/build-electron.mjs'], { stdio: 'inherit' });
  p.on('exit', r);
});
const electronPath = (await import('electron')).default;
const child = spawn(electronPath, ['.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
