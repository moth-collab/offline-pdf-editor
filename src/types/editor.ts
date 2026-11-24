/* Editor data model. All geometry is expressed in PDF user space (points,
 * origin bottom-left, y up, unrotated page). `rect` = [x0, y0, x1, y1] is the
 * object's box before its own rotation; `rotation` is clockwise degrees as seen
 * on the unrotated page, about the box centre. */

export type Rect = [number, number, number, number];
export type Point = [number, number];

export type OverlayKind = 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'link';

interface OverlayBase {
  id: string;
  kind: OverlayKind;
  page: number;
  rect: Rect;
  rotation: number;
  opacity: number;
  locked?: boolean;
}

export interface TextOverlay extends OverlayBase {
  kind: 'text';
  text: string;
  font: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  align: 'left' | 'center' | 'right' | 'justify';
  lineHeight: number;
  charSpacing: number;
  background: string | null;
  borderColor: string | null;
  borderWidth: number;
  padding: number;
}

export interface ImageOverlay extends OverlayBase {
  kind: 'image';
  assetId: string;
  naturalWidth: number;
  naturalHeight: number;
  /** fractions removed from left, top, right, bottom */
  crop: [number, number, number, number];
  flipH: boolean;
  flipV: boolean;
  borderColor: string | null;
  borderWidth: number;
}

export interface ShapeOverlay extends OverlayBase {
  kind: 'rect' | 'ellipse';
  stroke: string | null;
  strokeWidth: number;
  fill: string | null;
  fillOpacity: number;
  dash: number[] | null;
}

export interface LineOverlay extends OverlayBase {
  kind: 'line' | 'arrow';
  /** endpoints in PDF space; rect is their bounding box */
  points: [Point, Point];
  stroke: string;
  strokeWidth: number;
  dash: number[] | null;
}

export interface LinkOverlay extends OverlayBase {
  kind: 'link';
  target: { type: 'url'; url: string } | { type: 'page'; page: number };
}

export type OverlayObject = TextOverlay | ImageOverlay | ShapeOverlay | LineOverlay | LinkOverlay;

export type ToolId =
  | 'select'
  | 'hand'
  | 'direct-text'
  | 'add-text'
  | 'add-image'
  | 'edit-images'
  | 'shape-rect'
  | 'shape-ellipse'
  | 'shape-line'
  | 'shape-arrow'
  | 'add-link'
  | 'edit-objects'
  | 'annot-highlight'
  | 'annot-underline'
  | 'annot-strikeout'
  | 'annot-squiggly'
  | 'annot-note'
  | 'annot-freetext'
  | 'annot-callout'
  | 'annot-ink'
  | 'annot-rect'
  | 'annot-circle'
  | 'annot-line'
  | 'annot-arrow'
  | 'annot-stamp'
  | 'redact-area'
  | 'signature'
  | 'zoom-area'
  | 'form-edit'
  | 'form-text'
  | 'form-checkbox'
  | 'form-radio'
  | 'form-combo'
  | 'form-list'
  | 'form-signature';

export type ViewMode = 'continuous' | 'single' | 'two-page';
export type ZoomMode = 'custom' | 'fit-width' | 'fit-page';

export interface Selection {
  kind: 'none' | 'overlay' | 'annotation' | 'text' | 'form';
  ids: string[];
  page?: number;
  /** form selection: the field the selected widget belongs to */
  field?: string;
}

export interface Snapshot {
  revision: number;
  overlays: OverlayObject[];
  /** content ids per page (thumbnail/render cache keys) */
  pageVersions: number[];
}

export interface HistoryEntry {
  label: string;
  before: Snapshot;
  after: Snapshot;
  ts: number;
}

export interface SearchHit {
  page: number;
  rect: Rect;
  quad: number[][];
  context: string;
}

export const MODE_LABELS: Partial<Record<ToolId, string>> = {
  select: 'Select',
  hand: 'Hand',
  'direct-text': 'Direct Edit',
  'add-text': 'Add Text / Overlay',
  'add-image': 'Add Image',
  'edit-images': 'Edit Images',
  'shape-rect': 'Rectangle',
  'shape-ellipse': 'Ellipse',
  'shape-line': 'Line',
  'shape-arrow': 'Arrow',
  'add-link': 'Add Link',
  'edit-objects': 'Edit Objects',
  'annot-highlight': 'Highlight',
  'annot-underline': 'Underline',
  'annot-strikeout': 'Strikethrough',
  'annot-squiggly': 'Squiggly',
  'annot-note': 'Sticky Note',
  'annot-freetext': 'Text Comment',
  'annot-callout': 'Callout',
  'annot-ink': 'Drawing',
  'annot-rect': 'Rectangle Comment',
  'annot-circle': 'Circle Comment',
  'annot-line': 'Line Comment',
  'annot-arrow': 'Arrow Comment',
  'annot-stamp': 'Stamp',
  'redact-area': 'Mark for Redaction',
  signature: 'Place Signature',
  'zoom-area': 'Zoom',
  'form-edit': 'Edit Form Fields',
  'form-text': 'Text Field',
  'form-checkbox': 'Check Box',
  'form-radio': 'Radio Button',
  'form-combo': 'Dropdown List',
  'form-list': 'List Box',
  'form-signature': 'Signature Field',
};
