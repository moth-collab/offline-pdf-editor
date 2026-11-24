#!/usr/bin/env node
/**
 * Prepares the self-contained Windows x64 runtime that ships inside the
 * installer, so end users never need to install Python or Tesseract:
 *
 *   build/win-runtime/python/      CPython 3.13 (x64) + pinned backend wheels
 *   build/win-runtime/tesseract/   tesseract.exe + the DLLs it needs
 *
 * This runs on the *build* machine (Windows, Linux or macOS) and needs
 * internet access once. The finished application never downloads anything.
 *
 * Sources (all official / reproducible, pinned):
 *   - Python:    the "python" package published by the CPython release team
 *                on nuget.org (a relocatable, non-installer CPython build).
 *                Override with PDFED_PYTHON_NUPKG=<local .nupkg> or
 *                PDFED_PYTHON_VERSION=<3.13.x>.
 *   - Wheels:    PyPI win_amd64 wheels for backend/requirements.txt, installed
 *                with the host pip using --platform/--only-binary (no compile).
 *   - Tesseract: conda-forge win-64 builds (Apache-2.0) with their DLL
 *                dependencies; only the DLLs actually imported (resolved by
 *                walking PE import tables) are kept. Override with
 *                PDFED_TESSERACT_DIR=<folder containing tesseract.exe and its
 *                DLLs>, e.g. an existing UB-Mannheim installation.
 *
 * Language data (eng/tha/osd) is NOT taken from these packages: the app ships
 * its own pinned tessdata in assets/ocr/tessdata (see scripts/fetch-assets.mjs).
 *
 * Usage: node scripts/prepare-win-runtime.mjs [--force] [--skip-python] [--skip-tesseract]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const outRoot = path.join(root, 'build', 'win-runtime');
const cacheDir = path.join(root, 'build', 'download-cache');
const args = new Set(process.argv.slice(2));
const force = args.has('--force');

const PYTHON_VERSION = process.env.PDFED_PYTHON_VERSION || '3.13.9';
// sha256 of the pinned default package (python.3.13.9.nupkg from nuget.org)
const PYTHON_SHA256 =
  process.env.PDFED_PYTHON_SHA256 || (process.env.PDFED_PYTHON_VERSION || process.env.PDFED_PYTHON_NUPKG ? '' : 'ea7541c98f77b6f344460b88db6e677573069979bcbf0ba18747cc2c125aba25');
const PY_TAG = PYTHON_VERSION.split('.').slice(0, 2).join(''); // "313"

// conda-forge win-64 packages for Tesseract 5.5 and its runtime dependencies.
// Exact build strings are pinned for reproducibility.
const CONDA_BASE = 'https://conda.anaconda.org/conda-forge/win-64/';
const TESSERACT_PACKAGES = [
  'tesseract-5.5.4-h8c7c6a5_0.conda',
  'leptonica-1.87.0-h5b5c448_2.conda',
  'libzlib-1.3.2-hfd05255_3.conda',
  'giflib-6.1.3-h918f4b6_2.conda',
  'libpng-1.6.59-hdc8cecf_0.conda',
  'libtiff-4.7.2-hef6d50c_2.conda',
  'zstd-1.5.7-h534d264_7.conda',
  'liblzma-5.8.3-hfd05255_1.conda',
  'libjpeg-turbo-3.2.1-hfd05255_0.conda',
  'libdeflate-1.26-h1a1d4e4_0.conda',
  'lerc-4.3.0-hd936e49_0.conda',
  'libwebp-base-1.6.0-h4d5522a_1.conda',
  'openjpeg-2.5.4-h90fa87c_2.conda',
  'libarchive-3.8.11-gpl_hcdebe0b_101.conda',
  'openssl-3.5.9-hf411b9b_0.conda',
  'lzo-2.10-h6a83c73_1003.conda',
  'lz4-c-1.10.0-h6a83c73_2.conda',
  'libxml2-16-2.15.4-h692994f_1.conda',
  'libiconv-1.18-hc1393d2_3.conda',
  'bzip2-1.0.8-h0ad9c76_10.conda',
  'libcurl-8.23.0-hdb0ef4a_0.conda',
  'libssh2-1.11.1-h734d217_2.conda',
  'libpsl-0.23.1-h68b289e_3.conda',
  'icu-75.1-he0c23c2_0.conda',
  'krb5-1.22.2-h719d79b_2.conda',
  'vc14_runtime-14.51.36247-hb06f545_44.conda',
  'vcomp14-14.51.36247-h1c3f1cb_44.conda',
];

// DLLs provided by Windows 10/11 itself (system32 / API sets / UCRT).
const SYSTEM_DLL = /^(api-ms-win-|ext-ms-win-)|^(kernel32|kernelbase|user32|gdi32|advapi32|shell32|ole32|oleaut32|ws2_32|crypt32|secur32|bcrypt|ncrypt|ntdll|rpcrt4|shlwapi|comdlg32|comctl32|winmm|version|iphlpapi|dnsapi|userenv|wldap32|normaliz|msvcrt|ucrtbase|dbghelp|psapi|setupapi|cfgmgr32|imm32|winhttp|wininet|mpr|netapi32|powrprof|dwmapi|uxtheme|wtsapi32|cryptbase|sspicli|authz|activeds|mswsock|bcryptprimitives|usp10|dwrite|avicap32|shcore|pdh|d3d11|d3d12|dxgi|dxcore|opengl32|glu32|mfplat|mfreadwrite|mf|propsys|oleacc|wintrust|wsock32)\.dll$/i;

function log(...a) {
  console.log('[win-runtime]', ...a);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log('download', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) ${url}`);
  const tmp = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
}

async function unzipTo(zipFile, destDir, filter = () => true) {
  const unzipper = require('unzipper');
  const dir = await unzipper.Open.file(zipFile);
  for (const entry of dir.files) {
    if (entry.type !== 'File' || !filter(entry.path)) continue;
    const rel = entry.path.replace(/\\/g, '/');
    const target = path.join(destDir, rel);
    if (!target.startsWith(destDir + path.sep)) throw new Error(`Unsafe zip entry ${entry.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await pipeline(entry.stream(), fs.createWriteStream(target));
  }
}

function findHostPython() {
  const candidates = [
    process.env.PDFED_HOST_PYTHON,
    path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    process.platform === 'win32' ? 'py' : 'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const v = execFileSync(c, ['-c', 'import sys;print("%d%d" % sys.version_info[:2])'], { encoding: 'utf8' }).trim();
      return { exe: c, tag: v };
    } catch {
      /* try next */
    }
  }
  throw new Error('A host Python 3 with pip is required to fetch wheels (set PDFED_HOST_PYTHON).');
}

// ---------------------------------------------------------------- Python

async function preparePython() {
  const pyDir = path.join(outRoot, 'python');
  if (fs.existsSync(path.join(pyDir, 'python.exe')) && !force) {
    log('python runtime already present (use --force to rebuild)');
    return;
  }
  fs.rmSync(pyDir, { recursive: true, force: true });
  const nupkg =
    process.env.PDFED_PYTHON_NUPKG ||
    (await download(
      `https://api.nuget.org/v3-flatcontainer/python/${PYTHON_VERSION}/python.${PYTHON_VERSION}.nupkg`,
      path.join(cacheDir, `python.${PYTHON_VERSION}.nupkg`),
    ));
  const digest = sha256(nupkg);
  log(`python ${PYTHON_VERSION} nupkg sha256 ${digest}`);
  if (PYTHON_SHA256 && PYTHON_SHA256.toLowerCase() !== digest) {
    throw new Error('Python package checksum mismatch');
  }
  const stage = path.join(cacheDir, 'python-stage');
  fs.rmSync(stage, { recursive: true, force: true });
  await unzipTo(nupkg, stage, (p) => p.startsWith('tools/'));
  fs.renameSync(path.join(stage, 'tools'), pyDir);
  fs.rmSync(stage, { recursive: true, force: true });

  // Drop parts of the standard library the backend never uses.
  for (const rel of ['Lib/test', 'Lib/venv', 'Lib/idlelib', 'Lib/tkinter', 'Lib/turtledemo', 'Lib/ensurepip', 'tcl', 'Tools', 'Scripts', 'include', 'libs',
    'DLLs/_tkinter.pyd', 'DLLs/tcl86t.dll', 'DLLs/tk86t.dll', 'Lib/turtle.py']) {
    fs.rmSync(path.join(pyDir, rel), { recursive: true, force: true });
  }

  // Lock the module search path: ignores PYTHONPATH/PYTHONHOME, the registry
  // and user site-packages, so a system Python can never interfere.
  fs.writeFileSync(
    path.join(pyDir, `python${PY_TAG}._pth`),
    ['Lib', 'DLLs', 'Lib\\site-packages', '..\\backend', 'import site', ''].join('\r\n'),
  );

  // Pinned backend dependencies as prebuilt win_amd64 wheels.
  const host = findHostPython();
  const site = path.join(pyDir, 'Lib', 'site-packages');
  fs.mkdirSync(site, { recursive: true });
  const pipArgs = [
    '-m', 'pip', 'install', '--no-compile', '--no-warn-script-location', '--disable-pip-version-check',
    '--platform', 'win_amd64', '--python-version', PYTHON_VERSION.split('.').slice(0, 2).join('.'),
    '--implementation', 'cp', '--only-binary=:all:',
    '--target', site, '-r', path.join(root, 'backend', 'requirements.txt'),
  ];
  log('installing wheels:', host.exe, pipArgs.join(' '));
  execFileSync(host.exe, pipArgs, { stdio: 'inherit' });
  fs.rmSync(path.join(site, 'bin'), { recursive: true, force: true });
  for (const d of fs.readdirSync(site)) {
    // console-script launchers are not needed and test suites only add size
    // (pip itself is not needed at runtime: the app never installs packages)
    if (/^(tests?|__pycache__|pip|pip-[^/]*\.dist-info)$/.test(d)) fs.rmSync(path.join(site, d), { recursive: true, force: true });
  }

  // The Microsoft Visual C++ runtime (redistributable) next to python.exe,
  // so extension modules load on a clean Windows install without the
  // VC++ Redistributable being installed system-wide.
  const vcBin = await vcRuntimeBin();
  for (const dll of ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'concrt140.dll', 'vcomp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
    const src = path.join(vcBin, dll);
    if (fs.existsSync(src) && !fs.existsSync(path.join(pyDir, dll))) fs.copyFileSync(src, path.join(pyDir, dll));
  }
  verifyDllClosure(pyDir);

  // Precompile bytecode (hash-based, so it stays valid after installation).
  if (host.tag === PY_TAG) {
    execFileSync(host.exe, ['-m', 'compileall', '-q', '-j', '0', '--invalidation-mode', 'unchecked-hash', path.join(pyDir, 'Lib')], {
      stdio: 'inherit',
    });
  } else {
    log(`host Python ${host.tag} != ${PY_TAG}; skipping bytecode precompilation`);
  }
  log('python runtime ready:', pyDir);
}

/**
 * Fails if any executable/extension under `dir` imports a DLL that is neither
 * part of Windows nor shipped inside `dir`. (The process directory and each
 * module's own directory are on the DLL search path.)
 */
function verifyDllClosure(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(pyd|dll|exe)$/i.test(e.name)) files.push(p);
    }
  };
  walk(dir);
  const shipped = new Set(files.map((f) => path.basename(f).toLowerCase()));
  const missing = new Map();
  for (const f of files) {
    let imports;
    try {
      imports = peImports(f);
    } catch {
      continue; // not a PE image (e.g. data file with .dll suffix)
    }
    for (const dll of imports) {
      const k = dll.toLowerCase();
      if (!SYSTEM_DLL.test(k) && !shipped.has(k)) missing.set(k, path.relative(dir, f));
    }
  }
  if (missing.size) {
    throw new Error('Unresolved DLL imports: ' + [...missing].map(([d, f]) => `${d} (needed by ${f})`).join('; '));
  }
  log(`DLL closure verified for ${files.length} binaries in ${path.basename(dir)}`);
}

async function vcRuntimeBin() {
  const dir = path.join(cacheDir, 'vc-runtime');
  const bin = path.join(dir, 'Library', 'bin');
  if (!fs.existsSync(path.join(bin, 'msvcp140.dll'))) {
    for (const pkg of TESSERACT_PACKAGES.filter((p) => /^(vc14_runtime|vcomp14)-/.test(p))) {
      const file = await download(CONDA_BASE + pkg, path.join(cacheDir, 'conda', pkg));
      await extractConda(file, dir);
    }
  }
  return bin;
}

// ---------------------------------------------------------------- Tesseract

async function extractConda(file, destDir) {
  const unzipper = require('unzipper');
  const tar = require('tar');
  const dir = await unzipper.Open.file(file);
  const pkg = dir.files.find((f) => /^pkg-.*\.tar\.zst$/.test(f.path));
  const info = dir.files.find((f) => /^info-.*\.tar\.zst$/.test(f.path));
  if (!pkg || !info) throw new Error(`Not a .conda package: ${file}`);
  fs.mkdirSync(destDir, { recursive: true });
  await pipeline(pkg.stream(), zlib.createZstdDecompress(), tar.x({ cwd: destDir, strict: true }));
  // info/ holds the package metadata and its licence files
  await pipeline(info.stream(), zlib.createZstdDecompress(), tar.x({ cwd: destDir, strict: true }));
}

/** Names of DLLs imported by a PE file (regular + delay-load import tables). */
export function peImports(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file}: not a PE file`);
  const pe = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(pe) !== 0x4550) throw new Error(`${file}: bad PE signature`);
  const nSections = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = b.readUInt16LE(opt);
  const dd = opt + (magic === 0x20b ? 112 : 96);
  const sections = [];
  for (let i = 0; i < nSections; i++) {
    const s = opt + optSize + i * 40;
    sections.push({ va: b.readUInt32LE(s + 12), vsize: b.readUInt32LE(s + 8), raw: b.readUInt32LE(s + 20), rsize: b.readUInt32LE(s + 16) });
  }
  const rva2off = (rva) => {
    for (const s of sections) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rsize)) return rva - s.va + s.raw;
    return -1;
  };
  const cstr = (off) => b.toString('latin1', off, b.indexOf(0, off));
  const names = new Set();
  const walk = (dirIndex, entrySize, nameOffset) => {
    const rva = b.readUInt32LE(dd + dirIndex * 8);
    if (!rva) return;
    let off = rva2off(rva);
    while (off > 0 && off + entrySize <= b.length) {
      const nameRva = b.readUInt32LE(off + nameOffset);
      if (!nameRva) break;
      const no = rva2off(nameRva);
      if (no > 0) names.add(cstr(no));
      off += entrySize;
    }
  };
  walk(1, 20, 12); // IMAGE_DIRECTORY_ENTRY_IMPORT
  walk(13, 32, 4); // IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT
  return [...names];
}

/** Copies `exe` plus the transitive closure of non-system DLLs it imports. */
function collectClosure(exe, searchDirs, outDir) {
  const index = new Map();
  for (const d of searchDirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (/\.dll$/i.test(f) && !index.has(f.toLowerCase())) index.set(f.toLowerCase(), path.join(d, f));
  }
  const needed = new Map();
  const missing = new Set();
  const queue = [exe];
  while (queue.length) {
    const cur = queue.shift();
    for (const dll of peImports(cur)) {
      const key = dll.toLowerCase();
      if (needed.has(key) || SYSTEM_DLL.test(key)) continue;
      const found = index.get(key);
      if (!found) {
        missing.add(dll);
        continue;
      }
      needed.set(key, found);
      queue.push(found);
    }
  }
  if (missing.size) throw new Error(`Unresolved DLL imports for ${path.basename(exe)}: ${[...missing].join(', ')}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(exe, path.join(outDir, path.basename(exe)));
  for (const [, src] of needed) fs.copyFileSync(src, path.join(outDir, path.basename(src)));
  return [...needed.values()].map((p) => path.basename(p)).sort();
}

async function prepareTesseract() {
  const outDir = path.join(outRoot, 'tesseract');
  if (fs.existsSync(path.join(outDir, 'tesseract.exe')) && !force) {
    log('tesseract already present (use --force to rebuild)');
    return;
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  let searchDirs;
  let exe;
  const origin = new Map();
  const stage = path.join(cacheDir, 'conda-stage');
  if (process.env.PDFED_TESSERACT_DIR) {
    exe = path.join(process.env.PDFED_TESSERACT_DIR, 'tesseract.exe');
    searchDirs = [process.env.PDFED_TESSERACT_DIR];
  } else {
    fs.rmSync(stage, { recursive: true, force: true });
    for (const pkg of TESSERACT_PACKAGES) {
      const file = await download(CONDA_BASE + pkg, path.join(cacheDir, 'conda', pkg));
      await extractConda(file, path.join(stage, pkg.replace(/\.conda$/, '')));
    }
    // Merge Library/bin of all packages (conda layout), remembering which
    // package each binary came from so only the relevant licences ship.
    const merged = path.join(stage, '_bin');
    fs.mkdirSync(merged, { recursive: true });
    for (const d of fs.readdirSync(stage)) {
      for (const sub of ['Library/bin', '.']) {
        const bin = path.join(stage, d, sub);
        if (d === '_bin' || !fs.existsSync(bin)) continue;
        for (const f of fs.readdirSync(bin)) {
          if (!/\.(dll|exe)$/i.test(f)) continue;
          fs.copyFileSync(path.join(bin, f), path.join(merged, f));
          origin.set(f.toLowerCase(), d);
        }
      }
    }
    exe = path.join(merged, 'tesseract.exe');
    searchDirs = [merged];
  }
  if (!fs.existsSync(exe)) throw new Error(`tesseract.exe not found at ${exe}`);
  const dlls = collectClosure(exe, searchDirs, outDir);
  log(`tesseract.exe + ${dlls.length} DLLs:`, dlls.join(' '));
  // Licences of exactly the packages whose binaries are shipped.
  const shippedPkgs = new Set(['tesseract.exe', ...dlls].map((f) => origin.get(f.toLowerCase())).filter(Boolean));
  for (const d of shippedPkgs) {
    const licDir = path.join(stage, d, 'info', 'licenses');
    if (!fs.existsSync(licDir)) throw new Error(`No licence files in package ${d}`);
    fs.cpSync(licDir, path.join(outDir, 'licenses', d.replace(/-[^-]+-[^-]+$/, '')), { recursive: true });
  }
  if (shippedPkgs.size) log('licences for:', [...shippedPkgs].map((d) => d.replace(/-[^-]+-[^-]+$/, '')).join(' '));
  fs.writeFileSync(
    path.join(outDir, 'README.txt'),
    'Tesseract OCR (Apache-2.0) bundled for fully offline OCR.\r\n' +
      'Language data is loaded from ..\\tessdata (eng, tha, osd).\r\n' +
      'Licences of tesseract and each bundled library are in the "licenses" folder.\r\n',
  );
}

async function main() {
  fs.mkdirSync(outRoot, { recursive: true });
  if (!args.has('--skip-python')) await preparePython();
  if (!args.has('--skip-tesseract')) await prepareTesseract();
  // AGPL-3.0: every build carries its complete corresponding source code
  const host = findHostPython();
  execFileSync(host.exe, [path.join(root, 'scripts', 'make-source-archive.py'), path.join(root, 'build', 'source')], { stdio: 'inherit' });
  for (const need of ['assets/ocr/tessdata/eng.traineddata', 'assets/ocr/tessdata/tha.traineddata', 'assets/fonts/Sarabun-Regular.ttf']) {
    if (!fs.existsSync(path.join(root, need))) throw new Error(`Missing ${need}; run: node scripts/fetch-assets.mjs --ocr`);
  }
  log('done');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e) => {
    console.error('[win-runtime] FAILED:', e.message);
    process.exit(1);
  });
}
