// Bundles the Electron main process and preload script with esbuild (CommonJS,
// because sandboxed preload scripts must be CommonJS).
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: watch ? 'inline' : false,
  external: ['electron'],
  logLevel: 'info',
  outExtension: { '.js': '.cjs' },
};
const configs = [
  { ...common, entryPoints: { main: 'electron/main.ts' }, outdir: 'dist-electron' },
  { ...common, entryPoints: { preload: 'electron/preload.ts' }, outdir: 'dist-electron' },
];
if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
