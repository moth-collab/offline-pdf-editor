# User Guide

## Interface language

The interface is available in **Thai** and **English**. On first start it
follows the Windows display language. You can change it any time in
**Preferences › General › Language**; the change applies immediately and
does not affect open documents.

## Opening documents

- **File › Open** (`Ctrl+O`), drag-and-drop onto the window, double-clicking a
  PDF associated with the app, or the **Recent** list on the start screen.
- Several documents open as tabs. Use the left panel for thumbnails, bookmarks,
  attachments, comments and layers (`F4` toggles it).
- Password-protected files ask for the password. With the *owner* password you
  get full rights. With only the *user* password, the document's permission
  restrictions apply. The original protection is kept when you save.
- A damaged file is repaired automatically if possible, with a warning.

## Two editing modes

| Mode | Use it for | Result |
|---|---|---|
| **Edit Text** (direct) | Changing text that is already in the PDF | The text in the page content is replaced. The original font is reused when it has the glyphs; otherwise you are warned and a matching substitute is shown in the preview. |
| **Add Text / Edit Objects** (overlay) | Adding new text boxes, images, shapes and links | The additions stay movable objects until you save or flatten them. |

Switching modes never discards unsaved objects.

### Editing existing text

1. Choose **Edit Text** and double-click a line or paragraph.
2. Type your change. Use the properties panel (`Ctrl+E`) for font, size,
   colour and bold/italic.
3. Click **Apply**. A preview shows the page exactly as it will look,
   including any font-substitution warnings. Confirm to apply.
4. Undo (`Ctrl+Z`) restores the previous text.

Thai text is shaped correctly (vowels, tone marks) and wrapped on word
boundaries. On scanned pages (images only) the app explains that you must run
OCR first.

## Pages

**Organize Pages** (`Ctrl+Shift+O`) gives you a grid where you can drag to
reorder, multi-select with `Ctrl`/`Shift`, rotate, delete, duplicate, insert
blank pages or other files, extract, copy pages between open documents,
reverse, crop and resize. Merging and splitting are under **File** and
**Pages**.

## Comments and markup

The **Comment** tab has highlight, underline, strike-through, squiggly, sticky
notes, text comments, freehand, rectangle, ellipse, line, arrow, callout and
stamps. Comments stay standard PDF annotations, so other readers can show and
edit them. **Flatten** merges them permanently into the page (you are warned
first).

## Forms

When a document contains a form, a notice appears and the fields are
highlighted (**Forms › Highlight Fields** toggles this).

- **Fill in**: with the Select or Hand tool, type into text fields, tick check
  boxes, choose radio buttons and pick from lists. Each entry is one undo
  step. Thai text is displayed correctly in every PDF reader, because the
  app draws the field appearance itself with an embedded font.
- **Sign a signature field**: click an empty signature field to sign it with
  your Digital ID.
- **Create fields**: **Forms › Text / Check Box / Radio Button / Dropdown /
  List Box / Signature**, then drag on the page (or click for a default
  size). For a radio group, keep the first button selected and click again
  with the Radio Button tool to add more choices.
- **Edit fields**: **Forms › Edit Fields** lets you select, move, resize and
  delete (`Delete`) fields. The properties panel sets the name, tooltip,
  required, read-only, multiple lines, password, maximum length, boxes for
  each character, font size, alignment, and the options of lists.
- **Reset Form** clears all entries. **Flatten Form** turns the fields into
  normal page content so they can no longer be changed.

Hybrid XFA forms are filled through their AcroForm part. The XFA part is
removed when you fill them in, so other readers show the same values.

## Page numbers, headers, footers and Bates numbers

**Organize › Page Numbers / Header & Footer / Bates** opens one dialog with
six positions (top or bottom; left, center or right). Insert the tokens
*Page number*, *Last page number*, *Date*, *File name* and *Bates number*
into the text. You can choose the font, size, colour, margins, a page range,
the starting number, the date format (including Thai dates such as
23 พฤศจิกายน 2569) and Thai digits (๑ ๒ ๓). A preview shows the first page.
Applying again replaces the previous header and footer.
**Remove** takes them away again. Text is placed at the visible top and
bottom even on rotated pages.

## Batch processing (many files)

**Convert › Batch** (or **Tools › Batch Processing…**): add files, choose an
output folder and one action: compress, OCR scanned pages, page or Bates
numbers (continuing across all files), watermark, password protection,
removing hidden information, flattening forms and comments, or conversion to
Word. Results are saved as new files (for example `report_compressed.pdf`).
Originals are never changed, and existing files are never overwritten.
Files that cannot be processed, such as password-protected ones, are listed
with the reason and do not stop the batch.

## Compare documents

**Convert › Compare** (or **Tools › Compare Documents…**): choose the older
and the newer version, either open documents or files. Text is compared word
by word, with Thai split into words by dictionary. The result opens as a new
side-by-side document: removed text is red on the left, new text green on the
right. A list of all changes appears in the dialog; click a change to jump to
its page.

## Scans and OCR

**Tools › Recognize Text (OCR)** runs on the current page or all pages, in
English, Thai or both. You can review low-confidence words before applying.
The result is a searchable PDF: an invisible text layer under the original
image.

## Protect, redact, sign

- **Protect**: open password, permissions (printing, copying, editing) with
  AES-256, watermarks, and removing protection (requires the password).
- **Redact**: mark areas or search for text and patterns (e-mail, phone, Thai
  ID, credit card, dates), then **Apply**. Redaction removes the underlying
  text, images and vector graphics, and is checked afterwards. **Sanitize**
  removes metadata, scripts, attachments and hidden data.
- **Fill & Sign**: draw, type or import a signature image and place it.
- **Digital signature**: create a self-signed Digital ID (`.pfx`) or use your
  own, then sign (PAdES). **Validate** checks integrity and coverage offline.

## Convert and compress

- **Export**: Word, Excel, PowerPoint, PNG/JPG per page, text, and extracting
  images.
- **Create**: a PDF from images.
- **Compress**: *Low*, *Recommended* or *High* presets, with the estimated
  result size. The compressed copy is applied or saved as a new file only
  after you confirm, and a result that would be larger is never used.

## Saving and safety

- **Save** (`Ctrl+S`) overwrites the original safely: the app writes a new
  file, validates it, keeps a backup of the old one, and only then replaces it.
- **Save As** (`Ctrl+Shift+S`) writes a new file and leaves the original alone.
- Undo/redo covers every operation, including page changes, OCR and
  redaction (until you save and close).
- Autosave keeps a recovery copy. After a crash or power loss, the next start
  offers to restore unsaved work.

## Preferences (`Ctrl+K`)

General (theme, recent files, default folder), Editing (default font and
size, author name, default tool), Performance (render quality, cache size,
undo depth), Privacy (temp cleanup, recovery retention, link confirmation,
clearing recent files), OCR (default languages and resolution).

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+-` | Zoom Out |
| `Ctrl+0` | Actual Size |
| `Ctrl+1` | Fit Page |
| `Ctrl+2` | Fit Width |
| `Ctrl+=` | Zoom In |
| `Ctrl+C` | Copy |
| `Ctrl+E` | Properties Panel |
| `Ctrl+F` | Find… |
| `Ctrl+G` | Go to Page… |
| `Ctrl+K` | Preferences… |
| `Ctrl+O` | Open… |
| `Ctrl+S` | Save |
| `Ctrl+Shift+-` | Rotate Left |
| `Ctrl+Shift+=` | Rotate Right |
| `Ctrl+Shift+D` | Delete Pages… |
| `Ctrl+Shift+O` | Organize Pages |
| `Ctrl+Shift+S` | Save As… |
| `Ctrl+Shift+[` | Send to Back |
| `Ctrl+Shift+]` | Bring to Front |
| `Ctrl+W` | Close |
| `Ctrl+X` | Cut |
| `Ctrl+Y` | Redo |
| `Ctrl+Z` | Undo |
| `Ctrl+[` | Send Backward |
| `Ctrl+]` | Bring Forward |
| `Delete / Backspace` | Delete |
| `End` | Last Page |
| `F4` | Navigation Panel |
| `H` | Hand Tool |
| `Home` | First Page |
| `PageDown` | Next Page |
| `PageUp` | Previous Page |
| `V` | Select |
| `Ctrl+D` | Duplicate selected objects; with nothing selected, Document Properties |
| `Ctrl+P` | Print |
| Arrow keys | Nudge selected objects (`Shift` = 10 pt) |
| `Ctrl+V` | Paste copied objects; an image on the system clipboard is inserted as an image object |
| `Ctrl+A` | Select all objects on the page |
| `Ctrl+B` | Add bookmark |
| `Escape` | Cancel the current tool / selection |
