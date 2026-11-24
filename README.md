# Offline PDF Editor

A desktop PDF editor for Windows 10/11 (x64) that works **completely
offline**. Documents never leave your computer. There is no telemetry, no
account and no cloud processing.

[![Build](https://github.com/moth-collab/offline-pdf-editor/actions/workflows/build.yml/badge.svg)](https://github.com/moth-collab/offline-pdf-editor/actions/workflows/build.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

## Download

Get the latest Windows installer or portable version from the
**[Releases page](https://github.com/moth-collab/offline-pdf-editor/releases/latest)**:

- `OfflinePDFEditor-<version>-setup-x64.exe`: installer (no administrator rights needed)
- `OfflinePDFEditor-<version>-portable-x64.exe`: runs without installation.
  It unpacks itself (about 600 MB) at every start, so it starts more slowly
  than the installed version. Use the installer for daily use.

Windows 10/11 64-bit. Nothing else needs to be installed, and no internet
connection is needed. Builds are not code-signed yet, so Windows SmartScreen
may ask for confirmation (*More info › Run anyway*).

## Features

- **View**: fast PDF.js rendering with lazy loading (tested with 500 pages),
  search, bookmarks, attachments, layers, zoom/fit, rotation, password-protected
  and damaged files.
- **Direct text editing**: change existing text in place. The original
  embedded font is reused when possible, and substitutes are metric-compatible
  with warnings. Thai and Latin text are shaped by HarfBuzz. Every edit is
  previewed before it is applied, and no white boxes are drawn.
- **Overlay editing**: text boxes, images, shapes, arrows and links that stay
  movable and resizable until saved or flattened.
- **Pages**: organize (drag-and-drop), insert, delete, duplicate, rotate,
  reorder, move or copy between documents, reverse, crop, resize, blank pages,
  merge, split, extract, images → PDF.
- **Comments**: highlight, underline, strike-through, squiggly, notes, text
  comments, freehand, rectangle, ellipse, line, arrow, callout, stamps, and
  flatten.
- **OCR**: bundled Tesseract with English and Thai, per page or whole
  document, confidence review, searchable PDF output.
- **Security**: AES-256 passwords and permissions, watermarks, true redaction
  with verification, sanitizing, electronic and digital (PAdES) signatures,
  and offline signature validation.
- **Conversion**: Word, Excel, PowerPoint, PNG/JPG, text, image extraction,
  and printing.
- **Compression**: Low / Recommended / High presets with size estimates. The
  original is never replaced without confirmation.
- **Forms**: fill in forms (including forms made with other tools), create
  text, check box, radio, dropdown, list and signature fields, reset, and
  flatten. Field appearances are drawn with the app's own text engine, so Thai
  entries display correctly in every PDF reader.
- **Page numbers, headers and footers, Bates numbering**: six positions,
  page/date/file-name tokens, Thai dates (Buddhist era) and Thai digits.
  Works correctly on rotated pages.
- **Batch processing**: compress, OCR, number, watermark, password-protect,
  clean, flatten or convert many files in one go. Bates numbers continue
  across files, and the originals are never changed.
- **Compare documents**: word-level comparison (Thai aware) that produces a
  side-by-side PDF with the changes highlighted and a clickable change list.
- **Thai and English interface**: on first start the language follows
  Windows; switch it any time in Preferences.
- **Safety**: command-based undo/redo, atomic saves with backups, autosave and
  crash recovery, and a validated revision after every operation.

## Documentation

| Document | Contents |
|---|---|
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | How to use the app, keyboard shortcuts |
| [docs/INSTALL.md](docs/INSTALL.md) | Installing, building the Windows installer from source |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Privacy architecture, every place data is stored |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Processes, IPC contract, document model, text engine |
| [docs/TESTING.md](docs/TESTING.md) | Test layers, fixtures, requirement-to-test map, release checklist |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Phase-by-phase implementation reports and known limitations |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Bundled components and licences (**PyMuPDF is AGPL-3.0**) |

## Quick start (development)

```bash
npm ci
python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements-dev.txt
node scripts/fetch-assets.mjs --ocr
npm run dev
```

Build the Windows installer and portable executable:

```bash
npm run dist:win
```

## Tests

```bash
npm run typecheck
npm test
npm run test:backend
npm run build && npm run test:e2e
```

To run the end-to-end suite without network access:

```bash
node tests/integration/run-e2e.mjs --offline
```

## Technology

Electron · React · TypeScript · Vite · Tailwind CSS · Radix/shadcn-style UI ·
Lucide · Zustand · dnd-kit · PDF.js. The local backend is Python 3.13 with
FastAPI, Pydantic, PyMuPDF, pikepdf, pypdf, Pillow, fontTools, uharfbuzz,
pyHanko, python-docx/openpyxl/python-pptx and pdf2docx, plus Tesseract OCR.

## Licence

Offline PDF Editor is **free and open-source software**, licensed under the
**GNU Affero General Public License v3.0 or later** (`AGPL-3.0-or-later`).
See [LICENSE](LICENSE).

You may use it for any purpose (including commercially), study and change
it, and share it. If you distribute it, or a modified version, you must pass
on the same freedoms: license it under the AGPL and provide the complete
source code. Every build already does this, because the installer and the
portable version contain the complete source code
(`resources/source/offline-pdf-editor-<version>-source.zip`, also reachable
through *Help › About › Source code & licence*).

Bundled third-party components keep their own licences, all compatible with
the AGPL. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

```
Copyright (C) 2026 Offline PDF Editor contributors

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
details.
```
