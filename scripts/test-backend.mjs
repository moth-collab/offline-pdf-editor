// Runs the backend test-suite with the project's virtualenv (Windows/macOS/Linux).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const venv = path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = fs.existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3';
const r = spawnSync(python, ['-m', 'pytest', '-q', 'tests/backend', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
