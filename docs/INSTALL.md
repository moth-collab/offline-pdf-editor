# Installation

## End users (Windows 10/11, 64-bit)

You need nothing else installed. Python, Tesseract OCR, the OCR language data
(English and Thai) and all fonts are bundled.

### Installer (recommended)

1. Run `OfflinePDFEditor-<version>-setup-x64.exe`.
2. Choose *Only for me* (no administrator rights needed) or *Anyone who uses
   this computer*, then pick the installation folder.
3. Start **Offline PDF Editor** from the Start menu or the desktop shortcut.

During installation, `.pdf` is registered as a file type the editor can open
("Open with" menu). It does not take over the default PDF viewer unless you
choose it in Windows Settings › Default apps.

**Uninstalling.** Use Windows Settings › Apps. Your settings, recovery data and
backups in `%APPDATA%\Offline PDF Editor` are kept. Delete that folder to
remove them.

### Portable

Run `OfflinePDFEditor-<version>-portable-x64.exe` from any folder, including a USB
stick. It unpacks to a temporary folder on each start, so it starts more
slowly than the installed version. Settings are still stored in
`%APPDATA%\Offline PDF Editor`.

### SmartScreen / antivirus

Unsigned builds show a Windows SmartScreen warning ("Windows protected your
PC"). Choose *More info › Run anyway*, or code-sign the release (see below).
The app needs no network access, so you can block it in Windows Firewall
without losing any functionality.

### System requirements

- Windows 10 (1809 or later) or Windows 11, x64
- 4 GB RAM (8 GB recommended for large scanned documents and OCR)
- About 900 MB of disk space installed, plus room for working copies of open
  documents

---

## Building from source

### Prerequisites (build machine only)

- Node.js 22 or later and npm
- Python 3.13 with `pip`. It is only used to fetch the Windows wheels and to
  run the backend during development.
- Internet access **for the build only**. Packages come from npm, PyPI,
  nuget.org (CPython), conda.anaconda.org (Tesseract) and the font
  repositories.

### Development setup

```bash
npm ci
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements-dev.txt     # Windows: backend\.venv\Scripts\pip
node scripts/fetch-assets.mjs --ocr     # fonts + licences, eng/tha/osd tessdata
npm run dev                              # Vite + Electron with hot reload
```

In development the backend uses `backend/.venv`. OCR uses a Tesseract binary
on `PATH` (for example `apt install tesseract-ocr`, or the UB-Mannheim build on
Windows) together with the bundled tessdata.

### Windows installer and portable build

On a Windows build machine (recommended):

```bash
npm run dist:win
```

This runs three steps:

1. `npm run build`: Vite renderer build and esbuild main/preload bundles.
2. `node scripts/prepare-win-runtime.mjs`, which creates `build/win-runtime/`:
   - CPython 3.13.9 x64 from the official nuget.org `python` package (sha256
     pinned), its standard library trimmed, and module search paths locked
     with a `python313._pth` file;
   - the pinned wheels from `backend/requirements.txt` (`win_amd64`, binary
     only), precompiled to bytecode;
   - the MSVC runtime DLLs placed next to `python.exe`, so no VC++
     Redistributable is needed;
   - Tesseract 5.5.4 plus exactly the DLLs it imports, found by walking PE
     import tables, with the licence of each bundled library;
   - a check that every `.exe`, `.dll` and `.pyd` resolves all its imports
     either inside the bundle or from Windows itself. The build fails
     otherwise.
3. `electron-builder --win --x64`, which creates `release/` containing the NSIS
   installer and the portable executable.

Overrides: `PDFED_TESSERACT_DIR=<folder with tesseract.exe + DLLs>` uses an
existing Tesseract installation. `PDFED_PYTHON_NUPKG=<file>` uses a local
CPython package. `PDFED_HOST_PYTHON=<python>` sets the Python used to run pip.

Cross-building from Linux also works (`npm run dist:win`). electron-builder
then downloads NSIS and its Windows tooling from GitHub on first use.

### Automatic builds on GitHub (no Windows machine needed)

`.github/workflows/build.yml` runs on GitHub Actions. It runs the tests on
Linux, builds the installer and the portable app on a Windows runner, and
smoke-tests the bundled runtime there (`scripts/smoke-test-runtime.py`:
backend start-up, Thai/English OCR with the bundled Tesseract, a Thai form,
page numbers, compression, saving). The files are available as the run's
artifact. Pushing a version tag publishes them as a GitHub Release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

### Code signing (recommended for distribution)

Set `CSC_LINK` (path to a `.pfx`) and `CSC_KEY_PASSWORD` before
`npm run dist:win`. electron-builder signs the executable, the installer and
the uninstaller.

### Licence when distributing

The application is licensed under **AGPL-3.0-or-later**. `npm run dist:win`
automatically puts the complete source code into every build
(`resources/source/`), which satisfies the AGPL requirement to provide source
code to everyone who receives the program. If you change the program and
distribute it, keep it under the AGPL and rebuild, so the bundled source
matches your version. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
