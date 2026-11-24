# Testing

Four layers of automated tests cover the application. All of them run fully
offline.

| Layer | Command | Scope |
|---|---|---|
| Backend unit/integration | `npm run test:backend` (pytest) | Document processing services through the real FastAPI app. Every produced PDF is checked with independent readers (pypdf, qpdf/pikepdf). |
| Frontend unit | `npm test` (vitest) | Coordinate geometry (zoom × rotation), overlay model, IPC allow-list and path-injection rejection |
| End-to-end | `npm run test:e2e` | Drives the real Electron app (Playwright `_electron`) through native-dialog automation. Output files are verified with pypdf, qpdf and MuPDF. |
| Offline end-to-end | `node tests/integration/run-e2e.mjs --offline` | The same suite inside a Linux network namespace with only a loopback interface. The renderer's attempt to `fetch()` an external URL must fail. |

Type checking: `npm run typecheck` (renderer and Electron projects).

## Fixtures

`tests/fixtures/make_fixtures.py` generates every test document
deterministically into `tests/fixtures/generated/`. The set covers a small
invoice, a 100-page and a 500-page document, an image-only scan, a Thai
document (Sarabun), password-protected and permission-restricted
(empty user password) files, embedded subset fonts, rotated pages, file
attachments, a damaged file, a non-PDF file with a `.pdf` name, and sample
images.

## Independent verification

The app's own reader (MuPDF) never judges its own output alone:

- `pypdf` extracts text and checks page count, rotation and annotations;
- `qpdf --check` (pikepdf) validates file structure and cross-reference tables;
- the ToUnicode round-trip is checked by extracting edited text again with
  pypdf, so copy/paste and search work on the output;
- redaction tests search the **raw content streams** and extracted text for
  the removed strings;
- signature tests validate with pyHanko (integrity, coverage, signer
  certificate);
- Word, Excel and PowerPoint exports are opened with python-docx, openpyxl and
  python-pptx.

## E2E coverage

#### `phase1`

- start screen is shown without documents
- renderer cannot reach the network (privacy policy)
- open a PDF and render pages
- text layer allows selecting text
- navigation, zoom and view modes
- search finds text and highlights it
- page rotate + undo/redo + delete, then Save As (independent verification)
- Ctrl+S overwrites atomically with a backup
- password protected document asks for the password
- damaged document is repaired with a warning
- 500-page document: lazy rendering and smooth navigation
- close with unsaved changes asks to save (Don’t Save)
- no renderer errors

#### `phase2`

- page organizer: multi-select and insert blank pages
- drag & drop reorder in the organizer
- copy pages from one document and paste into another
- extract pages to a new file
- split into parts of 25 pages
- merge files into a new untitled document
- create a PDF from images
- no renderer errors

#### `phase3`

- add a text box (Thai + English) and save it as real PDF text
- move the text box by dragging (PDF coordinates updated)
- format text from the properties panel (bold, size, color) with undo
- draw rectangle, ellipse and arrow; resize with a handle; rotate
- insert an image and keep it after save
- copy / paste / delete objects with the keyboard; undo restores
- flatten objects into the page (undoable)
- edit an existing image of a scanned page (move it)
- no renderer errors

#### `phase4`

- direct edit a line (preview, confirm) and save; verified with pypdf
- delete a text line
- format existing text from the properties panel (size + bold)
- move text by dragging (preview + confirm)
- undo restores the text edit
- switching Direct Edit ↔ Overlay keeps unsaved overlay objects
- Thai text edit keeps correct characters
- scanned page explains that OCR is needed
- no renderer errors

#### `phase5`

- highlight text by selecting it
- sticky note with a typed comment
- rectangle comment, then move it with the Select tool
- freehand drawing and stamp
- delete a selected comment with the Delete key, undo restores it
- comments are preserved on save (independent reader)
- flatten comments (with warning) keeps their appearance
- no renderer errors

#### `phase6`

- OCR a scanned document: review, correct, make searchable
- compress with a preset and apply the result
- convert to Word (verified with python-docx)
- password protection is applied on save
- watermark on all pages
- search & redact e-mail addresses with verification
- fill & sign: draw and place a signature
- create a Digital ID, sign digitally and validate
- no renderer errors

#### `recovery`

- crash recovery restores unsaved work

#### `forms`

- a form is announced and its fields are fillable
- fill text (Thai), check box, dropdown and multi-line text; undo the last entry
- filled values are saved (independent reader)
- design: add a text field, rename it and move it
- design: build a radio group by clicking twice
- fill the new fields, then flatten the form
- no renderer errors

#### `marks`

- add Thai page numbers with Thai digits from the dialog (preview shown)
- Bates numbers replace the page numbers and are saved
- batch: password-protect several files; a protected file is reported, originals untouched
- compare the numbered copy with the original file
- no renderer errors

#### `i18n`

- Thai interface on start (menus, ribbon, status bar)
- switching language in Preferences updates the UI immediately
- no renderer errors

## Requirement-to-test map

| Requirement area | Covered by |
|---|---|
| Open/view, navigation, zoom, search, 500 pages, corrupted, password | `phase1`, `test_documents.py` |
| Save / Save As / atomic overwrite / backups / encryption preserved | `phase1`, `phase6`, `test_documents.py` |
| Page management (insert, delete, rotate, reorder, extract, split, merge, copy between documents, images → PDF, crop, resize) | `phase2`, `test_pages.py` |
| Overlay editing (text, images, shapes, links, transform, flatten) | `phase3`, `test_overlays.py` |
| Direct text editing (preview, fonts, Thai, delete, move, undo, scanned page) | `phase4`, `test_direct_text.py`, `test_text_layout.py` |
| Annotations (markup, notes, shapes, freehand, stamp, flatten) | `phase5`, `test_annotations.py` |
| OCR (Thai + English, searchable output) | `phase6`, `test_advanced.py` |
| Compression presets and no-growth guarantee | `phase6`, `test_advanced.py` |
| Conversion (Word/Excel/PowerPoint/images/text) | `phase6`, `test_advanced.py` |
| Security (passwords, permissions, watermark, true redaction, sanitize) | `phase6`, `test_advanced.py`, `test_documents.py` |
| Signatures (electronic, digital, validation) | `phase6`, `test_advanced.py` |
| Undo/redo | all E2E phases, `test_documents.py` |
| Crash recovery and autosave | `recovery` |
| IPC security (allow-list, no raw paths) | `tests/electron/ipc-ops.test.ts` |
| Offline operation and network lockdown | `--offline` run, `phase1` privacy check |
| Thai / English interface (catalogue completeness, live switching) | `tests/electron/i18n.test.ts`, `i18n` |
| Forms: fill (Thai), create, edit, delete, reset, flatten, sign a field, permissions | `test_forms.py`, `forms` |
| Header & footer, page numbers, Bates, rotated pages, replace/remove | `test_header_footer.py`, `marks` |
| Batch processing (originals untouched, no overwrite, errors per file) | `test_batch.py`, `marks` |
| Compare documents (word level, Thai) | `test_compare.py`, `marks` |

## Running the E2E suite

Requirements on Linux: `xvfb-run` and Python with the backend venv. For the
offline mode, also `unshare` (util-linux) and permission to create
namespaces.

```bash
npm run build
node tests/integration/run-e2e.mjs                 # all suites
node tests/integration/run-e2e.mjs --only=phase4   # a single suite
node tests/integration/run-e2e.mjs --offline       # all suites, no network
```

The harness sets `PDFED_E2E_DIALOG_DIR`, `PDFED_E2E_OPEN` and
`PDFED_E2E_ANSWERS` to automate native dialogs. Packaged builds ignore these
variables (`app.isPackaged`), so they can't be used to bypass the file-token
model in production.

## Manual checks on Windows (release checklist)

The cloud CI used during development runs Linux. Run these on a clean
Windows 10 and Windows 11 machine before each release:

1. Install with the NSIS installer as a standard user. Start it from the Start
   menu, with no Python, Tesseract or VC++ Redistributable installed.
2. Open a PDF by double-click / *Open with*, and by drag-and-drop.
3. OCR a Thai + English scan (checks the bundled `tesseract.exe` and tessdata).
4. Direct-edit Thai text, save, and reopen in another PDF reader.
5. Convert to Word and open it in Word.
6. Sign digitally, then validate in another reader.
7. Disconnect the network and repeat steps 2–4.
8. Run the portable executable from a USB drive.
9. Uninstall and confirm `%APPDATA%\Offline PDF Editor` is preserved.
