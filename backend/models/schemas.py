"""Pydantic request models shared by the API routes."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class OpenRequest(BaseModel):
    path: str
    password: str | None = None


class RestoreRequest(BaseModel):
    session_id: str


class CloseRequest(BaseModel):
    delete_session: bool = True


class RevisionRequest(BaseModel):
    revision: int


class SaveRequest(BaseModel):
    target_path: str
    overlays: list[dict[str, Any]] = Field(default_factory=list)
    make_backup: bool = True


class UiStateRequest(BaseModel):
    state: dict[str, Any]


class BaseRevModel(BaseModel):
    base_revision: int | None = None


class PagesRequest(BaseRevModel):
    pages: list[int]


class RotateRequest(BaseRevModel):
    pages: list[int]
    angle: int  # +90 / -90 / 180


class ReorderRequest(BaseRevModel):
    order: list[int]  # new order expressed as old indices


class MovePagesRequest(BaseRevModel):
    pages: list[int]
    to: int  # insertion index in the *remaining* sequence


class InsertBlankRequest(BaseRevModel):
    at: int
    count: int = 1
    width: float | None = None
    height: float | None = None


class InsertFileRequest(BaseRevModel):
    at: int
    path: str
    password: str | None = None
    pages: list[int] | None = None


class InsertImagesRequest(BaseRevModel):
    at: int
    paths: list[str]
    # "match": the size of the neighbouring page of this document
    page_size: Literal["image", "a4", "letter", "match"] = "match"
    margin: float = 0


class CopyPagesRequest(BaseRevModel):
    source_doc_id: str
    pages: list[int]
    at: int


class CropRequest(BaseRevModel):
    pages: list[int]
    box: list[float] | None = None  # pdf coords [x0,y0,x1,y1]
    margins: list[float] | None = None  # left, bottom, right, top (pt) relative to current crop box
    reset: bool = False


class ResizeRequest(BaseRevModel):
    pages: list[int]
    width: float
    height: float
    mode: Literal["fit", "stretch", "center"] = "fit"


class ExtractRequest(BaseModel):
    pages: list[int]
    target_path: str


class SplitRequest(BaseModel):
    mode: Literal["ranges", "every", "bookmarks", "size"]
    ranges: list[list[int]] | None = None  # [[start,end], ...] inclusive 0-based
    every: int | None = None
    max_bytes: int | None = None
    output_dir: str
    name_pattern: str = "{name}_part{n}"


class MergeItem(BaseModel):
    path: str
    password: str | None = None
    pages: list[int] | None = None


class MergeRequest(BaseModel):
    items: list[MergeItem]
    display_name: str = "Merged.pdf"


class ImagesToPdfRequest(BaseModel):
    paths: list[str]
    page_size: Literal["image", "a4", "letter"] = "image"
    margin: float = 0
    display_name: str = "Images.pdf"


class SearchRequest(BaseModel):
    query: str
    case_sensitive: bool = False
    whole_word: bool = False
    max_results: int = 2000


class OutlineRequest(BaseRevModel):
    toc: list[list[Any]]


class AttachmentAddRequest(BaseRevModel):
    path: str
    description: str | None = None


class AttachmentNameRequest(BaseRevModel):
    name: str


class AttachmentExtractRequest(BaseModel):
    name: str
    target_path: str


class AssetImageRequest(BaseModel):
    path: str | None = None
    data_base64: str | None = None


class FlattenOverlaysRequest(BaseRevModel):
    overlays: list[dict[str, Any]]
